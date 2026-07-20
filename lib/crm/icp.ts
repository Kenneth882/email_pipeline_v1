export type IcpExtracted = {
  min_spend_usd?: number | null;
  fully_private?: boolean | null;
  capacity_ok?: boolean | null;
};

/** Full triage extract shape used for cross-message ICP memory. */
export type ExtractedMemory = IcpExtracted & {
  contact_name?: string | null;
  proposed_dates?: string[];
  key_details?: string[];
};

export type IcpField = "min_spend_usd" | "fully_private" | "capacity_ok";

/** Hard ICP ceiling — above this is a commercial fail. */
export const ICP_MAX_SPEND_USD = 4200;

/** Stated outreach budget / confirm_fit ceiling. */
export const STATED_BUDGET_USD = 2000;

/**
 * Deterministic ICP: min_spend ≤ 4200 AND fully_private AND capacity_ok.
 * Any null/undefined field → false (escalate-don't-invent).
 */
export function computeIcpVerdict(extracted: IcpExtracted): boolean {
  const { min_spend_usd, fully_private, capacity_ok } = extracted;
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

/** Explicit commercial fail: no capacity or spend above ICP ceiling. */
export function isHardIcpFail(extracted: IcpExtracted): boolean {
  if (extracted.capacity_ok === false) return true;
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
  /** True when full ICP passes but spend is above stated budget. */
  negotiatePrice: boolean;
};

export function analyzeIcp(extracted: IcpExtracted): IcpAnalysis {
  const missing = listMissingIcpFields(extracted);
  const hardFail = isHardIcpFail(extracted);
  const verdict = computeIcpVerdict(extracted);
  const negotiatePrice =
    verdict &&
    typeof extracted.min_spend_usd === "number" &&
    extracted.min_spend_usd > STATED_BUDGET_USD;
  return { verdict, missing, hardFail, negotiatePrice };
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
    contact_name: isPresent(current.contact_name)
      ? current.contact_name
      : (prior.contact_name ?? null),
    proposed_dates:
      currentDates.length > 0 ? [...currentDates] : [...priorDates],
    key_details: mergeKeyDetails(priorDetails, currentDetails),
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
  if (isPresent(extracted.min_spend_usd)) {
    lines.push(`min_spend_usd: ${extracted.min_spend_usd}`);
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
