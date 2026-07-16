import { createHmac, timingSafeEqual } from "crypto";

const MAX_AGE_SECONDS = 300;

export type VerifyWebhookResult =
  | { ok: true }
  | { ok: false; status: 400 | 401; error: string };

function safeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Verify Unipile `unipile-signature` header against the raw request body.
 * Header format: `t=<unix_seconds>,v0=<hmac_sha256_hex>`
 * Signed payload: `${t}.${rawBody}`
 */
export function verifyUnipileWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string | undefined,
): VerifyWebhookResult {
  if (!secret) {
    return { ok: false, status: 401, error: "Missing webhook secret" };
  }
  if (!signatureHeader) {
    return { ok: false, status: 401, error: "Missing unipile-signature header" };
  }

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => {
      const eq = part.indexOf("=");
      if (eq === -1) return [part.trim(), ""];
      return [part.slice(0, eq).trim(), part.slice(eq + 1).trim()];
    }),
  );

  const timestamp = parts.t;
  const receivedSignature = parts.v0;

  if (!timestamp || !receivedSignature) {
    return { ok: false, status: 400, error: "Invalid signature header" };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, status: 400, error: "Invalid signature timestamp" };
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (ageSeconds > MAX_AGE_SECONDS) {
    return { ok: false, status: 401, error: "Expired signature" };
  }

  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedSignature = createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest("hex");

  try {
    if (!safeEqualString(receivedSignature, expectedSignature)) {
      return { ok: false, status: 401, error: "Invalid signature" };
    }
  } catch {
    return { ok: false, status: 401, error: "Invalid signature" };
  }

  return { ok: true };
}

type VerifyUnipileWebhookInput = {
  rawBody: string;
  authHeader: string | null;
  signatureHeader: string | null;
  secret: string | undefined;
};

/**
 * Auth order:
 * 1. Unipile-Auth shared secret (dashboard/API custom header)
 * 2. Else unipile-signature HMAC (v2 signing)
 */
export function verifyUnipileWebhook(
  input: VerifyUnipileWebhookInput,
): VerifyWebhookResult {
  const { rawBody, authHeader, signatureHeader, secret } = input;

  if (!secret) {
    return { ok: false, status: 401, error: "Missing webhook secret" };
  }

  if (authHeader) {
    try {
      if (!safeEqualString(authHeader, secret)) {
        return { ok: false, status: 401, error: "Invalid Unipile-Auth" };
      }
    } catch {
      return { ok: false, status: 401, error: "Invalid Unipile-Auth" };
    }
    return { ok: true };
  }

  if (signatureHeader) {
    return verifyUnipileWebhookSignature(rawBody, signatureHeader, secret);
  }

  return { ok: false, status: 401, error: "Missing Unipile-Auth or unipile-signature" };
}
