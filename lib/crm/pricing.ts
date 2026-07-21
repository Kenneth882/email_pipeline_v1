import { EVENT_BRIEF } from "@/lib/event-brief";
import type { ExtractedMemory } from "@/lib/crm/icp";
import type { VenueFees } from "@/lib/triage/schema";

export type SpendEstimate = {
  /** F&B / buyout minimum used as base. */
  fb_usd: number | null;
  labor_usd: number;
  after_hours_usd: number;
  after_hours_hours: number;
  subtotal_usd: number | null;
  /** All-in used for intent gating (excludes optional tip; includes mandatory tip). */
  estimated_all_in_usd: number | null;
  optional_gratuity_usd: number | null;
  usedForGating: boolean;
  incomplete: boolean;
  assumed_venue_close: boolean;
  notes: string[];
  /** Human-readable breakdown for playbook / pipeline_events. */
  breakdown: string;
};

const DEFAULT_VENUE_CLOSE_HOUR = 19;

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatUsd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/**
 * Deterministic all-in spend from structured fees + F&B min.
 * Lower-bound for gating: optional gratuity excluded unless mandatory.
 */
export function estimateAllInSpend(
  extracted: Pick<ExtractedMemory, "min_spend_usd" | "fees">,
): SpendEstimate {
  const fees: VenueFees = extracted.fees ?? {};
  const notes: string[] = [];
  let assumed_venue_close = false;
  let incomplete = false;

  const fb =
    typeof fees.fb_minimum_usd === "number"
      ? fees.fb_minimum_usd
      : typeof extracted.min_spend_usd === "number"
        ? extracted.min_spend_usd
        : null;

  const eventHours =
    EVENT_BRIEF.eventEndHourLocal - EVENT_BRIEF.eventStartHourLocal;

  let labor_usd = 0;
  const staff = fees.staff ?? [];
  for (const row of staff) {
    const hours = Math.max(row.min_hours, eventHours);
    labor_usd += row.count * row.rate_usd_per_hour * hours;
  }
  labor_usd = roundCents(labor_usd);

  let after_hours_hours = 0;
  let after_hours_usd = 0;
  if (typeof fees.after_hours_usd_per_hour === "number") {
    let close = fees.venue_close_hour_local;
    if (typeof close !== "number") {
      close = DEFAULT_VENUE_CLOSE_HOUR;
      assumed_venue_close = true;
      notes.push(
        `assumed venue close ${DEFAULT_VENUE_CLOSE_HOUR}:00 for after-hours math`,
      );
    }
    after_hours_hours = Math.max(0, EVENT_BRIEF.eventEndHourLocal - close);
    after_hours_usd = roundCents(
      fees.after_hours_usd_per_hour * after_hours_hours,
    );
  }

  if (fees.building_fees_unknown === true) {
    incomplete = true;
    notes.push("building/landlord fees unknown — excluded from estimate");
  }

  if (fb === null) {
    return {
      fb_usd: null,
      labor_usd,
      after_hours_usd,
      after_hours_hours,
      subtotal_usd: null,
      estimated_all_in_usd: null,
      optional_gratuity_usd: null,
      usedForGating: false,
      incomplete: incomplete || labor_usd > 0 || after_hours_usd > 0,
      assumed_venue_close,
      notes,
      breakdown: "(no F&B minimum — cannot estimate all-in)",
    };
  }

  const subtotal = roundCents(fb + labor_usd + after_hours_usd);
  let withFees = subtotal;
  if (typeof fees.sales_tax_pct === "number") {
    withFees = withFees * (1 + fees.sales_tax_pct / 100);
  }
  if (typeof fees.processing_fee_pct === "number") {
    withFees = withFees * (1 + fees.processing_fee_pct / 100);
  }
  withFees = roundCents(withFees);

  let estimated_all_in_usd = withFees;
  let optional_gratuity_usd: number | null = null;

  if (typeof fees.gratuity_pct === "number") {
    const tip = roundCents(withFees * (fees.gratuity_pct / 100));
    if (fees.gratuity_mandatory === true) {
      estimated_all_in_usd = roundCents(withFees + tip);
      notes.push(`mandatory gratuity ${fees.gratuity_pct}% included in all-in`);
    } else {
      optional_gratuity_usd = tip;
      notes.push(
        fees.gratuity_mandatory === false
          ? `optional gratuity ${fees.gratuity_pct}% excluded from gating all-in`
          : `gratuity ${fees.gratuity_pct}% treated as optional (mandatory unset)`,
      );
    }
  }

  const parts: string[] = [`F&B ${formatUsd(fb)}`];
  if (labor_usd > 0) parts.push(`labor ${formatUsd(labor_usd)}`);
  if (after_hours_usd > 0) {
    parts.push(
      `after-hours ${formatUsd(after_hours_usd)} (${after_hours_hours}h)`,
    );
  }
  if (
    typeof fees.sales_tax_pct === "number" ||
    typeof fees.processing_fee_pct === "number"
  ) {
    const taxBits: string[] = [];
    if (typeof fees.sales_tax_pct === "number") {
      taxBits.push(`tax ${fees.sales_tax_pct}%`);
    }
    if (typeof fees.processing_fee_pct === "number") {
      taxBits.push(`processing ${fees.processing_fee_pct}%`);
    }
    parts.push(taxBits.join(" + "));
  }
  let breakdown = `${parts.join(" + ")} → all-in ${formatUsd(estimated_all_in_usd)}`;
  if (optional_gratuity_usd !== null) {
    breakdown += ` (optional tip ~${formatUsd(optional_gratuity_usd)} not in gate)`;
  }
  if (incomplete) {
    breakdown += " [incomplete: building fees TBD]";
  }

  return {
    fb_usd: fb,
    labor_usd,
    after_hours_usd,
    after_hours_hours,
    subtotal_usd: subtotal,
    estimated_all_in_usd,
    optional_gratuity_usd,
    usedForGating: true,
    incomplete,
    assumed_venue_close,
    notes,
    breakdown,
  };
}
