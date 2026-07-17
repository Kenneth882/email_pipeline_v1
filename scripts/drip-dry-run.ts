/**
 * Local dry-run of drip engine (no Unipile send).
 * Usage: npm run test:drip-dry
 */

import { createClient } from "@supabase/supabase-js";
import { runDrip } from "../lib/drip/engine";
import { setConfigValue } from "../lib/config";

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase env");

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Force dry-run for this script regardless of env
  process.env.DRIP_DRY_RUN = "true";
  await setConfigValue(supabase, "drip_dry_run", true);

  // Temporarily unpause to exercise candidate selection; restore after
  const { data: pausedRow } = await supabase
    .from("config")
    .select("value")
    .eq("key", "paused")
    .maybeSingle();
  const wasPaused = pausedRow?.value;

  await setConfigValue(supabase, "paused", false);

  try {
    const result = await runDrip(supabase);
    console.log(JSON.stringify(result, null, 2));
    if (!result.dryRun) {
      throw new Error("expected dryRun=true");
    }
    console.log("\nOK: dry-run completed (no Unipile sends).");
  } finally {
    await setConfigValue(supabase, "paused", wasPaused ?? true);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
