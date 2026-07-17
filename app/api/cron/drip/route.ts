import { NextRequest, NextResponse } from "next/server";
import { runDrip } from "@/lib/drip/engine";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const maxDuration = 300;
export const runtime = "nodejs";

function authorizeCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorizeCron(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const supabase = getSupabaseAdmin();
    const result = await runDrip(supabase);
    console.info("[drip] run complete", {
      paused: result.paused,
      dryRun: result.dryRun,
      intended: result.intended.length,
      sent: result.sent.length,
      skipped: result.skipped.length,
      errors: result.errors.length,
      warmupDay: result.warmupDay,
      runQuota: result.runQuota,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[drip] failed", err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

/** Allow manual POST with same auth (local/seed testing). */
export async function POST(req: NextRequest) {
  return GET(req);
}
