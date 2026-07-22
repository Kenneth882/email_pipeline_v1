/**
 * One-off: re-run CRM Writer + Drafting Agent for an already-triaged inbound.
 * Does NOT re-call Claude triage.
 *
 * Usage:
 *   MESSAGE_ID=gqThWtVqUEmeZoFdy6psVw npm run reprocess:inbound
 */

import { createClient } from "@supabase/supabase-js";
import { runCrmWriter } from "../lib/crm/writer";
import { clearPipelineCache } from "../lib/crm/stage";
import { runDraftingAgent } from "../lib/draft/agent";
import { triageResultSchema } from "../lib/triage/schema";

async function main() {
  const messageId = (process.env.MESSAGE_ID ?? "").trim();
  if (!messageId) {
    throw new Error("Set MESSAGE_ID=<unipile email id>");
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase env");

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  clearPipelineCache();

  const { data: inbound, error: loadErr } = await supabase
    .from("inbound_messages")
    .select(
      "message_id, thread_id, venue_id, sender_email, match_confidence, classification, extraction, confidence, needs_human_review, reply_required",
    )
    .eq("message_id", messageId)
    .maybeSingle();

  if (loadErr) throw new Error(loadErr.message);
  if (!inbound) throw new Error(`inbound not found: ${messageId}`);
  if (!inbound.venue_id) throw new Error("inbound has no venue_id");
  if (!inbound.classification || inbound.extraction == null) {
    throw new Error("inbound missing classification/extraction");
  }

  const { error: clearErr } = await supabase
    .from("inbound_messages")
    .update({
      needs_human_review: false,
      reply_required: true,
    })
    .eq("message_id", messageId);

  if (clearErr) throw new Error(clearErr.message);

  const triage = triageResultSchema.parse({
    thread_id: inbound.thread_id,
    classification: inbound.classification,
    extracted: inbound.extraction,
    confidence: Number(inbound.confidence ?? 0),
    needs_human_review: false,
    reply_required: true,
  });

  const match = {
    venueId: inbound.venue_id as string,
    confidence: (inbound.match_confidence ?? "HIGH") as
      | "HIGH"
      | "MEDIUM"
      | "NONE",
    tier: "thread" as const,
  };

  console.log("1) CRM Writer…", {
    message_id: messageId,
    venue_id: inbound.venue_id,
    classification: triage.classification,
  });

  const crm = await runCrmWriter({
    supabase,
    venueId: inbound.venue_id,
    messageId,
    threadId: inbound.thread_id,
    triage,
    match,
  });

  console.log("   CRM result:", crm);
  if (!crm.ok) {
    throw new Error(`CRM Writer failed: ${crm.error ?? "unknown"}`);
  }

  console.log("2) Drafting Agent…");
  const draft = await runDraftingAgent({
    supabase,
    venueId: inbound.venue_id,
    messageId,
    triage,
  });
  console.log("   Draft result:", draft);
  if (!draft.ok) {
    throw new Error(`Drafting Agent failed: ${draft.error ?? "unknown"}`);
  }

  const { data: venue } = await supabase
    .from("venues")
    .select("name, stage_cache")
    .eq("id", inbound.venue_id)
    .maybeSingle();

  const { data: draftEvent } = await supabase
    .from("pipeline_events")
    .select("id, detail, created_at")
    .eq("message_id", messageId)
    .eq("event", "draft_created")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  console.log("\nDone.");
  console.log("  venue:", venue?.name, "stage_cache:", venue?.stage_cache);
  console.log(
    "  draft_created:",
    draftEvent
      ? { id: draftEvent.id, at: draftEvent.created_at, detail: draftEvent.detail }
      : null,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
