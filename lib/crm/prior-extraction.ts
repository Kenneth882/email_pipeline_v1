import type { SupabaseClient } from "@supabase/supabase-js";
import {
  foldExtractions,
  type ExtractedMemory,
} from "@/lib/crm/icp";

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
    contact_name:
      typeof o.contact_name === "string"
        ? o.contact_name
        : o.contact_name === null
          ? null
          : undefined,
    proposed_dates: dates,
    key_details: details,
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
