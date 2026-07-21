import type { SupabaseClient } from "@supabase/supabase-js";
import {
  formatKnownFacts,
  mergeIcpExtracted,
  type ExtractedMemory,
} from "@/lib/crm/icp";
import { loadPriorExtractions } from "@/lib/crm/prior-extraction";
import {
  isDraftableIntent,
  resolveReplyIntent,
  type ReplyIntentResult,
} from "@/lib/draft/intent";
import { EVENT_BRIEF, formatStatedBudget } from "@/lib/event-brief";
import { stripQuotedHistory } from "@/lib/email/strip-quotes";
import type { TriageResult } from "@/lib/triage/schema";
import { triageResultSchema } from "@/lib/triage/schema";
import {
  fetchUnipileEmail,
  fetchUnipileThreadEmails,
} from "@/lib/unipile/send";

export type DraftContext = {
  venueId: string;
  messageId: string;
  threadId: string;
  venueName: string;
  hubspotContactId: string | null;
  senderEmail: string;
  subject: string;
  replyToMessageId: string;
  sentFromAddress: string | null;
  /** Triage with merged ICP extract (thread memory). */
  triage: TriageResult;
  intentResult: ReplyIntentResult;
  recentThread: string;
  knownFacts: string;
  eventBriefText: string;
  playbook: string;
};

const PER_MESSAGE_CHARS = 800;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function senderIdentifier(email: Record<string, unknown>): string {
  const from = email.from_attendee;
  if (from && typeof from === "object") {
    const id = (from as { identifier?: string }).identifier;
    if (typeof id === "string") return id.toLowerCase().trim();
  }
  const fromEmail = email.from;
  if (typeof fromEmail === "string") return fromEmail.toLowerCase().trim();
  return "";
}

/**
 * Format last N thread messages oldest→newest for the draft prompt.
 * Pure helper for tests + loadDraftContext.
 */
export function formatThreadMessagesForDraft(
  messagesNewestFirst: Record<string, unknown>[],
  opts: { ourAddresses: string[]; maxPerMessage?: number },
): string {
  const max = opts.maxPerMessage ?? PER_MESSAGE_CHARS;
  const ours = new Set(
    opts.ourAddresses.map((a) => a.toLowerCase().trim()).filter(Boolean),
  );

  const chronological = [...messagesNewestFirst].reverse();
  const blocks: string[] = [];

  for (const msg of chronological) {
    const from = senderIdentifier(msg);
    const role = from && ours.has(from) ? "Us" : "Venue";
    const subject = asString(msg.subject) || "(no subject)";
    const body = stripQuotedHistory(
      asString(msg.body_plain) || asString(msg.body),
    ).slice(0, max);
    blocks.push(`[${role}] subject: ${subject}\n${body || "(empty)"}`);
  }

  return blocks.length ? blocks.join("\n\n---\n\n") : "";
}

function buildPlaybook(intentResult: ReplyIntentResult): string {
  const budget = formatStatedBudget();
  const alts = EVENT_BRIEF.alternateDateWindows.join("; ");

  switch (intentResult.intent) {
    case "ask_missing":
      return [
        "Intent: ask_missing.",
        `Ask ONLY for these missing fields: ${intentResult.missing.join(", ") || "(none)"}.`,
        "Do not re-ask facts already listed under Known facts.",
        "Keep the ask short and specific.",
      ].join("\n");
    case "negotiate":
      return [
        "Intent: negotiate.",
        `Our stated budget in outreach is ~${budget} min spend.`,
        `ICP hard ceiling is $${EVENT_BRIEF.icpMaxSpendUsd} — do not accept above that.`,
        "Respond to the LATEST commercial move in the thread (e.g. price tied to a different date).",
        intentResult.dateConflict
          ? `Date conflict: primary ${EVENT_BRIEF.primaryDateLabel} may not work. Offer alternatives: ${alts}. Ask whether their offered price still applies on our dates.`
          : "Primary date still preferred unless they offered other dates.",
        `If their min spend is above ${budget} but ≤ $${EVENT_BRIEF.icpMaxSpendUsd}, ask whether they can work toward ~${budget} (food + beer/wine tab).`,
        "Never invent discounts, comps, or terms not in the event brief.",
        "Do not re-ask privacy, capacity, or spend already listed under Known facts.",
      ].join("\n");
    case "confirm_fit":
      return [
        "Intent: confirm_fit.",
        "Confirm we are a good fit on privacy, capacity, and spend.",
        "Ask for formal proposal / deposit terms / AV confirmation as a clear next step.",
        "Do not negotiate price unless they raise a new constraint.",
        "Do not re-ask facts already listed under Known facts.",
      ].join("\n");
    default:
      return "Intent: none — do not draft.";
  }
}

function buildEventBriefText(): string {
  return [
    `Primary date: ${EVENT_BRIEF.primaryDateLabel}`,
    `Guests: ${EVENT_BRIEF.guestCountLabel} standing`,
    `Privacy: fully private required`,
    `Stated budget: ~${formatStatedBudget()} min spend (food ~$${EVENT_BRIEF.foodBudgetUsd}, bar ~$${EVENT_BRIEF.barTabUsd})`,
    `ICP max spend: $${EVENT_BRIEF.icpMaxSpendUsd}`,
    `Alternate dates: ${EVENT_BRIEF.alternateDateWindows.join("; ")}`,
    `Sign as: ${EVENT_BRIEF.signerName}`,
  ].join("\n");
}

/**
 * Assemble drafting context from ledger + Unipile. Payload in is only {venue_id, message_id}.
 */
export async function loadDraftContext(
  supabase: SupabaseClient,
  opts: { venueId: string; messageId: string },
): Promise<DraftContext> {
  const { venueId, messageId } = opts;

  const { data: inbound, error: inboundErr } = await supabase
    .from("inbound_messages")
    .select(
      "message_id, thread_id, venue_id, sender_email, classification, extraction, confidence, needs_human_review, reply_required",
    )
    .eq("message_id", messageId)
    .maybeSingle();

  if (inboundErr) throw new Error(inboundErr.message);
  if (!inbound) throw new Error("inbound_message_not_found");
  if (inbound.venue_id !== venueId) {
    throw new Error("venue_id_mismatch");
  }

  const currentTriage = triageResultSchema.parse({
    thread_id: inbound.thread_id,
    classification: inbound.classification,
    extracted: inbound.extraction ?? {},
    confidence: inbound.confidence ?? 0,
    needs_human_review: inbound.needs_human_review ?? false,
    reply_required: inbound.reply_required ?? false,
  });

  let prior: ExtractedMemory = {};
  try {
    prior = await loadPriorExtractions(supabase, {
      venueId,
      threadId: inbound.thread_id,
      excludeMessageId: messageId,
    });
  } catch {
    prior = {};
  }

  const mergedExtracted = mergeIcpExtracted(prior, currentTriage.extracted);
  const triage: TriageResult = {
    ...currentTriage,
    extracted: {
      ...currentTriage.extracted,
      ...mergedExtracted,
      proposed_dates: mergedExtracted.proposed_dates ?? [],
      key_details: mergedExtracted.key_details ?? [],
    },
  };

  const intentResult = resolveReplyIntent(triage);
  if (!isDraftableIntent(intentResult.intent)) {
    throw new Error(`not_draftable_intent:${intentResult.intent ?? "null"}`);
  }

  const { data: venue, error: venueErr } = await supabase
    .from("venues")
    .select("id, name, hubspot_contact_id, thread_id")
    .eq("id", venueId)
    .maybeSingle();

  if (venueErr) throw new Error(venueErr.message);
  if (!venue) throw new Error("venue_not_found");

  const { data: outbound } = await supabase
    .from("outbound_messages")
    .select("sent_from_address, message_id, thread_id")
    .eq("venue_id", venueId)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const sentFromAddress =
    outbound?.sent_from_address ??
    process.env.SENT_FROM_ADDRESS?.trim() ??
    null;

  let subject = "Re: Private event inquiry";
  let recentThread = "";

  try {
    const threadMsgs = await fetchUnipileThreadEmails(inbound.thread_id, 10);
    if (threadMsgs.length > 0) {
      const ourAddresses = [
        sentFromAddress,
        process.env.SENT_FROM_ADDRESS,
      ].filter((a): a is string => !!a && a.trim().length > 0);

      recentThread = formatThreadMessagesForDraft(threadMsgs, {
        ourAddresses,
      });

      const newest = threadMsgs[0];
      const rawSubject = asString(newest?.subject);
      if (rawSubject) {
        subject = rawSubject.toLowerCase().startsWith("re:")
          ? rawSubject
          : `Re: ${rawSubject}`;
      }
    }
  } catch {
    // Fall through to single-message fetch.
  }

  if (!recentThread) {
    let bodyPlain = "";
    try {
      const full = await fetchUnipileEmail(messageId);
      const rawSubject = asString(full.subject);
      if (rawSubject) {
        subject = rawSubject.toLowerCase().startsWith("re:")
          ? rawSubject
          : `Re: ${rawSubject}`;
      }
      bodyPlain = stripQuotedHistory(
        asString(full.body_plain) || asString(full.body),
      );
    } catch {
      // Context still usable with triage extraction alone.
    }
    recentThread = [
      `Inbound subject: ${subject}`,
      `Inbound body (stripped):\n${bodyPlain.slice(0, 2000) || "(empty)"}`,
    ].join("\n\n");
  }

  const senderEmail = (inbound.sender_email || "").toLowerCase().trim();
  if (!senderEmail) throw new Error("missing_sender_email");

  const knownFacts = formatKnownFacts(mergedExtracted);

  return {
    venueId,
    messageId,
    threadId: inbound.thread_id,
    venueName: venue.name,
    hubspotContactId: venue.hubspot_contact_id,
    senderEmail,
    subject,
    replyToMessageId: messageId,
    sentFromAddress,
    triage,
    intentResult,
    recentThread,
    knownFacts,
    eventBriefText: buildEventBriefText(),
    playbook: buildPlaybook(intentResult),
  };
}
