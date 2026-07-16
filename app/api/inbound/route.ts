import { NextRequest, NextResponse } from "next/server";
import {
  isInboundEmail,
  summarizeInbound,
  unipileEmailWebhookSchema,
} from "@/lib/unipile/inbound-payload";
import { verifyUnipileWebhook } from "@/lib/unipile/verify-webhook";

export const maxDuration = 60;
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "inbound",
    status: "ready",
  });
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text().catch(() => "");
  const authHeader = req.headers.get("unipile-auth");
  const signatureHeader = req.headers.get("unipile-signature");
  const secret = process.env.UNIPILE_WEBHOOK_SECRET;

  const verified = verifyUnipileWebhook({
    rawBody,
    authHeader,
    signatureHeader,
    secret,
  });
  if (!verified.ok) {
    console.warn("[inbound] auth rejected", { error: verified.error });
    return NextResponse.json(
      { ok: false, error: verified.error },
      { status: verified.status },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const payloadResult = unipileEmailWebhookSchema.safeParse(parsed);
  if (!payloadResult.success) {
    console.warn("[inbound] payload shape unexpected", {
      issues: payloadResult.error.flatten(),
    });
    // Still ack so Unipile does not hammer retries on unknown shapes during spike.
    return NextResponse.json({ received: true, skipped: true, reason: "invalid_shape" });
  }

  const payload = payloadResult.data;
  const summary = summarizeInbound(payload);

  const expectedAccountId = process.env.UNPILE_ACCOUNT_ID;
  if (
    expectedAccountId &&
    payload.account_id &&
    payload.account_id !== expectedAccountId
  ) {
    console.info("[inbound] skipped: account_id mismatch", {
      ...summary,
      expected_account_id: expectedAccountId,
    });
    return NextResponse.json({
      received: true,
      skipped: true,
      reason: "account_mismatch",
    });
  }

  const filter = isInboundEmail(payload);
  if (!filter.process) {
    console.info("[inbound] skipped", { ...summary, reason: filter.reason });
    return NextResponse.json({
      received: true,
      skipped: true,
      reason: filter.reason,
    });
  }

  // Day 1: log only. Triage / claim-before-LLM comes later.
  console.info("[inbound] accepted", summary);

  return NextResponse.json({ received: true, skipped: false });
}
