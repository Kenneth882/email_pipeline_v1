import { NextRequest, NextResponse } from "next/server";
import { claimInboundMessage } from "@/lib/inbound/claim";
import { processClaimedInbound } from "@/lib/inbound/process";
import { getSupabaseAdmin } from "@/lib/supabase/server";
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
    return NextResponse.json({
      received: true,
      skipped: true,
      reason: "invalid_shape",
    });
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

  if (!payload.email_id?.trim()) {
    console.warn("[inbound] missing email_id", summary);
    return NextResponse.json(
      { ok: false, error: "missing_email_id" },
      { status: 400 },
    );
  }

  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch (err) {
    console.error("[inbound] supabase config error", err);
    return NextResponse.json(
      { ok: false, error: "supabase_not_configured" },
      { status: 500 },
    );
  }

  const claim = await claimInboundMessage(supabase, payload);

  if (!claim.ok) {
    console.error("[inbound] claim failed", {
      ...summary,
      error: claim.error,
    });
    return NextResponse.json(
      { ok: false, error: claim.error },
      { status: 500 },
    );
  }

  if (claim.duplicate) {
    console.info("[inbound] duplicate", {
      ...summary,
      message_id: claim.messageId,
    });
    return NextResponse.json({
      received: true,
      duplicate: true,
      skipped: false,
    });
  }

  console.info("[inbound] claimed", {
    ...summary,
    message_id: claim.messageId,
  });

  // Triage after claim (claim-before-LLM). Failures mark inbound error but still 200
  // once claimed so Unipile does not redeliver and double-spend Claude — reconciliation
  // / digest surfaces errored rows. Missing ANTHROPIC_API_KEY leaves status=processing.
  if (process.env.ANTHROPIC_API_KEY) {
    const processed = await processClaimedInbound(
      supabase,
      payload,
      claim.messageId,
    );
    if (!processed.ok) {
      console.error("[inbound] triage failed", {
        message_id: claim.messageId,
        error: processed.error,
      });
      return NextResponse.json({
        received: true,
        duplicate: false,
        skipped: false,
        triaged: false,
        error: processed.error,
      });
    }
    return NextResponse.json({
      received: true,
      duplicate: false,
      skipped: false,
      triaged: true,
    });
  }

  console.warn("[inbound] ANTHROPIC_API_KEY missing; left status=processing");
  return NextResponse.json({
    received: true,
    duplicate: false,
    skipped: false,
    triaged: false,
    reason: "anthropic_not_configured",
  });
}
