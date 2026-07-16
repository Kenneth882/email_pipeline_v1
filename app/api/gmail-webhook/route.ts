import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * Stub Pub/Sub push endpoint.
 * Returns 200 so GCP can verify the subscription target.
 * Real history-sync / triage lands here later.
 */
export async function POST(req: NextRequest) {
  // Consume body so Pub/Sub delivery isn't left hanging mid-stream.
  await req.text().catch(() => null);
  return NextResponse.json({ ok: true }, { status: 200 });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "gmail-webhook",
    status: "stub",
  });
}
