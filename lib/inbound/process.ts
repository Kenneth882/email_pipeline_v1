import type { SupabaseClient } from "@supabase/supabase-js";
import { matchInboundToVenue } from "@/lib/crm/match";
import { mergeIcpExtracted } from "@/lib/crm/icp";
import { loadPriorExtractions } from "@/lib/crm/prior-extraction";
import { runCrmWriter } from "@/lib/crm/writer";
import { runDraftingAgent } from "@/lib/draft/agent";
import { resolveReplyIntent } from "@/lib/draft/intent";
import { stripQuotedHistory } from "@/lib/email/strip-quotes";
import { extractPdfAttachments } from "@/lib/triage/pdf";
import { runTriage } from "@/lib/triage/run";
import type { TriageAttachment } from "@/lib/triage/schema";
import type { UnipileEmailWebhook } from "@/lib/unipile/inbound-payload";
import {
  extractReplyMessageIdHeaders,
  fetchUnipileEmail,
} from "@/lib/unipile/send";

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asOptionalNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return undefined;
}

function attachmentsFrom(
  payload: UnipileEmailWebhook,
  full: Record<string, unknown> | null,
): TriageAttachment[] {
  const raw =
    (full?.attachments as unknown[]) ??
    ((payload as { attachments?: unknown[] }).attachments as unknown[]) ??
    [];

  return raw
    .map((a) => {
      const obj = a as Record<string, unknown>;
      const id = asString(obj.id || obj.attachment_id || obj.att_id);
      const size = asOptionalNumber(obj.size ?? obj.size_bytes ?? obj.bytes);
      return {
        id: id || undefined,
        filename: asString(obj.filename || obj.name || "attachment"),
        mimeType: asString(
          obj.mime || obj.mime_type || obj.content_type || "application/octet-stream",
        ),
        size,
      };
    })
    .filter((a) => a.filename);
}

/**
 * After claim: triage + match + finalize inbound_messages + CRM Writer + Drafting Agent.
 */
export async function processClaimedInbound(
  supabase: SupabaseClient,
  payload: UnipileEmailWebhook,
  messageId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    let full: Record<string, unknown> | null = null;
    try {
      full = await fetchUnipileEmail(messageId);
    } catch (err) {
      console.warn("[triage] fetch email failed; using webhook body", err);
    }

    const subject =
      asString(full?.subject) || payload.subject || "(no subject)";
    const bodyRaw =
      asString(full?.body_plain) ||
      asString(full?.body) ||
      payload.body_plain ||
      payload.body ||
      "";
    const bodyPlain = stripQuotedHistory(bodyRaw);
    const threadId =
      asString(full?.thread_id) ||
      payload.thread_id ||
      payload.message_id ||
      messageId;
    const senderEmail =
      payload.from_attendee?.identifier?.toLowerCase().trim() ||
      asString(
        (full?.from_attendee as { identifier?: string } | undefined)
          ?.identifier,
      ).toLowerCase() ||
      null;

    const attachments = attachmentsFrom(payload, full);
    const pdf = await extractPdfAttachments(messageId, attachments);
    const inReplyToHeaders = extractReplyMessageIdHeaders(full);

    const triage = await runTriage({
      threadId,
      subject,
      bodyPlain,
      attachments,
      attachmentTexts: pdf.texts,
      attachmentPending: pdf.pending,
    });

    const match = await matchInboundToVenue(supabase, {
      threadId,
      senderEmail,
      inReplyToHeaders,
    });

    const venueId = match.venueId;

    // Thread ICP memory: merge prior extracts so follow-ups don't wipe settled fields.
    let prior = {};
    if (venueId) {
      try {
        prior = await loadPriorExtractions(supabase, {
          venueId,
          threadId,
          excludeMessageId: messageId,
        });
      } catch (err) {
        console.warn(
          "[triage] prior extractions failed; using current only",
          err,
        );
      }
    }
    const mergedExtracted = mergeIcpExtracted(prior, triage.extracted);
    const triageForDecisions = {
      ...triage,
      extracted: {
        ...triage.extracted,
        ...mergedExtracted,
        proposed_dates: mergedExtracted.proposed_dates ?? [],
        key_details: mergedExtracted.key_details ?? [],
        fees: mergedExtracted.fees ?? triage.extracted.fees ?? null,
      },
    };

    const intentResult = resolveReplyIntent(triageForDecisions);
    const replyRequired =
      triage.reply_required &&
      intentResult.draftable &&
      match.confidence !== "NONE" &&
      !!venueId;

    // auto_reply must NOT cancel follow-ups (do not set last_inbound_at)
    const shouldTouchInbound =
      !!venueId && triage.classification !== "auto_reply";

    if (shouldTouchInbound && venueId) {
      await supabase
        .from("venues")
        .update({
          last_inbound_at: new Date().toISOString(),
          thread_id: threadId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", venueId);
    }

    if (triage.classification === "bounce" && venueId) {
      await supabase
        .from("venues")
        .update({ bounced: true, updated_at: new Date().toISOString() })
        .eq("id", venueId);
    }

    // Persist THIS message's extract for audit; decisions use merged.
    const { error: updErr } = await supabase
      .from("inbound_messages")
      .update({
        thread_id: threadId,
        venue_id: venueId,
        sender_email: senderEmail,
        match_confidence: match.confidence,
        classification: triage.classification,
        extraction: triage.extracted,
        confidence: triage.confidence,
        needs_human_review: triage.needs_human_review,
        reply_required: replyRequired,
        status: "done",
        processed_at: new Date().toISOString(),
      })
      .eq("message_id", messageId);

    if (updErr) throw new Error(updErr.message);

    await supabase.from("pipeline_events").insert({
      venue_id: venueId,
      message_id: messageId,
      actor: "triage",
      event: "classified",
      detail: {
        classification: triage.classification,
        confidence: triage.confidence,
        needs_human_review: triage.needs_human_review,
        reply_required: replyRequired,
        reply_intent: intentResult.intent,
        effective_spend_usd: intentResult.effectiveSpendUsd,
        spend_estimate: intentResult.spendEstimate,
        match,
        merged_icp: mergedExtracted,
        attachment_pending: pdf.pending,
        unread_pdfs: pdf.unread,
      },
    });

    // CRM Writer: HubSpot contact props + stage (after ledger finalize)
    // Pass merged extract so HubSpot ICP fields don't regress to null.
    if (venueId && match.confidence !== "NONE") {
      const crm = await runCrmWriter({
        supabase,
        venueId,
        messageId,
        threadId,
        triage: triageForDecisions,
        match,
      });
      if (!crm.ok) {
        console.error("[crm] writer failed", {
          message_id: messageId,
          venue_id: venueId,
          error: crm.error,
        });
        await supabase
          .from("inbound_messages")
          .update({ needs_human_review: true })
          .eq("message_id", messageId);
        // Triage succeeded; CRM failure surfaces via digest / needs_review — still ok
      }

      if (intentResult.intent === "close_lost") {
        await supabase.from("pipeline_events").insert({
          venue_id: venueId,
          message_id: messageId,
          actor: "drafter",
          event: "lost_no_draft",
          detail: { intent: "close_lost" },
        });
      } else if (crm.ok && replyRequired) {
        const draft = await runDraftingAgent({
          supabase,
          venueId,
          messageId,
          triage: triageForDecisions,
        });
        if (!draft.ok) {
          console.error("[drafter] failed", {
            message_id: messageId,
            venue_id: venueId,
            error: draft.error,
          });
        }
      }
    }

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase
      .from("inbound_messages")
      .update({
        status: "error",
        needs_human_review: true,
        processed_at: new Date().toISOString(),
      })
      .eq("message_id", messageId);

    await supabase.from("pipeline_events").insert({
      message_id: messageId,
      actor: "triage",
      event: "error",
      detail: { error: msg },
    });

    return { ok: false, error: msg };
  }
}
