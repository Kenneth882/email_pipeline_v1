import type { FeeStaff, VenueFees } from "@/lib/triage/schema";

export type IcpExtracted = {
  min_spend_usd?: number | null;
  fully_private?: boolean | null;
  capacity_ok?: boolean | null;
  /** Venue serves food in-house. Explicit false → Lost. */
  provides_food?: boolean | null;
};

/** Full triage extract shape used for cross-message ICP memory. */
export type ExtractedMemory = IcpExtracted & {
  contact_name?: string | null;
  proposed_dates?: string[];
  key_details?: string[];
  fees?: VenueFees | null;
};

export type IcpField = "min_spend_usd" | "fully_private" | "capacity_ok";

/** Hard ICP ceiling — above this is a commercial fail. */
export const ICP_MAX_SPEND_USD = 4200;

/** Stated outreach budget / confirm_fit ceiling. */
export const STATED_BUDGET_USD = 2000;

/**
 * Deterministic ICP: min_spend ≤ 4200 AND fully_private AND capacity_ok.
 * Any null/undefined field → false (escalate-don't-invent).
 * Stage / HubSpot still use F&B min_spend (not all-in).
 * provides_food is not required for a positive verdict; explicit false is a hard fail.
 */
export function computeIcpVerdict(extracted: IcpExtracted): boolean {
  const { min_spend_usd, fully_private, capacity_ok, provides_food } =
    extracted;
  if (
    min_spend_usd === null ||
    min_spend_usd === undefined ||
    fully_private === null ||
    fully_private === undefined ||
    capacity_ok === null ||
    capacity_ok === undefined
  ) {
    return false;
  }
  if (provides_food === false) return false;
  return (
    min_spend_usd <= ICP_MAX_SPEND_USD &&
    fully_private === true &&
    capacity_ok === true
  );
}

export function listMissingIcpFields(extracted: IcpExtracted): IcpField[] {
  const missing: IcpField[] = [];
  if (
    extracted.min_spend_usd === null ||
    extracted.min_spend_usd === undefined
  ) {
    missing.push("min_spend_usd");
  }
  if (
    extracted.fully_private === null ||
    extracted.fully_private === undefined
  ) {
    missing.push("fully_private");
  }
  if (extracted.capacity_ok === null || extracted.capacity_ok === undefined) {
    missing.push("capacity_ok");
  }
  return missing;
}

/**
 * Explicit commercial fail → Lost (beats Needs Review).
 * capacity false, spend over ceiling, not private, or no in-house food.
 */
export function isHardIcpFail(extracted: IcpExtracted): boolean {
  if (extracted.capacity_ok === false) return true;
  if (extracted.fully_private === false) return true;
  if (extracted.provides_food === false) return true;
  if (
    typeof extracted.min_spend_usd === "number" &&
    extracted.min_spend_usd > ICP_MAX_SPEND_USD
  ) {
    return true;
  }
  return false;
}

export type IcpAnalysis = {
  verdict: boolean;
  missing: IcpField[];
  hardFail: boolean;
  /** True when full ICP fields pass but effective spend is above stated budget. */
  negotiatePrice: boolean;
  /** Spend used for intent bands (all-in when computable, else F&B min). */
  effectiveSpendUsd: number | null;
};

/**
 * Analyze ICP + intent spend bands.
 * Pass effectiveSpendUsd from estimateAllInSpend when available.
 */
export function analyzeIcp(
  extracted: IcpExtracted,
  opts?: { effectiveSpendUsd?: number | null },
): IcpAnalysis {
  const missing = listMissingIcpFields(extracted);
  const effectiveSpendUsd =
    typeof opts?.effectiveSpendUsd === "number"
      ? opts.effectiveSpendUsd
      : typeof extracted.min_spend_usd === "number"
        ? extracted.min_spend_usd
        : null;

  const hardFailOnSpend =
    typeof effectiveSpendUsd === "number" &&
    effectiveSpendUsd > ICP_MAX_SPEND_USD;
  const hardFail =
    hardFailOnSpend ||
    isHardIcpFail(extracted);

  // Verdict for privacy/capacity + F&B still uses HubSpot-facing min_spend,
  // but when effective spend hard-fails we treat commercial fit as failed.
  const baseVerdict = computeIcpVerdict(extracted);
  const verdict =
    baseVerdict &&
    !hardFailOnSpend &&
    (typeof effectiveSpendUsd !== "number" ||
      effectiveSpendUsd <= ICP_MAX_SPEND_USD);

  const negotiatePrice =
    verdict &&
    typeof effectiveSpendUsd === "number" &&
    effectiveSpendUsd > STATED_BUDGET_USD;

  return {
    verdict,
    missing,
    hardFail,
    negotiatePrice,
    effectiveSpendUsd,
  };
}

function isPresent<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined;
}

function mergeKeyDetails(prior: string[], current: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of [...prior, ...current]) {
    const key = d.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(d.trim());
  }
  return out;
}

function mergeNullableField<T>(
  prior: T | null | undefined,
  current: T | null | undefined,
): T | null {
  if (isPresent(current)) return current;
  if (isPresent(prior)) return prior;
  return null;
}

function mergeStaff(
  prior: FeeStaff[] | null | undefined,
  current: FeeStaff[] | null | undefined,
): FeeStaff[] | null {
  if (current && current.length > 0) return current.map((s) => ({ ...s }));
  if (prior && prior.length > 0) return prior.map((s) => ({ ...s }));
  return null;
}

/** Deep-merge fees: current non-null wins per field; staff replaced when current provides rows. */
export function mergeFees(
  prior: VenueFees | null | undefined,
  current: VenueFees | null | undefined,
): VenueFees | null {
  if (!prior && !current) return null;
  const p = prior ?? {};
  const c = current ?? {};
  const merged: VenueFees = {
    fb_minimum_usd: mergeNullableField(p.fb_minimum_usd, c.fb_minimum_usd),
    room_rental_usd: mergeNullableField(p.room_rental_usd, c.room_rental_usd),
    after_hours_usd_per_hour: mergeNullableField(
      p.after_hours_usd_per_hour,
      c.after_hours_usd_per_hour,
    ),
    venue_close_hour_local: mergeNullableField(
      p.venue_close_hour_local,
      c.venue_close_hour_local,
    ),
    staff: mergeStaff(p.staff, c.staff),
    sales_tax_pct: mergeNullableField(p.sales_tax_pct, c.sales_tax_pct),
    processing_fee_pct: mergeNullableField(
      p.processing_fee_pct,
      c.processing_fee_pct,
    ),
    gratuity_pct: mergeNullableField(p.gratuity_pct, c.gratuity_pct),
    gratuity_mandatory: mergeNullableField(
      p.gratuity_mandatory,
      c.gratuity_mandatory,
    ),
    building_fees_unknown: mergeNullableField(
      p.building_fees_unknown,
      c.building_fees_unknown,
    ),
  };
  const hasAny = Object.values(merged).some((v) => v !== null && v !== undefined);
  return hasAny ? merged : null;
}

/**
 * Merge prior thread extract with the latest message extract.
 * Current non-null wins; explicit false / new numbers always win; null keeps prior.
 */
export function mergeIcpExtracted(
  prior: ExtractedMemory,
  current: ExtractedMemory,
): ExtractedMemory {
  const priorDates = prior.proposed_dates ?? [];
  const currentDates = current.proposed_dates ?? [];
  const priorDetails = prior.key_details ?? [];
  const currentDetails = current.key_details ?? [];

  return {
    min_spend_usd: isPresent(current.min_spend_usd)
      ? current.min_spend_usd
      : (prior.min_spend_usd ?? null),
    fully_private: isPresent(current.fully_private)
      ? current.fully_private
      : (prior.fully_private ?? null),
    capacity_ok: isPresent(current.capacity_ok)
      ? current.capacity_ok
      : (prior.capacity_ok ?? null),
    provides_food: isPresent(current.provides_food)
      ? current.provides_food
      : (prior.provides_food ?? null),
    contact_name: isPresent(current.contact_name)
      ? current.contact_name
      : (prior.contact_name ?? null),
    proposed_dates:
      currentDates.length > 0 ? [...currentDates] : [...priorDates],
    key_details: mergeKeyDetails(priorDetails, currentDetails),
    fees: mergeFees(prior.fees, current.fees),
  };
}

/** Fold chronologically ordered extracts (oldest → newest). */
export function foldExtractions(
  extracts: ExtractedMemory[],
): ExtractedMemory {
  return extracts.reduce<ExtractedMemory>(
    (acc, next) => mergeIcpExtracted(acc, next),
    {},
  );
}

/** Human-readable known ICP facts for draft prompts (do not re-ask). */
export function formatKnownFacts(extracted: ExtractedMemory): string {
  const lines: string[] = [];
  if (isPresent(extracted.fully_private)) {
    lines.push(`fully_private: ${extracted.fully_private}`);
  }
  if (isPresent(extracted.capacity_ok)) {
    lines.push(`capacity_ok: ${extracted.capacity_ok}`);
  }
  if (isPresent(extracted.provides_food)) {
    lines.push(`provides_food: ${extracted.provides_food}`);
  }
  if (isPresent(extracted.min_spend_usd)) {
    lines.push(`min_spend_usd: ${extracted.min_spend_usd}`);
  }
  const roomRental = extracted.fees?.room_rental_usd;
  if (isPresent(roomRental)) {
    lines.push(`room_rental_usd: ${roomRental}`);
  }
  if (isPresent(extracted.contact_name) && extracted.contact_name.trim()) {
    lines.push(`contact_name: ${extracted.contact_name}`);
  }
  const dates = extracted.proposed_dates ?? [];
  if (dates.length) {
    lines.push(`proposed_dates: ${dates.join("; ")}`);
  }
  const details = extracted.key_details ?? [];
  if (details.length) {
    lines.push(`key_details: ${details.join(" | ")}`);
  }
  return lines.length ? lines.join("\n") : "(none yet)";
}
