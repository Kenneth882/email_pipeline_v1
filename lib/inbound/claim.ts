import type { SupabaseClient } from "@supabase/supabase-js";
import type { UnipileEmailWebhook } from "@/lib/unipile/inbound-payload";

export type ClaimResult =
  | { ok: true; duplicate: false; messageId: string }
  | { ok: true; duplicate: true; messageId: string }
  | { ok: false; error: string };

function isUniqueViolation(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "23505" ||
    (error.message?.toLowerCase().includes("duplicate key") ?? false)
  );
}

/**
 * Claim an inbound message before any LLM work.
 * PK = Unipile email_id. Duplicate delivery → ok + duplicate.
 */
export async function claimInboundMessage(
  supabase: SupabaseClient,
  payload: UnipileEmailWebhook,
): Promise<ClaimResult> {
  const messageId = payload.email_id?.trim();
  if (!messageId) {
    return { ok: false, error: "missing_email_id" };
  }

  const threadId =
    payload.thread_id?.trim() ||
    payload.message_id?.trim() ||
    messageId;

  const senderEmail =
    payload.from_attendee?.identifier?.trim().toLowerCase() || null;

  const { error: insertError } = await supabase.from("inbound_messages").insert({
    message_id: messageId,
    thread_id: threadId,
    sender_email: senderEmail,
    match_confidence: "NONE",
    status: "processing",
  });

  if (insertError) {
    if (isUniqueViolation(insertError)) {
      return { ok: true, duplicate: true, messageId };
    }
    return { ok: false, error: insertError.message };
  }

  const { error: eventError } = await supabase.from("pipeline_events").insert({
    message_id: messageId,
    actor: "unipile",
    event: "inbound_received",
    detail: {
      subject: payload.subject ?? null,
      sender_email: senderEmail,
      account_id: payload.account_id ?? null,
      thread_id: threadId,
    },
  });

  if (eventError) {
    return { ok: false, error: eventError.message };
  }

  return { ok: true, duplicate: false, messageId };
}
