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
  const dsn = process.env.UNIPILE_DSN;
  if (!dsn) throw new Error("Missing UNIPILE_DSN");
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
  const apiKey = process.env.UNIPILE_API;
  const accountId = process.env.UNIPILE_ACCOUNT_ID;
  if (!apiKey || !accountId) {
    throw new Error("Missing UNIPILE_API or UNIPILE_ACCOUNT_ID");
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
  const apiKey = process.env.UNIPILE_API;
  if (!apiKey) throw new Error("Missing UNIPILE_API");

  const url = new URL(
    `${unipileBaseUrl()}/api/v1/emails/${encodeURIComponent(emailId)}`,
  );
  url.searchParams.set("include_headers", "true");

  const res = await fetch(url.toString(), {
    headers: {
      "X-API-KEY": apiKey,
      Accept: "application/json",
    },
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
    throw new Error(`Unipile get email ${res.status}: ${JSON.stringify(json)}`);
  }

  return json;
}

/**
 * Download a single attachment: GET /api/v1/emails/{email_id}/attachments/{attachment_id}
 * Returns raw bytes (binary body, or base64 JSON string when Unipile wraps content).
 */
export async function downloadUnipileAttachment(
  emailId: string,
  attachmentId: string,
): Promise<Buffer> {
  const apiKey = process.env.UNIPILE_API;
  const accountId = process.env.UNIPILE_ACCOUNT_ID;
  if (!apiKey) throw new Error("Missing UNIPILE_API");
  if (!emailId.trim() || !attachmentId.trim()) {
    throw new Error("Missing email_id or attachment_id");
  }

  const url = new URL(
    `${unipileBaseUrl()}/api/v1/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
  if (accountId) url.searchParams.set("account_id", accountId);

  const res = await fetch(url.toString(), {
    headers: {
      "X-API-KEY": apiKey,
      Accept: "*/*",
    },
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Unipile get attachment ${res.status}: ${errText.slice(0, 500)}`,
    );
  }

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return Buffer.from(text);
    }
    if (typeof json === "string") {
      const b64 = json.replace(/^data:[^;]+;base64,/, "");
      try {
        return Buffer.from(b64, "base64");
      } catch {
        return Buffer.from(json);
      }
    }
    if (json && typeof json === "object") {
      const obj = json as Record<string, unknown>;
      const data =
        obj.data ?? obj.content ?? obj.body ?? obj.attachment ?? obj.file;
      if (typeof data === "string") {
        const b64 = data.replace(/^data:[^;]+;base64,/, "");
        try {
          return Buffer.from(b64, "base64");
        } catch {
          return Buffer.from(data);
        }
      }
      if (data && typeof data === "object" && ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView;
        return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
      }
    }
    return Buffer.from(text);
  }

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/** Normalize Unipile list-emails payloads to an array of email objects. */
export function normalizeUnipileEmailList(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) {
    return json.filter(
      (row): row is Record<string, unknown> =>
        !!row && typeof row === "object" && !Array.isArray(row),
    );
  }
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  for (const key of ["items", "emails", "data", "results"] as const) {
    const v = obj[key];
    if (Array.isArray(v)) {
      return v.filter(
        (row): row is Record<string, unknown> =>
          !!row && typeof row === "object" && !Array.isArray(row),
      );
    }
  }
  return [];
}

/**
 * List recent emails in a Unipile thread (most recent first).
 * GET /api/v1/emails?account_id=&thread_id=&limit=
 */
export async function fetchUnipileThreadEmails(
  threadId: string,
  limit = 3,
): Promise<Record<string, unknown>[]> {
  const apiKey = process.env.UNIPILE_API;
  const accountId = process.env.UNIPILE_ACCOUNT_ID;
  if (!apiKey || !accountId) {
    throw new Error("Missing UNIPILE_API or UNIPILE_ACCOUNT_ID");
  }
  if (!threadId.trim()) {
    throw new Error("Missing thread_id");
  }

  const url = new URL(`${unipileBaseUrl()}/api/v1/emails`);
  url.searchParams.set("account_id", accountId);
  url.searchParams.set("thread_id", threadId);
  url.searchParams.set("limit", String(Math.max(1, Math.min(limit, 20))));

  const res = await fetch(url.toString(), {
    headers: {
      "X-API-KEY": apiKey,
      Accept: "application/json",
    },
  });

  const text = await res.text();
  let json: unknown = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }

  if (!res.ok) {
    throw new Error(
      `Unipile list emails ${res.status}: ${JSON.stringify(json)}`,
    );
  }

  return normalizeUnipileEmailList(json).slice(0, limit);
}

/**
 * Extract RFC Message-IDs from In-Reply-To / References for outbound matching.
 */
export function extractReplyMessageIdHeaders(
  email: Record<string, unknown> | null | undefined,
): string[] {
  if (!email) return [];

  const found = new Set<string>();

  const pushIds = (raw: string) => {
    const matches = raw.match(/<[^>]+>/g);
    if (matches) {
      for (const m of matches) found.add(m.trim());
    } else {
      const t = raw.trim();
      if (t) found.add(t.startsWith("<") ? t : `<${t}>`);
    }
  };

  const inReplyTo = email.in_reply_to;
  if (typeof inReplyTo === "string") {
    pushIds(inReplyTo);
  } else if (inReplyTo && typeof inReplyTo === "object") {
    const obj = inReplyTo as Record<string, unknown>;
    const mid = obj.message_id ?? obj.id;
    if (typeof mid === "string" && mid.trim()) pushIds(mid);
  }

  const headers = email.headers;
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (!h || typeof h !== "object") continue;
      const row = h as Record<string, unknown>;
      const name = String(row.name ?? row.key ?? "").toLowerCase();
      const value = String(row.value ?? "");
      if (
        (name === "in-reply-to" || name === "references") &&
        value.trim()
      ) {
        pushIds(value);
      }
    }
  }

  return [...found];
}
