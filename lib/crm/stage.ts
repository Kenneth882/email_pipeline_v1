type HsDeal = {
  id: string;
  properties: { dealstage?: string; pipeline?: string };
};

type Pipeline = {
  id: string;
  label: string;
  stages: Array<{ id: string; label: string }>;
};

const STAGE_LABELS: Record<string, string[]> = {
  "0_sourced": ["0 sourced", "0_sourced"],
  "1_contacted": ["1 contacted", "1_contacted"],
  needs_review: ["needs review", "needs_review"],
};

let pipelineCache: Pipeline[] | null = null;

async function hs<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error("Missing HUBSPOT_ACCESS_TOKEN");

  const res = await fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`HubSpot ${method} ${path} → ${res.status}: ${text}`);
  }
  return json as T;
}

async function listPipelines(): Promise<Pipeline[]> {
  if (pipelineCache) return pipelineCache;
  const data = await hs<{ results: Pipeline[] }>(
    "GET",
    "/crm/v3/pipelines/deals",
  );
  pipelineCache = data.results ?? [];
  return pipelineCache;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function resolveStageId(
  cacheKey: keyof typeof STAGE_LABELS,
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

/**
 * Advance deal 0_sourced → 1_contacted with HubSpot-authoritative reconciliation.
 * Illegal / unexpected transitions → Needs Review.
 */
export async function advanceToContacted(opts: {
  dealId: string;
  stageCache: string | null;
}): Promise<{
  ok: boolean;
  fromCache: string | null;
  hubspotCacheKey: string | null;
  conflict: boolean;
  movedTo: string | null;
  error?: string;
}> {
  const fresh = await getDealStage(opts.dealId);
  const fromCache = opts.stageCache;
  const conflict =
    !!fromCache &&
    !!fresh.cacheKey &&
    fromCache !== fresh.cacheKey;

  const effective = fresh.cacheKey ?? fromCache ?? "0_sourced";

  if (effective === "1_contacted") {
    return {
      ok: true,
      fromCache,
      hubspotCacheKey: fresh.cacheKey,
      conflict,
      movedTo: "1_contacted",
    };
  }

  if (effective !== "0_sourced") {
    try {
      const needs = await resolveStageId("needs_review");
      await hs("PATCH", `/crm/v3/objects/deals/${opts.dealId}`, {
        properties: {
          dealstage: needs.stageId,
          pipeline: needs.pipelineId,
        },
      });
      return {
        ok: false,
        fromCache,
        hubspotCacheKey: fresh.cacheKey,
        conflict,
        movedTo: "needs_review",
        error: `illegal_transition_from_${effective}`,
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

  const contacted = await resolveStageId("1_contacted");
  await hs("PATCH", `/crm/v3/objects/deals/${opts.dealId}`, {
    properties: {
      dealstage: contacted.stageId,
      pipeline: contacted.pipelineId,
    },
  });

  return {
    ok: true,
    fromCache,
    hubspotCacheKey: fresh.cacheKey,
    conflict,
    movedTo: "1_contacted",
  };
}
