import type { SupabaseClient } from "@supabase/supabase-js";
import { updateContactProperties } from "@/lib/crm/hubspot";
import {
  computeIcpVerdict,
  ICP_MAX_SPEND_USD,
  isHardIcpFail,
} from "@/lib/crm/icp";
import type { MatchResult } from "@/lib/crm/match";
import { estimateAllInSpend, type SpendEstimate } from "@/lib/crm/pricing";
import {
  advanceDealStage,
  type StageCacheKey,
} from "@/lib/crm/stage";
import type { TriageResult } from "@/lib/triage/schema";

export type CrmWriterResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  icpVerdict?: boolean;
  targetStage?: StageCacheKey | null;
  movedTo?: string | null;
  conflict?: boolean;
  error?: string;
};

function allInHardFail(estimate: SpendEstimate): boolean {
  return (
    estimate.usedForGating &&
    typeof estimate.estimated_all_in_usd === "number" &&
    estimate.estimated_all_in_usd > ICP_MAX_SPEND_USD
  );
}

/**
 * Map triage classification → HubSpot stage target.
 * Returns null when no stage write should happen (auto_reply).
 * All-in > ICP ceiling → lost (same as F&B hard fail for commercial fit).
 */
export function resolveTargetStage(
  triage: TriageResult,
  icpVerdict: boolean,
  spendEstimate?: SpendEstimate,
): StageCacheKey | null {
  if (triage.classification === "auto_reply") return null;

  if (triage.classification === "bounce") return "bounced";
  if (triage.classification === "rejection") return "lost";
  if (isHardIcpFail(triage.extracted)) return "lost";
  const estimate = spendEstimate ?? estimateAllInSpend(triage.extracted);
  if (allInHardFail(estimate)) return "lost";

  if (
    triage.classification === "contract" ||
    triage.needs_human_review ||
    triage.classification === "out_of_scope"
  ) {
    return "needs_review";
  }

  if (triage.classification === "proposal") return "4_proposal_received";
  if (triage.classification === "partnership_interest") {
    return "5_partnership_interest";
  }

  if (
    triage.classification === "pricing_info" ||
    triage.classification === "question"
  ) {
    return icpVerdict ? "3_in_icp" : "2_responded";
  }

  return "needs_review";
}

export function buildReviewReason(
  triage: TriageResult,
  spendEstimate?: SpendEstimate,
): string {
  const estimate = spendEstimate ?? estimateAllInSpend(triage.extracted);
  if (allInHardFail(estimate)) return "all_in_above_icp";
  if (triage.classification === "contract") return "contract_firewall";
  if (triage.classification === "bounce") return "bounce";
  if (triage.classification === "out_of_scope") return "out_of_scope";
  if (triage.confidence < 0.7) return "low_confidence";
  if (triage.needs_human_review) return "needs_human_review";
  return "";
}

/**
 * Dual-write HubSpot contact props + deal stage after triage finalize.
 * Drafting Agent is invoked by inbound process when reply intent is draftable.
 */
export async function runCrmWriter(opts: {
  supabase: SupabaseClient;
  venueId: string;
  messageId: string;
  threadId: string;
  triage: TriageResult;
  match: MatchResult;
}): Promise<CrmWriterResult> {
  const { supabase, venueId, messageId, threadId, triage, match } = opts;

  if (match.confidence === "NONE" || !venueId) {
    return { ok: true, skipped: true, reason: "no_venue" };
  }

  const { data: venue, error: venueErr } = await supabase
    .from("venues")
    .select(
      "id, hubspot_contact_id, hubspot_deal_id, stage_cache, name",
    )
    .eq("id", venueId)
    .maybeSingle();

  if (venueErr) {
    return { ok: false, error: venueErr.message };
  }
  if (!venue) {
    return { ok: false, error: "venue_not_found" };
  }
  if (!venue.hubspot_contact_id || !venue.hubspot_deal_id) {
    await supabase.from("pipeline_events").insert({
      venue_id: venueId,
      message_id: messageId,
      actor: "crm",
      event: "error",
      detail: { error: "missing_hubspot_ids" },
    });
    return { ok: false, error: "missing_hubspot_ids" };
  }

  const icpVerdict = computeIcpVerdict(triage.extracted);
  const spendEstimate = estimateAllInSpend(triage.extracted);
  const reviewReason = buildReviewReason(triage, spendEstimate);
  const targetStage = resolveTargetStage(triage, icpVerdict, spendEstimate);
  const needsReview =
    triage.needs_human_review || allInHardFail(spendEstimate);

  const keyDetailLines = [...(triage.extracted.key_details ?? [])];
  if (spendEstimate.usedForGating) {
    keyDetailLines.push(`spend_estimate: ${spendEstimate.breakdown}`);
  }

  try {
    await updateContactProperties(venue.hubspot_contact_id, {
      icp_verdict: icpVerdict,
      min_spend_usd: triage.extracted.min_spend_usd ?? null,
      fully_private: triage.extracted.fully_private ?? null,
      capacity_ok: triage.extracted.capacity_ok ?? null,
      needs_review: needsReview,
      review_reason: reviewReason || null,
      key_details: keyDetailLines.join("\n") || null,
      thread_id: threadId,
      last_classification: triage.classification,
    });

    let stageResult: {
      ok: boolean;
      conflict: boolean;
      movedTo: string | null;
      error?: string;
      fromCache: string | null;
      hubspotCacheKey: string | null;
    } | null = null;

    if (targetStage !== null) {
      stageResult = await advanceDealStage({
        dealId: venue.hubspot_deal_id,
        stageCache: venue.stage_cache,
        target: targetStage,
      });

      if (stageResult.conflict) {
        await supabase.from("pipeline_events").insert({
          venue_id: venueId,
          message_id: messageId,
          actor: "crm",
          event: "stage_conflict",
          detail: {
            stage_cache: venue.stage_cache,
            hubspot: stageResult.hubspotCacheKey,
            target: targetStage,
            movedTo: stageResult.movedTo,
          },
        });
      }

      if (stageResult.movedTo) {
        await supabase
          .from("venues")
          .update({
            stage_cache: stageResult.movedTo,
            updated_at: new Date().toISOString(),
          })
          .eq("id", venueId);
      }

      if (!stageResult.ok && stageResult.error) {
        await supabase.from("pipeline_events").insert({
          venue_id: venueId,
          message_id: messageId,
          actor: "crm",
          event: "error",
          detail: {
            error: stageResult.error,
            target: targetStage,
            movedTo: stageResult.movedTo,
          },
        });
      }
    }

    await supabase.from("pipeline_events").insert({
      venue_id: venueId,
      message_id: messageId,
      actor: "crm",
      event: "crm_written",
      detail: {
        classification: triage.classification,
        icp_verdict: icpVerdict,
        target_stage: targetStage,
        moved_to: stageResult?.movedTo ?? null,
        conflict: stageResult?.conflict ?? false,
        match_confidence: match.confidence,
        match_tier: match.tier,
        spend_estimate: spendEstimate,
      },
    });

    return {
      ok: stageResult ? stageResult.ok || stageResult.movedTo === "needs_review" : true,
      icpVerdict,
      targetStage,
      movedTo: stageResult?.movedTo ?? null,
      conflict: stageResult?.conflict ?? false,
      error: stageResult?.error,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase.from("pipeline_events").insert({
      venue_id: venueId,
      message_id: messageId,
      actor: "crm",
      event: "error",
      detail: { error: msg },
    });
    return { ok: false, error: msg };
  }
}
