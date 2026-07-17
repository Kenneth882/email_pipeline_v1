import {
  ICP_MAX_SPEND_USD,
  STATED_BUDGET_USD,
} from "@/lib/crm/icp";

/**
 * Canonical event facts for drip outreach + drafting playbooks.
 * Numbers must stay in sync with ICP helpers.
 */
export const EVENT_BRIEF = {
  primaryDateLabel: "Wednesday, August 12th from 6–9pm",
  /** Normalized key used for date-conflict checks. */
  primaryDateKey: "august 12",
  guestCountLabel: "70–80",
  standing: true,
  fullyPrivate: true,
  statedBudgetUsd: STATED_BUDGET_USD,
  icpMaxSpendUsd: ICP_MAX_SPEND_USD,
  foodBudgetUsd: 1200,
  barTabUsd: 800,
  alternateDateWindows: [
    "Thursday, August 13th from 6–9pm",
    "Wednesday, August 19th from 6–9pm",
  ] as const,
  signerName: "Kenneth",
} as const;

export function formatStatedBudget(): string {
  return `$${Math.round(EVENT_BRIEF.statedBudgetUsd / 100) / 10}k`;
}
