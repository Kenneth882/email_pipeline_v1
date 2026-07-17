import type { SupabaseClient } from "@supabase/supabase-js";
import { matchInboundToVenue } from "@/lib/crm/match";
import { runCrmWriter } from "@/lib/crm/writer";
import { runDraftingAgent } from "@/lib/draft/agent";
import { resolveReplyIntent } from "@/lib/draft/intent";
import { stripQuotedHistory } from "@/lib/email/strip-quotes";
import { runTriage } from "@/lib/triage/run";
import type { UnipileEmailWebhook } from "@/lib/unipile/inbound-payload";
import {
  extractReplyMessageIdHeaders,
  fetchUnipileEmail,
} from "@/lib/unipile/send";

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function attachmentsFrom(
  payload: UnipileEmailWebhook,
  full: Record<string, unknown> | null,
): Array<{ filename: string; mimeType: string }> {
  const raw =
    (full?.attachments as unknown[]) ??
    ((payload as { attachments?: unknown[] }).attachments as unknown[]) ??
    [];

  return raw
    .map((a) => {
      const obj = a as Record<string, unknown>;
      return {
        filename: asString(obj.filename || obj.name || "attachment"),
        mimeType: asString(
          obj.mime || obj.mime_type || obj.content_type || "application/octet-stream",
        ),
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
    const inReplyToHeaders = extractReplyMessageIdHeaders(full);

    const triage = await runTriage({
      threadId,
      subject,
      bodyPlain,
      attachments,
    });

    const match = await matchInboundToVenue(supabase, {
      threadId,
      senderEmail,
      inReplyToHeaders,
    });

    const venueId = match.venueId;
    const intentResult = resolveReplyIntent(triage);
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
        match,
      },
    });

    // CRM Writer: HubSpot contact props + stage (after ledger finalize)
    if (venueId && match.confidence !== "NONE") {
      const crm = await runCrmWriter({
        supabase,
        venueId,
        messageId,
        threadId,
        triage,
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
          triage,
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
