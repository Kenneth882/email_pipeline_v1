import type { SupabaseClient } from "@supabase/supabase-js";

export type MatchConfidence = "HIGH" | "MEDIUM" | "NONE";

export type MatchResult = {
  venueId: string | null;
  confidence: MatchConfidence;
  tier: "thread" | "in_reply_to" | "contact" | "domain" | "none";
  detail?: string;
};

function normalizeMessageIdHeader(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  return t.startsWith("<") ? t : `<${t}>`;
}

/**
 * Matching cascade: Tier 1 thread → Tier 1.5 In-Reply-To → Tier 2 contact → Tier 3 domain.
 * Tier 4 body-token matching deferred.
 */
export async function matchInboundToVenue(
  supabase: SupabaseClient,
  opts: {
    threadId: string | null;
    senderEmail: string | null;
    /** RFC Message-IDs from In-Reply-To / References */
    inReplyToHeaders?: string[];
  },
): Promise<MatchResult> {
  // Tier 1 — thread match
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

  // Tier 1.5 — In-Reply-To / References → outbound message_id_header
  const headers = (opts.inReplyToHeaders ?? [])
    .map(normalizeMessageIdHeader)
    .filter(Boolean);
  if (headers.length > 0) {
    const { data: byHeader } = await supabase
      .from("outbound_messages")
      .select("venue_id, message_id_header")
      .in("message_id_header", headers)
      .limit(5);

    const venueIds = [
      ...new Set((byHeader ?? []).map((r) => r.venue_id).filter(Boolean)),
    ];
    if (venueIds.length === 1) {
      return {
        venueId: venueIds[0] as string,
        confidence: "HIGH",
        tier: "in_reply_to",
        detail: "message_id_header",
      };
    }
  }

  // Tier 2 — known contact email
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

    // Tier 3 — domain match (skip agency domains)
    const at = email.lastIndexOf("@");
    if (at > 0) {
      const domain = email.slice(at + 1);
      if (domain) {
        const { data: domainContacts } = await supabase
          .from("venue_contacts")
          .select("venue_id, email, is_agency_domain")
          .ilike("email", `%@${domain}`);

        const nonAgency = (domainContacts ?? []).filter(
          (c) => !c.is_agency_domain,
        );
        const venueIds = [
          ...new Set(nonAgency.map((c) => c.venue_id).filter(Boolean)),
        ];

        if (venueIds.length === 1) {
          const venueId = venueIds[0] as string;
          // Auto-link sender as pending_review
          await supabase.from("venue_contacts").upsert(
            {
              venue_id: venueId,
              email,
              is_primary: false,
              shared_contact: false,
              is_agency_domain: false,
              source: "auto_linked",
              confidence: "pending_review",
            },
            { onConflict: "venue_id,email" },
          );

          return {
            venueId,
            confidence: "MEDIUM",
            tier: "domain",
            detail: `domain=${domain}`,
          };
        }

        if (
          (domainContacts ?? []).some((c) => c.is_agency_domain) &&
          venueIds.length !== 1
        ) {
          return {
            venueId: null,
            confidence: "NONE",
            tier: "none",
            detail: "agency_domain_skipped",
          };
        }
      }
    }
  }

  return { venueId: null, confidence: "NONE", tier: "none" };
}
