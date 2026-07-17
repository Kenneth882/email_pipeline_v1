export type IcpExtracted = {
  min_spend_usd?: number | null;
  fully_private?: boolean | null;
  capacity_ok?: boolean | null;
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
