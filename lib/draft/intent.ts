import {
  analyzeIcp,
  STATED_BUDGET_USD,
  type IcpField,
} from "@/lib/crm/icp";
import {
  estimateAllInSpend,
  type SpendEstimate,
} from "@/lib/crm/pricing";
import { EVENT_BRIEF } from "@/lib/event-brief";
import type { TriageResult } from "@/lib/triage/schema";

export type ReplyIntent =
  | "confirm_fit"
  | "ask_missing"
  | "negotiate"
  | "close_lost";

export type ReplyIntentResult = {
  intent: ReplyIntent | null;
  missing: IcpField[];
  dateConflict: boolean;
  draftable: boolean;
  spendEstimate: SpendEstimate;
  effectiveSpendUsd: number | null;
};

const DATE_CONFLICT_RE =
  /\b(not available|fully booked|another date|different date|unavailable that (day|night|date)|can't do august|cannot do august)\b/i;

function normalizeDateToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** True when venue dates don't include primary day, or key_details signal unavailability. */
export function detectDateConflict(extracted: {
  proposed_dates?: string[];
  key_details?: string[];
}): boolean {
  const details = extracted.key_details ?? [];
  if (details.some((d) => DATE_CONFLICT_RE.test(d))) return true;

  const proposed = extracted.proposed_dates ?? [];
  if (proposed.length === 0) return false;

  const primary = normalizeDateToken(EVENT_BRIEF.primaryDateKey);
  return !proposed.some((d) => {
    const n = normalizeDateToken(d);
    return n.includes(primary) || primary.includes(n);
  });
}

/**
 * Deterministic reply intent from triage output.
 * When all-in is computable, effective spend (not just F&B min) gates bands.
 * close_lost is never draftable.
 */
export function resolveReplyIntent(triage: TriageResult): ReplyIntentResult {
  const spendEstimate = estimateAllInSpend(triage.extracted);
  const effectiveSpendUsd = spendEstimate.usedForGating
    ? spendEstimate.estimated_all_in_usd
    : typeof triage.extracted.min_spend_usd === "number"
      ? triage.extracted.min_spend_usd
      : null;

  const analysis = analyzeIcp(triage.extracted, { effectiveSpendUsd });
  const dateConflict = detectDateConflict(triage.extracted);

  const base = {
    missing: analysis.missing,
    dateConflict,
    spendEstimate,
    effectiveSpendUsd: analysis.effectiveSpendUsd,
  };

  // Hard commercial / rejection fails win over needs_review (stage + no draft).
  if (triage.classification === "rejection" || analysis.hardFail) {
    return {
      ...base,
      intent: "close_lost",
      draftable: false,
    };
  }

  if (
    triage.classification === "auto_reply" ||
    triage.classification === "bounce" ||
    triage.classification === "contract" ||
    triage.classification === "out_of_scope" ||
    triage.needs_human_review ||
    triage.confidence < 0.7
  ) {
    return {
      ...base,
      intent: null,
      draftable: false,
    };
  }

  if (analysis.missing.length > 0) {
    return {
      ...base,
      intent: "ask_missing",
      draftable: true,
    };
  }

  if (analysis.verdict && (analysis.negotiatePrice || dateConflict)) {
    return {
      ...base,
      intent: "negotiate",
      draftable: true,
    };
  }

  if (
    analysis.verdict &&
    typeof analysis.effectiveSpendUsd === "number" &&
    analysis.effectiveSpendUsd <= STATED_BUDGET_USD
  ) {
    return {
      ...base,
      intent: "confirm_fit",
      draftable: true,
    };
  }

  // Full fields but ICP false without hardFail shouldn't happen often;
  // treat as ask_missing for safety if private/capacity somehow false-null mix.
  if (!analysis.verdict) {
    return {
      ...base,
      intent: "ask_missing",
      draftable: true,
    };
  }

  return {
    ...base,
    intent: "confirm_fit",
    draftable: true,
  };
}

export function isDraftableIntent(
  intent: ReplyIntent | null,
): intent is "confirm_fit" | "ask_missing" | "negotiate" {
  return (
    intent === "confirm_fit" ||
    intent === "ask_missing" ||
    intent === "negotiate"
  );
}
