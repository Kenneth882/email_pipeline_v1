export type UnipileSendInput = {
  toEmail: string;
  toName?: string;
  subject: string;
  body: string;
  /** Unipile provider email id to reply in-thread */
  replyToMessageId?: string;
};

export type UnipileSendResult = {
  messageId: string;
  threadId: string;
  messageIdHeader: string;
  raw: Record<string, unknown>;
};

function unipileBaseUrl(): string {
  const dsn = process.env.UNPILE_DSN;
  if (!dsn) throw new Error("Missing UNPILE_DSN");
  if (dsn.startsWith("http://") || dsn.startsWith("https://")) return dsn;
  return `https://${dsn}`;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Send via Unipile POST /api/v1/emails (JSON).
 * Follow-ups pass reply_to = prior Unipile message id for threading.
 */
export async function sendUnipileEmail(
  input: UnipileSendInput,
): Promise<UnipileSendResult> {
  const apiKey = process.env.UNPILE_API;
  const accountId = process.env.UNPILE_ACCOUNT_ID;
  if (!apiKey || !accountId) {
    throw new Error("Missing UNPILE_API or UNPILE_ACCOUNT_ID");
  }

  const payload: Record<string, unknown> = {
    account_id: accountId,
    subject: input.subject,
    body: input.body,
    to: [
      {
        display_name: input.toName || input.toEmail,
        identifier: input.toEmail,
      },
    ],
    custom_headers: [
      { name: "Content-Type", value: "text/plain; charset=utf-8" },
    ],
  };

  if (input.replyToMessageId) {
    payload.reply_to = input.replyToMessageId;
  }

  const res = await fetch(`${unipileBaseUrl()}/api/v1/emails`, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json: Record<string, unknown> = {};
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { raw: text };
    }
  }

  if (!res.ok) {
    throw new Error(`Unipile send ${res.status}: ${JSON.stringify(json)}`);
  }

  const messageId =
    pickString(json, [
      "id",
      "email_id",
      "provider_id",
      "message_id",
    ]) ?? `unipile-${Date.now()}`;

  const threadId =
    pickString(json, ["thread_id", "provider_thread_id", "conversation_id"]) ??
    messageId;

  const messageIdHeader =
    pickString(json, [
      "message_id_header",
      "rfc_message_id",
      "internet_message_id",
    ]) ?? `<${messageId}@unipile.local>`;

  return { messageId, threadId, messageIdHeader, raw: json };
}

export async function fetchUnipileEmail(
  emailId: string,
): Promise<Record<string, unknown>> {
  const apiKey = process.env.UNPILE_API;
  if (!apiKey) throw new Error("Missing UNPILE_API");

  const res = await fetch(
    `${unipileBaseUrl()}/api/v1/emails/${encodeURIComponent(emailId)}`,
    {
      headers: {
        "X-API-KEY": apiKey,
        Accept: "application/json",
      },
    },
  );

  const text = await res.text();
  let json: Record<string, unknown> = {};
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { raw: text };
    }
  }

  if (!res.ok) {
    throw new Error(`Unipile get email ${res.status}: ${JSON.stringify(json)}`);
  }

  return json;
}
