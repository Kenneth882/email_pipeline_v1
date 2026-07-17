import { hs } from "@/lib/crm/hubspot";

type HsDeal = {
  id: string;
  properties: { dealstage?: string; pipeline?: string };
};

type Pipeline = {
  id: string;
  label: string;
  stages: Array<{ id: string; label: string }>;
};

export const STAGE_LABELS: Record<string, string[]> = {
  "0_sourced": ["0 sourced", "0_sourced"],
  "1_contacted": ["1 contacted", "1_contacted"],
  "2_responded": ["2 responded", "2_responded"],
  "3_in_icp": ["3 in icp", "3_in_icp"],
  "4_proposal_received": ["4 proposal received", "4_proposal_received"],
  "5_partnership_interest": [
    "5 partnership interest",
    "5_partnership_interest",
  ],
  "6_call_scheduled": ["6 call scheduled", "6_call_scheduled"],
  "7_call_completed": ["7 call completed", "7_call_completed"],
  "8_onboarded": ["8 onboarded", "8_onboarded"],
  lost: ["lost"],
  bounced: ["bounced"],
  needs_review: ["needs review", "needs_review"],
};

export type StageCacheKey = keyof typeof STAGE_LABELS;

/** Forward funnel order (index used for whitelist forward checks). */
const FUNNEL_ORDER: StageCacheKey[] = [
  "0_sourced",
  "1_contacted",
  "2_responded",
  "3_in_icp",
  "4_proposal_received",
  "5_partnership_interest",
  "6_call_scheduled",
  "7_call_completed",
  "8_onboarded",
];

const CLOSED: StageCacheKey[] = ["lost", "bounced", "needs_review"];

let pipelineCache: Pipeline[] | null = null;

async function listPipelines(): Promise<Pipeline[]> {
  if (pipelineCache) return pipelineCache;
  const data = await hs<{ results: Pipeline[] }>(
    "GET",
    "/crm/v3/pipelines/deals",
  );
  pipelineCache = data.results ?? [];
  return pipelineCache;
}

/** Clear cached pipelines (tests). */
export function clearPipelineCache(): void {
  pipelineCache = null;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

export function funnelIndex(key: string | null | undefined): number {
  if (!key) return -1;
  return FUNNEL_ORDER.indexOf(key as StageCacheKey);
}

/**
 * Pure whitelist: forward funnel moves, or jumps to closed variants.
 * Same stage is always allowed (no-op).
 */
export function isTransitionAllowed(
  from: string | null,
  to: StageCacheKey,
): boolean {
  if (!from) return true;
  if (from === to) return true;

  if (CLOSED.includes(to)) return true;

  const fromIdx = funnelIndex(from);
  const toIdx = funnelIndex(to);
  if (fromIdx < 0 || toIdx < 0) return false;

  // Allow forward or same-depth lateral within funnel (e.g. 2→3, 2→4)
  return toIdx >= fromIdx;
}

export async function resolveStageId(
  cacheKey: StageCacheKey,
): Promise<{ pipelineId: string; stageId: string; label: string }> {
  const want = STAGE_LABELS[cacheKey];
  const pipelines = await listPipelines();
  for (const p of pipelines) {
    for (const s of p.stages) {
      const n = normalizeLabel(s.label);
      if (want.some((w) => n === w)) {
        return { pipelineId: p.id, stageId: s.id, label: s.label };
      }
    }
  }
  throw new Error(`HubSpot stage not found for ${cacheKey}`);
}

export async function getDealStage(dealId: string): Promise<{
  stageId: string;
  pipelineId: string | null;
  cacheKey: string | null;
}> {
  const deal = await hs<HsDeal>(
    "GET",
    `/crm/v3/objects/deals/${dealId}?properties=dealstage,pipeline`,
  );
  const stageId = deal.properties.dealstage ?? "";
  const pipelineId = deal.properties.pipeline ?? null;

  const pipelines = await listPipelines();
  let cacheKey: string | null = null;
  for (const p of pipelines) {
    const stage = p.stages.find((s) => s.id === stageId);
    if (!stage) continue;
    const n = normalizeLabel(stage.label);
    for (const [key, labels] of Object.entries(STAGE_LABELS)) {
      if (labels.some((l) => n === l)) {
        cacheKey = key;
        break;
      }
    }
  }

  return { stageId, pipelineId, cacheKey };
}

export type AdvanceDealResult = {
  ok: boolean;
  fromCache: string | null;
  hubspotCacheKey: string | null;
  conflict: boolean;
  movedTo: string | null;
  error?: string;
};

/**
 * Advance deal to target with HubSpot-authoritative reconciliation.
 * Illegal transitions → Needs Review.
 */
export async function advanceDealStage(opts: {
  dealId: string;
  stageCache: string | null;
  target: StageCacheKey;
}): Promise<AdvanceDealResult> {
  const fresh = await getDealStage(opts.dealId);
  const fromCache = opts.stageCache;
  const conflict =
    !!fromCache && !!fresh.cacheKey && fromCache !== fresh.cacheKey;

  const effective = fresh.cacheKey ?? fromCache ?? "0_sourced";

  if (effective === opts.target) {
    return {
      ok: true,
      fromCache,
      hubspotCacheKey: fresh.cacheKey,
      conflict,
      movedTo: opts.target,
    };
  }

  const allowed = isTransitionAllowed(effective, opts.target);
  const writeTo: StageCacheKey = allowed ? opts.target : "needs_review";

  try {
    const stage = await resolveStageId(writeTo);
    await hs("PATCH", `/crm/v3/objects/deals/${opts.dealId}`, {
      properties: {
        dealstage: stage.stageId,
        pipeline: stage.pipelineId,
      },
    });

    if (!allowed) {
      return {
        ok: false,
        fromCache,
        hubspotCacheKey: fresh.cacheKey,
        conflict,
        movedTo: "needs_review",
        error: `illegal_transition_from_${effective}_to_${opts.target}`,
      };
    }

    return {
      ok: true,
      fromCache,
      hubspotCacheKey: fresh.cacheKey,
      conflict,
      movedTo: writeTo,
    };
  } catch (err) {
    return {
      ok: false,
      fromCache,
      hubspotCacheKey: fresh.cacheKey,
      conflict,
      movedTo: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Advance deal 0_sourced → 1_contacted (drip). Thin wrapper over advanceDealStage.
 */
export async function advanceToContacted(opts: {
  dealId: string;
  stageCache: string | null;
}): Promise<AdvanceDealResult> {
  return advanceDealStage({
    dealId: opts.dealId,
    stageCache: opts.stageCache,
    target: "1_contacted",
  });
}
