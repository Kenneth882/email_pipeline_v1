import type { SupabaseClient } from "@supabase/supabase-js";
import { loadDraftContext } from "@/lib/draft/context";
import { isDraftableIntent, resolveReplyIntent } from "@/lib/draft/intent";
import { generateDraftBody } from "@/lib/draft/run";
import { updateContactProperties } from "@/lib/crm/hubspot";
import { createUnipileDraft } from "@/lib/unipile/draft";
import type { TriageResult } from "@/lib/triage/schema";

export type DraftAgentResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  draftId?: string;
  hasEscalation?: boolean;
  error?: string;
};

async function alreadyDrafted(
  supabase: SupabaseClient,
  messageId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("pipeline_events")
    .select("id")
    .eq("message_id", messageId)
    .eq("event", "draft_created")
    .limit(1)
    .maybeSingle();
  return !!data;
}

/**
 * Drafting Agent: { venue_id, message_id } only.
 * Creates a threaded Unipile draft; never sends.
 */
export async function runDraftingAgent(opts: {
  supabase: SupabaseClient;
  venueId: string;
  messageId: string;
  /** Optional preloaded triage to avoid re-read when caller already has it. */
  triage?: TriageResult;
}): Promise<DraftAgentResult> {
  const { supabase, venueId, messageId, triage } = opts;

  if (triage) {
    const intent = resolveReplyIntent(triage);
    if (!isDraftableIntent(intent.intent)) {
      await supabase.from("pipeline_events").insert({
        venue_id: venueId,
        message_id: messageId,
        actor: "drafter",
        event: "lost_no_draft",
        detail: {
          intent: intent.intent,
          draftable: false,
          effective_spend_usd: intent.effectiveSpendUsd,
          spend_estimate: intent.spendEstimate,
        },
      });
      return { ok: true, skipped: true, reason: "not_draftable" };
    }
  }

  if (await alreadyDrafted(supabase, messageId)) {
    return { ok: true, skipped: true, reason: "already_drafted" };
  }

  try {
    const ctx = await loadDraftContext(supabase, { venueId, messageId });
    const draft = await generateDraftBody(ctx);

    const created = await createUnipileDraft({
      toEmail: ctx.senderEmail,
      subject: draft.subject,
      body: draft.body,
      replyToMessageId: ctx.replyToMessageId,
      fromAddress: ctx.sentFromAddress ?? undefined,
    });

    if (draft.hasEscalation && ctx.hubspotContactId) {
      await updateContactProperties(ctx.hubspotContactId, {
        needs_review: true,
        review_reason: "draft_escalation",
      });
      await supabase
        .from("inbound_messages")
        .update({ needs_human_review: true })
        .eq("message_id", messageId);
    }

    await supabase.from("pipeline_events").insert({
      venue_id: venueId,
      message_id: messageId,
      actor: "drafter",
      event: "draft_created",
      detail: {
        draft_id: created.draftId,
        intent: ctx.intentResult.intent,
        has_escalation: draft.hasEscalation,
        subject: draft.subject,
      },
    });

    return {
      ok: true,
      draftId: created.draftId,
      hasEscalation: draft.hasEscalation,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.startsWith("not_draftable_intent:")) {
      await supabase.from("pipeline_events").insert({
        venue_id: venueId,
        message_id: messageId,
        actor: "drafter",
        event: "lost_no_draft",
        detail: { error: msg },
      });
      return { ok: true, skipped: true, reason: "not_draftable" };
    }

    await supabase.from("pipeline_events").insert({
      venue_id: venueId,
      message_id: messageId,
      actor: "drafter",
      event: "error",
      detail: { error: msg },
    });

    await supabase
      .from("inbound_messages")
      .update({ needs_human_review: true })
      .eq("message_id", messageId);

    return { ok: false, error: msg };
  }
}
