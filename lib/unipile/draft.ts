function unipileBaseUrl(): string {
  const dsn = process.env.UNIPILE_DSN;
  if (!dsn) throw new Error("Missing UNIPILE_DSN");
  if (dsn.startsWith("http://") || dsn.startsWith("https://")) return dsn;
  return `https://${dsn}`;
}

export type UnipileDraftInput = {
  toEmail: string;
  toName?: string;
  subject: string;
  body: string;
  /** Unipile email id to reply in-thread */
  replyToMessageId: string;
  fromAddress?: string;
};

export type UnipileDraftResult = {
  draftId: string;
  raw: Record<string, unknown>;
};

/**
 * Create a Gmail/provider draft via Unipile POST /api/v1/drafts (multipart).
 * Never sends — human reviews Drafts folder.
 */
export async function createUnipileDraft(
  input: UnipileDraftInput,
): Promise<UnipileDraftResult> {
  const apiKey = process.env.UNIPILE_API;
  const accountId = process.env.UNIPILE_ACCOUNT_ID;
  if (!apiKey || !accountId) {
    throw new Error("Missing UNIPILE_API or UNIPILE_ACCOUNT_ID");
  }

  const form = new FormData();
  form.append("account_id", accountId);
  form.append("subject", input.subject);
  form.append("body", input.body);
  form.append("reply_to", input.replyToMessageId);
  form.append(
    "to",
    JSON.stringify([
      {
        display_name: input.toName || input.toEmail,
        identifier: input.toEmail,
      },
    ]),
  );
  form.append(
    "custom_headers",
    JSON.stringify([
      { name: "Content-Type", value: "text/plain; charset=utf-8" },
    ]),
  );
  if (input.fromAddress) {
    form.append(
      "from",
      JSON.stringify({
        display_name: input.fromAddress,
        identifier: input.fromAddress,
      }),
    );
  }

  const res = await fetch(`${unipileBaseUrl()}/api/v1/drafts`, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      Accept: "application/json",
    },
    body: form,
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
    throw new Error(`Unipile draft ${res.status}: ${JSON.stringify(json)}`);
  }

  const draftId =
    (typeof json.draft_id === "string" && json.draft_id) ||
    (typeof json.id === "string" && json.id) ||
    null;
  if (!draftId) {
    throw new Error(`Unipile draft missing id: ${JSON.stringify(json)}`);
  }

  return { draftId, raw: json };
}
