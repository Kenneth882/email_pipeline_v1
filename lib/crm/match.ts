import type { SupabaseClient } from "@supabase/supabase-js";

export type MatchConfidence = "HIGH" | "MEDIUM" | "NONE";

export type MatchResult = {
  venueId: string | null;
  confidence: MatchConfidence;
  tier: "thread" | "contact" | "none";
  detail?: string;
};

/**
 * Matching cascade stub (Day 5): Tier 1 thread, Tier 2 contact.
 * Tier 4 body-token matching deferred to a later iteration.
 */
export async function matchInboundToVenue(
  supabase: SupabaseClient,
  opts: {
    threadId: string | null;
    senderEmail: string | null;
  },
): Promise<MatchResult> {
  if (opts.threadId) {
    const { data: byThread } = await supabase
      .from("venues")
      .select("id")
      .eq("thread_id", opts.threadId)
      .limit(2);

    if (byThread && byThread.length === 1) {
      return {
        venueId: byThread[0].id,
        confidence: "HIGH",
        tier: "thread",
      };
    }

    const { data: byOutbound } = await supabase
      .from("outbound_messages")
      .select("venue_id")
      .eq("thread_id", opts.threadId)
      .limit(2);

    const venueIds = [
      ...new Set((byOutbound ?? []).map((r) => r.venue_id).filter(Boolean)),
    ];
    if (venueIds.length === 1) {
      return {
        venueId: venueIds[0] as string,
        confidence: "HIGH",
        tier: "thread",
      };
    }
  }

  const email = opts.senderEmail?.toLowerCase().trim();
  if (email) {
    const { data: contacts } = await supabase
      .from("venue_contacts")
      .select("venue_id, shared_contact")
      .eq("email", email);

    if (contacts && contacts.length === 1) {
      return {
        venueId: contacts[0].venue_id,
        confidence: "HIGH",
        tier: "contact",
      };
    }
    if (contacts && contacts.length > 1) {
      return {
        venueId: null,
        confidence: "MEDIUM",
        tier: "contact",
        detail: "shared_contact_ambiguous",
      };
    }
  }

  return { venueId: null, confidence: "NONE", tier: "none" };
}
