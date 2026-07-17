/**
 * Day 3–5 automated checks (no live Unipile send required).
 * Usage: npm run test:day3
 */

import { createClient } from "@supabase/supabase-js";
import { stripQuotedHistory } from "../lib/email/strip-quotes";
import { applyTriageFirewall } from "../lib/triage/firewall";
import type { TriageResult } from "../lib/triage/schema";
import { dailyQuotaForWarmupDay, halfQuota } from "../lib/config";
import { runDrip } from "../lib/drip/engine";
import { setConfigValue } from "../lib/config";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function firewallCase() {
  const base: TriageResult = {
    thread_id: "t1",
    classification: "pricing_info",
    extracted: { proposed_dates: [], key_details: [] },
    confidence: 0.9,
    needs_human_review: false,
    reply_required: true,
  };

  const contract = applyTriageFirewall(
    { ...base, classification: "contract" },
    {
      threadId: "t1",
      subject: "Agreement",
      bodyPlain: "Please sign the agreement",
      attachments: [],
    },
  );
  assert(contract.reply_required === false, "contract must not reply");
  assert(contract.needs_human_review === true, "contract must review");

  const low = applyTriageFirewall(
    { ...base, confidence: 0.4 },
    {
      threadId: "t1",
      subject: "Hi",
      bodyPlain: "hello",
      attachments: [],
    },
  );
  assert(low.needs_human_review && !low.reply_required, "low confidence escalate");

  const auto = applyTriageFirewall(
    { ...base, classification: "auto_reply" },
    {
      threadId: "t1",
      subject: "OOO",
      bodyPlain: "out of office",
      attachments: [],
    },
  );
  assert(auto.reply_required === false, "auto_reply no draft");
}

function quoteStripCase() {
  const gmail = stripQuotedHistory(
    "Thanks, our min is $2k.\n\nOn Mon, Jan 1 Jane wrote:\n> earlier",
  );
  assert(!gmail.includes("On Mon"), "gmail quote stripped");
  assert(gmail.includes("$2k"), "kept new content");

  const outlook = stripQuotedHistory(
    "We can do private.\nFrom: a@b.com\nSent: Monday\nTo: x\n\nold",
  );
  assert(!outlook.includes("Sent:"), "outlook quote stripped");
}

async function main() {
  console.log("1) Quota math…");
  assert(dailyQuotaForWarmupDay(1) === 15, "day1 quota");
  assert(dailyQuotaForWarmupDay(5) === 30, "day5 quota");
  assert(dailyQuotaForWarmupDay(9) === 50, "day9 quota");
  assert(halfQuota(15) === 8, "half of 15");
  console.log("  ok");

  console.log("2) Quote strip + firewall…");
  quoteStripCase();
  firewallCase();
  console.log("  ok");

  console.log("3) Schema: is_seed + seed isolation…");
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert(url && key, "Missing Supabase env");
  const supabase = createClient(url!, key!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { count: realSeeds } = await supabase
    .from("venues")
    .select("id", { count: "exact", head: true })
    .eq("is_seed", true)
    .neq("source_system", "seed_test");

  // Real Chicago venues should remain is_seed=false
  const { data: chicago } = await supabase
    .from("venues")
    .select("name, is_seed")
    .eq("contact_method", "email")
    .is("is_seed", true)
    .not("source_system", "eq", "seed_test");

  if (chicago && chicago.length) {
    console.warn(
      "  warn: some non-seed_test venues marked is_seed:",
      chicago.map((c) => c.name),
    );
  } else {
    console.log("  ok: Chicago venues not in seed allowlist");
  }
  void realSeeds;

  console.log("4) Drip dry-run + kill switch…");
  process.env.DRIP_DRY_RUN = "true";
  await setConfigValue(supabase, "drip_dry_run", true);
  await setConfigValue(supabase, "paused", true);
  const pausedRun = await runDrip(supabase);
  assert(pausedRun.paused === true, "paused should short-circuit");
  assert(pausedRun.intended.length === 0, "paused sends nothing");

  await setConfigValue(supabase, "paused", false);
  const dry = await runDrip(supabase);
  assert(dry.dryRun === true, "dry run flag");
  assert(dry.sent.length === 0, "dry run must not send");
  await setConfigValue(supabase, "paused", true);
  console.log("  ok: paused + dry-run", {
    intended: dry.intended.length,
    runQuota: dry.runQuota,
  });

  console.log("\nAll Day 3 automated checks passed.");
  console.log(
    "Manual remaining: Vercel CRON_SECRET + Supabase env, HubSpot properties scope,",
  );
  console.log(
    "SEED_EMAILS upsert + HubSpot IDs for seeds, then live drip with DRIP_DRY_RUN=false.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
