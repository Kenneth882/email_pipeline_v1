import type { SupabaseClient } from "@supabase/supabase-js";
import {
  foldExtractions,
  type ExtractedMemory,
} from "@/lib/crm/icp";
import type { FeeStaff, VenueFees } from "@/lib/triage/schema";

function asNullableNumber(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

function asNullableBoolean(v: unknown): boolean | null | undefined {
  if (v === null) return null;
  if (typeof v === "boolean") return v;
  return undefined;
}

function asStaff(raw: unknown): FeeStaff[] | null | undefined {
  if (raw === null) return null;
  if (!Array.isArray(raw)) return undefined;
  const rows: FeeStaff[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (
      typeof o.role !== "string" ||
      typeof o.count !== "number" ||
      typeof o.rate_usd_per_hour !== "number" ||
      typeof o.min_hours !== "number"
    ) {
      continue;
    }
    rows.push({
      role: o.role,
      count: o.count,
      rate_usd_per_hour: o.rate_usd_per_hour,
      min_hours: o.min_hours,
    });
  }
  return rows;
}

function asFees(raw: unknown): VenueFees | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const fees: VenueFees = {
    fb_minimum_usd: asNullableNumber(o.fb_minimum_usd),
    room_rental_usd: asNullableNumber(o.room_rental_usd),
    after_hours_usd_per_hour: asNullableNumber(o.after_hours_usd_per_hour),
    venue_close_hour_local: asNullableNumber(o.venue_close_hour_local),
    staff: asStaff(o.staff),
    sales_tax_pct: asNullableNumber(o.sales_tax_pct),
    processing_fee_pct: asNullableNumber(o.processing_fee_pct),
    gratuity_pct: asNullableNumber(o.gratuity_pct),
    gratuity_mandatory: asNullableBoolean(o.gratuity_mandatory),
    building_fees_unknown: asNullableBoolean(o.building_fees_unknown),
  };
  const hasAny = Object.values(fees).some(
    (v) => v !== null && v !== undefined,
  );
  return hasAny ? fees : null;
}

function asExtractedMemory(raw: unknown): ExtractedMemory {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const dates = Array.isArray(o.proposed_dates)
    ? o.proposed_dates.filter((d): d is string => typeof d === "string")
    : [];
  const details = Array.isArray(o.key_details)
    ? o.key_details.filter((d): d is string => typeof d === "string")
    : [];
  return {
    min_spend_usd:
      typeof o.min_spend_usd === "number"
        ? o.min_spend_usd
        : o.min_spend_usd === null
          ? null
          : undefined,
    fully_private:
      typeof o.fully_private === "boolean"
        ? o.fully_private
        : o.fully_private === null
          ? null
          : undefined,
    capacity_ok:
      typeof o.capacity_ok === "boolean"
        ? o.capacity_ok
        : o.capacity_ok === null
          ? null
          : undefined,
    provides_food:
      typeof o.provides_food === "boolean"
        ? o.provides_food
        : o.provides_food === null
          ? null
          : undefined,
    contact_name:
      typeof o.contact_name === "string"
        ? o.contact_name
        : o.contact_name === null
          ? null
          : undefined,
    proposed_dates: dates,
    key_details: details,
    fees: asFees(o.fees),
  };
}

/**
 * Load prior done inbound extracts for venue+thread (oldest → newest),
 * excluding the current message, and fold into one memory object.
 */
export async function loadPriorExtractions(
  supabase: SupabaseClient,
  opts: {
    venueId: string;
    threadId: string;
    excludeMessageId: string;
  },
): Promise<ExtractedMemory> {
  const { venueId, threadId, excludeMessageId } = opts;

  const { data, error } = await supabase
    .from("inbound_messages")
    .select("message_id, extraction, processed_at")
    .eq("venue_id", venueId)
    .eq("thread_id", threadId)
    .eq("status", "done")
    .neq("message_id", excludeMessageId)
    .order("processed_at", { ascending: true })
    .limit(20);

  if (error) throw new Error(`prior extractions: ${error.message}`);

  const extracts = (data ?? []).map((row) =>
    asExtractedMemory(row.extraction),
  );
  return foldExtractions(extracts);
}
