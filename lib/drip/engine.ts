import type { SupabaseClient } from "@supabase/supabase-js";
import {
  dailyQuotaForWarmupDay,
  getConfigValue,
  halfQuota,
  isDryRun,
  isPaused,
  setConfigValue,
} from "@/lib/config";
import { advanceToContacted } from "@/lib/crm/stage";
import {
  buildOutreachEmail,
  type EmailSlot,
} from "@/lib/drip/templates";
import { sendUnipileEmail } from "@/lib/unipile/send";

export type DripCandidate = {
  venueId: string;
  name: string;
  email: string;
  slot: EmailSlot;
  hubspotDealId: string | null;
  stageCache: string | null;
  threadId: string | null;
  replyToMessageId: string | null;
};

export type DripRunResult = {
  paused: boolean;
  dryRun: boolean;
  warmupDay: number;
  dailyQuota: number;
  runQuota: number;
  intended: Array<{
    venueId: string;
    name: string;
    email: string;
    slot: EmailSlot;
  }>;
  sent: Array<{ venueId: string; slot: EmailSlot; messageId: string }>;
  skipped: Array<{ venueId: string; reason: string }>;
  errors: Array<{ venueId: string; error: string }>;
};

type VenueRow = {
  id: string;
  name: string;
  hubspot_deal_id: string | null;
  stage_cache: string | null;
  thread_id: string | null;
  email_1_sent_at: string | null;
  email_2_sent_at: string | null;
  email_3_sent_at: string | null;
  last_inbound_at: string | null;
  bounced: boolean | null;
  venue_contacts: Array<{ email: string; is_primary: boolean | null }> | null;
};

function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return ms / (1000 * 60 * 60 * 24);
}

function primaryEmail(v: VenueRow): string | null {
  const contacts = v.venue_contacts ?? [];
  const primary = contacts.find((c) => c.is_primary) ?? contacts[0];
  return primary?.email?.toLowerCase().trim() ?? null;
}

async function loadCandidates(
  supabase: SupabaseClient,
): Promise<DripCandidate[]> {
  // All email-eligible venues with HubSpot IDs (seeds + real). Warm-up quota still caps volume.
  const { data, error } = await supabase
    .from("venues")
    .select(
      "id, name, hubspot_deal_id, stage_cache, thread_id, email_1_sent_at, email_2_sent_at, email_3_sent_at, last_inbound_at, bounced, venue_contacts(email, is_primary)",
    )
    .eq("contact_method", "email")
    .eq("bounced", false)
    .not("hubspot_contact_id", "is", null)
    .not("hubspot_deal_id", "is", null);

  if (error) throw new Error(`candidate query: ${error.message}`);

  const followUps: DripCandidate[] = [];
  const news: DripCandidate[] = [];

  for (const row of (data ?? []) as VenueRow[]) {
    const email = primaryEmail(row);
    if (!email) continue;

    // Follow-ups: Email 2/3 only if no inbound and stage contacted
    if (
      row.last_inbound_at == null &&
      row.stage_cache === "1_contacted" &&
      row.email_1_sent_at
    ) {
      if (!row.email_2_sent_at && daysSince(row.email_1_sent_at) >= 4) {
        const prior = await latestOutbound(supabase, row.id);
        followUps.push({
          venueId: row.id,
          name: row.name,
          email,
          slot: 2,
          hubspotDealId: row.hubspot_deal_id,
          stageCache: row.stage_cache,
          threadId: row.thread_id ?? prior?.thread_id ?? null,
          replyToMessageId: prior?.message_id ?? null,
        });
        continue;
      }
      if (
        row.email_2_sent_at &&
        !row.email_3_sent_at &&
        daysSince(row.email_1_sent_at) >= 9
      ) {
        const prior = await latestOutbound(supabase, row.id);
        followUps.push({
          venueId: row.id,
          name: row.name,
          email,
          slot: 3,
          hubspotDealId: row.hubspot_deal_id,
          stageCache: row.stage_cache,
          threadId: row.thread_id ?? prior?.thread_id ?? null,
          replyToMessageId: prior?.message_id ?? null,
        });
        continue;
      }
    }

    // New Email 1
    if (!row.email_1_sent_at) {
      news.push({
        venueId: row.id,
        name: row.name,
        email,
        slot: 1,
        hubspotDealId: row.hubspot_deal_id,
        stageCache: row.stage_cache,
        threadId: row.thread_id,
        replyToMessageId: null,
      });
    }
  }

  return [...followUps, ...news];
}

async function latestOutbound(
  supabase: SupabaseClient,
  venueId: string,
): Promise<{ message_id: string; thread_id: string } | null> {
  const { data } = await supabase
    .from("outbound_messages")
    .select("message_id, thread_id")
    .eq("venue_id", venueId)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function spacingMs(remainingSends: number, deadlineMs: number): number {
  const remaining = Math.max(0, deadlineMs - Date.now());
  if (remainingSends <= 1) return 0;
  const fit = Math.floor(remaining / (remainingSends - 1));
  const ideal = 30_000 + Math.floor(Math.random() * 90_000); // 30–120s
  return Math.max(5_000, Math.min(ideal, fit, 120_000));
}

function slotSentAtColumn(
  slot: EmailSlot,
): "email_1_sent_at" | "email_2_sent_at" | "email_3_sent_at" {
  if (slot === 1) return "email_1_sent_at";
  if (slot === 2) return "email_2_sent_at";
  return "email_3_sent_at";
}

/**
 * Atomically claim a send slot before Unipile. Concurrent drip runs lose the race
 * (0 rows updated) and must skip — prevents double-sends on overlapping invocations.
 */
async function claimEmailSlot(
  supabase: SupabaseClient,
  venueId: string,
  slot: EmailSlot,
): Promise<{ claimed: boolean; claimedAt: string }> {
  const col = slotSentAtColumn(slot);
  const claimedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from("venues")
    .update({ [col]: claimedAt, updated_at: claimedAt })
    .eq("id", venueId)
    .is(col, null)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`claim slot ${slot}: ${error.message}`);
  return { claimed: !!data, claimedAt };
}

/** Release a claim only when Unipile never accepted the send (retryable failure). */
async function releaseEmailSlot(
  supabase: SupabaseClient,
  venueId: string,
  slot: EmailSlot,
  claimedAt: string,
): Promise<void> {
  const col = slotSentAtColumn(slot);
  const { error } = await supabase
    .from("venues")
    .update({ [col]: null, updated_at: new Date().toISOString() })
    .eq("id", venueId)
    .eq(col, claimedAt);
  if (error) {
    console.error("[drip] failed to release claim", {
      venueId,
      slot,
      error: error.message,
    });
  }
}

async function stillSuppressed(
  supabase: SupabaseClient,
  venueId: string,
  slot: EmailSlot,
): Promise<{ suppress: boolean; reason?: string }> {
  const paused = await getConfigValue(supabase, "paused");
  if (isPaused(paused)) return { suppress: true, reason: "paused" };

  const { data, error } = await supabase
    .from("venues")
    .select(
      "last_inbound_at, bounced, email_1_sent_at, email_2_sent_at, email_3_sent_at, stage_cache",
    )
    .eq("id", venueId)
    .maybeSingle();

  if (error || !data) return { suppress: true, reason: "venue_missing" };
  if (data.bounced) return { suppress: true, reason: "bounced" };
  if (data.last_inbound_at) return { suppress: true, reason: "has_inbound" };

  const col = slotSentAtColumn(slot);
  if (data[col]) return { suppress: true, reason: "already_sent" };

  // Follow-ups must still be in contacted with prior slots present.
  if (slot === 2 && !data.email_1_sent_at) {
    return { suppress: true, reason: "missing_email_1" };
  }
  if (slot === 3 && (!data.email_1_sent_at || !data.email_2_sent_at)) {
    return { suppress: true, reason: "missing_prior_slot" };
  }

  return { suppress: false };
}

async function recordBounceStats(
  supabase: SupabaseClient,
  sentDelta: number,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const stats =
    (await getConfigValue<{
      date: string | null;
      sent: number;
      bounced: number;
    }>(supabase, "bounce_stats")) ?? { date: null, sent: 0, bounced: 0 };

  const next =
    stats.date === today
      ? { ...stats, sent: stats.sent + sentDelta }
      : { date: today, sent: sentDelta, bounced: 0 };

  await setConfigValue(supabase, "bounce_stats", next);

  if (next.sent >= 10 && next.bounced / next.sent > 0.03) {
    await setConfigValue(supabase, "paused", true);
    console.warn("[drip] auto-paused: bounce rate > 3%", next);
  }
}

export async function runDrip(
  supabase: SupabaseClient,
  opts?: { maxDurationMs?: number },
): Promise<DripRunResult> {
  const maxDurationMs = opts?.maxDurationMs ?? 280_000;
  const deadlineMs = Date.now() + maxDurationMs;

  const pausedVal = await getConfigValue(supabase, "paused");
  if (isPaused(pausedVal)) {
    return {
      paused: true,
      dryRun: true,
      warmupDay: 0,
      dailyQuota: 0,
      runQuota: 0,
      intended: [],
      sent: [],
      skipped: [],
      errors: [],
    };
  }

  const warmupRaw = await getConfigValue<number>(supabase, "warmup_day");
  const warmupDay =
    typeof warmupRaw === "number" ? warmupRaw : Number(warmupRaw) || 1;
  const dailyQuota = dailyQuotaForWarmupDay(warmupDay);
  const runQuota = halfQuota(dailyQuota);

  const dryRunConfig = await getConfigValue(supabase, "drip_dry_run");
  const dryRun = isDryRun(process.env.DRIP_DRY_RUN, dryRunConfig);

  const candidates = (await loadCandidates(supabase)).slice(0, runQuota);

  const result: DripRunResult = {
    paused: false,
    dryRun,
    warmupDay,
    dailyQuota,
    runQuota,
    intended: candidates.map((c) => ({
      venueId: c.venueId,
      name: c.name,
      email: c.email,
      slot: c.slot,
    })),
    sent: [],
    skipped: [],
    errors: [],
  };

  if (dryRun) {
    console.info("[drip] DRY_RUN intended", result.intended);
    return result;
  }

  const sentFrom =
    process.env.SENT_FROM_ADDRESS?.trim() ||
    "romerokenneth297@gmail.com";

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];

    const gate = await stillSuppressed(supabase, c.venueId, c.slot);
    if (gate.suppress) {
      result.skipped.push({
        venueId: c.venueId,
        reason: gate.reason ?? "suppressed",
      });
      continue;
    }

    let claimedAt: string | null = null;
    let unipileAccepted = false;

    try {
      const claim = await claimEmailSlot(supabase, c.venueId, c.slot);
      if (!claim.claimed) {
        result.skipped.push({ venueId: c.venueId, reason: "already_claimed" });
        continue;
      }
      claimedAt = claim.claimedAt;

      const { subject, body } = buildOutreachEmail({
        venueName: c.name,
        slot: c.slot,
      });

      const sent = await sendUnipileEmail({
        toEmail: c.email,
        toName: c.name,
        subject,
        body,
        replyToMessageId: c.replyToMessageId ?? undefined,
      });
      unipileAccepted = true;

      const { error: outErr } = await supabase.from("outbound_messages").insert({
        venue_id: c.venueId,
        message_id: sent.messageId,
        message_id_header: sent.messageIdHeader,
        thread_id: sent.threadId,
        sent_from_address: sentFrom,
      });
      if (outErr) throw new Error(outErr.message);

      // Slot timestamp already set by claim; finish thread / stage bookkeeping.
      const venueUpdate: Record<string, unknown> = {
        thread_id: sent.threadId,
        updated_at: new Date().toISOString(),
      };

      if (c.slot === 1 && c.hubspotDealId) {
        const stage = await advanceToContacted({
          dealId: c.hubspotDealId,
          stageCache: c.stageCache,
        });
        if (stage.conflict) {
          await supabase.from("pipeline_events").insert({
            venue_id: c.venueId,
            message_id: sent.messageId,
            actor: "drip",
            event: "stage_conflict",
            detail: stage,
          });
        }
        if (stage.movedTo) {
          venueUpdate.stage_cache = stage.movedTo;
        }
      } else if (c.slot === 1) {
        venueUpdate.stage_cache = "1_contacted";
      }

      const { error: vErr } = await supabase
        .from("venues")
        .update(venueUpdate)
        .eq("id", c.venueId);
      if (vErr) throw new Error(vErr.message);

      await supabase.from("pipeline_events").insert({
        venue_id: c.venueId,
        message_id: sent.messageId,
        actor: "drip",
        event: `sent_email_${c.slot}`,
        detail: {
          to: c.email,
          thread_id: sent.threadId,
          dry_run: false,
        },
      });

      result.sent.push({
        venueId: c.venueId,
        slot: c.slot,
        messageId: sent.messageId,
      });

      await recordBounceStats(supabase, 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Only release if Unipile never accepted — otherwise keep claim to avoid a
      // second real send on retry after a post-send bookkeeping failure.
      if (claimedAt && !unipileAccepted) {
        await releaseEmailSlot(supabase, c.venueId, c.slot, claimedAt);
      }
      result.errors.push({ venueId: c.venueId, error: msg });
      await supabase.from("pipeline_events").insert({
        venue_id: c.venueId,
        actor: "drip",
        event: "error",
        detail: {
          slot: c.slot,
          error: msg,
          claim_released: Boolean(claimedAt && !unipileAccepted),
        },
      });
    }

    const remaining = candidates.length - i;
    const wait = spacingMs(remaining, deadlineMs);
    if (wait > 0 && i < candidates.length - 1) {
      await sleep(wait);
    }
  }

  return result;
}
