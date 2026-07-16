import { z } from "zod";

const attendeeSchema = z
  .object({
    display_name: z.string().optional(),
    identifier: z.string().optional(),
    identifier_type: z.string().optional(),
  })
  .passthrough();

/** Loose schema for Unipile new-email webhook (Day-1 logging/filter only). */
export const unipileEmailWebhookSchema = z
  .object({
    email_id: z.string().optional(),
    account_id: z.string().optional(),
    event: z.string().optional(),
    message_id: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
    body_plain: z.string().optional(),
    has_attachments: z.boolean().optional(),
    is_complete: z.boolean().optional(),
    origin: z.string().optional(),
    role: z.string().optional(),
    folders: z.array(z.string()).optional(),
    from_attendee: attendeeSchema.optional(),
    date: z.string().optional(),
  })
  .passthrough();

export type UnipileEmailWebhook = z.infer<typeof unipileEmailWebhookSchema>;

export type InboundFilterResult =
  | { process: true }
  | { process: false; reason: string };

/** Day-1 inbound-only: mail_received + inbox role/folder. */
export function isInboundEmail(payload: UnipileEmailWebhook): InboundFilterResult {
  if (payload.event !== "mail_received") {
    return {
      process: false,
      reason: `event=${payload.event ?? "unknown"} (want mail_received)`,
    };
  }

  const role = payload.role?.toLowerCase();
  const folders = (payload.folders ?? []).map((f) => f.toLowerCase());
  const isInbox = role === "inbox" || folders.includes("inbox");

  if (!isInbox) {
    return {
      process: false,
      reason: `not inbox (role=${payload.role ?? "none"}, folders=${(payload.folders ?? []).join(",") || "none"})`,
    };
  }

  return { process: true };
}

export function summarizeInbound(payload: UnipileEmailWebhook) {
  return {
    email_id: payload.email_id ?? null,
    message_id: payload.message_id ?? null,
    account_id: payload.account_id ?? null,
    event: payload.event ?? null,
    role: payload.role ?? null,
    folders: payload.folders ?? [],
    from: payload.from_attendee?.identifier ?? null,
    subject: payload.subject ?? null,
    has_attachments: payload.has_attachments ?? null,
    is_complete: payload.is_complete ?? null,
    origin: payload.origin ?? null,
  };
}
