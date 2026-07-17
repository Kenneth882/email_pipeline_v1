export type IcpExtracted = {
  min_spend_usd?: number | null;
  fully_private?: boolean | null;
  capacity_ok?: boolean | null;
};

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
  return min_spend_usd <= 4200 && fully_private === true && capacity_ok === true;
}
