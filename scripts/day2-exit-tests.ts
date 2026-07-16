/**
 * Day 2 exit checks: HubSpot IDs present + idempotent inbound claim.
 * Usage: npx tsx --env-file=.env scripts/day2-exit-tests.ts
 */

import { createClient } from "@supabase/supabase-js";
import { claimInboundMessage } from "../lib/inbound/claim";
import type { UnipileEmailWebhook } from "../lib/unipile/inbound-payload";

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase env");

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log("1) Email venues have HubSpot IDs…");
  const { data: missing, error: missingErr } = await supabase
    .from("venues")
    .select("id, name")
    .eq("contact_method", "email")
    .or("hubspot_contact_id.is.null,hubspot_deal_id.is.null");
  if (missingErr) throw new Error(missingErr.message);
  if (missing?.length) {
    throw new Error(
      `${missing.length} venue(s) missing HubSpot IDs: ${missing.map((v) => v.name).join(", ")}`,
    );
  }
  const { count: venueCount } = await supabase
    .from("venues")
    .select("id", { count: "exact", head: true })
    .eq("contact_method", "email");
  console.log(`  ok: ${venueCount ?? "?"} email venues have contact + deal IDs`);

  console.log("2) Idempotent claim (same email_id twice)…");
  const testId = `day2-exit-test-${Date.now()}`;
  const payload: UnipileEmailWebhook = {
    email_id: testId,
    event: "mail_received",
    role: "inbox",
    folders: ["INBOX"],
    subject: "Day 2 exit test",
    from_attendee: { identifier: "exit-test@example.com" },
    thread_id: `thread-${testId}`,
  };

  const first = await claimInboundMessage(supabase, payload);
  const second = await claimInboundMessage(supabase, payload);

  if (!first.ok || first.duplicate) {
    throw new Error(`first claim unexpected: ${JSON.stringify(first)}`);
  }
  if (!second.ok || !second.duplicate) {
    throw new Error(`second claim unexpected: ${JSON.stringify(second)}`);
  }

  const { count: rowCount, error: countErr } = await supabase
    .from("inbound_messages")
    .select("message_id", { count: "exact", head: true })
    .eq("message_id", testId);
  if (countErr) throw new Error(countErr.message);
  if (rowCount !== 1) {
    throw new Error(`expected 1 inbound row, got ${rowCount}`);
  }

  const { count: eventCount, error: eventErr } = await supabase
    .from("pipeline_events")
    .select("id", { count: "exact", head: true })
    .eq("message_id", testId)
    .eq("event", "inbound_received");
  if (eventErr) throw new Error(eventErr.message);
  if (eventCount !== 1) {
    throw new Error(`expected 1 pipeline_events row, got ${eventCount}`);
  }

  // Cleanup test rows
  await supabase.from("pipeline_events").delete().eq("message_id", testId);
  await supabase.from("inbound_messages").delete().eq("message_id", testId);

  console.log("  ok: duplicate delivery → one inbound_messages row + one event");
  console.log("\nAll Day 2 exit checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
