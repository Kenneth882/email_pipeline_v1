# CLAUDE.md — VenueHopper Phase 2: Automated Email Pipeline

## What this project is

VenueHopper Phase 2 is a fully cloud-hosted, event-driven inbound email pipeline for venue outreach in Chicago. It sends outreach emails to venues, watches the inbox for replies, classifies and extracts structured data from every inbound message, updates a CRM (Supabase), and prepares threaded reply drafts — with a human only in the loop at draft approval and calls.

**Core promise:** never sleeps, never silently drops an email, human touches only drafts + calls.

This is a rebuild. Phase 1 (NYC) failed in specific ways, and every design decision here exists to kill one of those failures:

| NYC failure | Root cause | Fix in this build |
|---|---|---|
| Monitoring agent "fell asleep" | Local process polling inbox on a laptop | Gmail push → Cloud Pub/Sub → Vercel serverless. No machine to sleep. |
| Agent collapse on backlog | Batch polling; one agent, bloated context, 80 emails at once | Event-driven, per-message; each function gets < 4k tokens of scoped input |
| Drafter missed key details | Read raw threads, no structure | Triage extracts structured JSON first; drafter must escalate rather than invent |
| Proposal vs. contract mix-up | No definitions, no escalation path | Hard classification rules + confidence thresholds; contracts ALWAYS escalate |
| Data corruption in tracker | Spreadsheet writes, no idempotency | Postgres, writes keyed on Gmail messageId, DB-enforced stage transitions |
| Domain flagged for spam | Burst sending | Warm-up ramp in code, hard 50/day cap, randomized send spacing |

## Architecture

```
┌──────────────────────────────────────────┐
│  SUPABASE — single source of truth        │
│  venues · venue_contacts ·                │
│  inbound_messages · outbound_messages ·   │
│  pipeline_events                          │
└──▲──────────▲───────────▲───────────▲────┘
   │          │           │           │
(A) DRIP   (B) TRIAGE  (C) CRM     (D) DRAFTING
 ENGINE    /EXTRACTOR   WRITER      AGENT
 Vercel      v2        deterministic  fires on
 cron       Claude LLM   code        reply_required
   │          ▲           │           │
   ▼          │           │           ▼
Gmail API   Gmail watch → Pub/Sub → Vercel webhook   Gmail Drafts
(send,      (push notifications)                     (human hits send)
 50/day cap)
   │
   ▼
Google Calendar API (event created when call slot confirmed — deterministic, never LLM)
```

### The one inviolable data-flow contract

**Agents NEVER pass state to each other.** Every hop carries only:

```json
{ "venue_id": "<supabase uuid>", "gmail_message_id": "<id>" }
```

Everything else is read fresh from Supabase. Do not add fields to inter-agent payloads. Do not cache state between invocations. If a component needs data, it queries the DB.

### The four workers

**A — Drip Engine (deterministic, NOT an LLM).** Vercel cron at 9:00 and 13:00 CT (14:00/19:00 UTC — mind DST, Chicago flips CDT↔CST in November). Per run: compute quota from warm-up table (days 1–3 → 15/day, days 4–6 → 30/day, day 7+ → 50/day hard cap; each run sends half the daily quota). Follow-ups take priority over new sends. Email 2 at +4 days, Email 3 at +9 days, only if `last_inbound_at IS NULL` and stage is `1_contacted`. **Suppression is checked at send time inside the send transaction, not schedule time** — a reply arriving 5 minutes before the cron must still suppress. Randomize send spacing 30–120s. Every send: write to `outbound_messages` (capture `gmail_thread_id`, `message_id_header`), advance stage `0_sourced → 1_contacted`, log to `pipeline_events`. Follow-ups use RFC 2822 `In-Reply-To`/`References` headers so Gmail threads correctly — threading breaks = triage can't match inbound to venue. Bounces > 3% on any day → auto-pause via a `paused` flag row the cron checks first.

**B — Triage / Email Extractor v2 (Claude LLM).** Event-driven Vercel function: Pub/Sub push → resolve new messageIds via history sync → for each message not already in `inbound_messages` → classify. Input discipline: pass Claude ONLY subject, plain-text body with quoted history stripped, attachment filenames + MIME types (never contents), threadId. Target < 1k input tokens. Output is a JSON packet validated with Zod before anything downstream runs:

```json
{
  "thread_id": "…",
  "classification": "pricing_info | proposal | contract | question | partnership_interest | rejection | bounce | auto_reply | out_of_scope",
  "extracted": {
    "min_spend_usd": 1500,
    "fully_private": true,
    "capacity_ok": true,
    "contact_name": "…",
    "proposed_dates": [],
    "key_details": ["room fee waived over $3k", "AV included"]
  },
  "confidence": 0.93,
  "needs_human_review": false,
  "reply_required": true
}
```

`extracted.key_details` is the direct fix for "drafter missed details" — every commercial/logistical fact (fees, minimums, blackout dates, deposit terms, capacity caveats) must be pulled into this list.

**Hard rules enforced in CODE, not just the prompt:**
- **Contract firewall:** classification `contract`, OR any PDF/DOC attachment with confidence < 0.85, OR body containing signature/deposit/legal-terms language → `needs_human_review = true`, `reply_required = false`. Contracts are NEVER auto-drafted against. Zero tolerance.
- Confidence < 0.7 on any classification → escalate.
- Malformed JSON → one retry with the validation error appended; second failure → escalate raw email. Nothing silently drops.
- Sender not matching any venue email/domain → `out_of_scope`, logged, no venue write.

**C — CRM Writer (deterministic code).** Runs in the same Vercel invocation as Triage, sequentially (no second queue hop at this volume). Conceptually separate because classification is probabilistic and allowed to be wrong 5% of the time; bookkeeping must be right 100% of the time. Steps:
1. Resolve inbound → venue via the tiered matching cascade (below)
2. Write extraction fields; compute ICP verdict IN CODE: `min_spend_usd ≤ 4200 AND fully_private AND capacity_ok`
3. Advance stage per the transition whitelist; illegal transition → `needs_review` instead of write
4. Set `last_inbound_at` (this is what kills pending follow-ups)
5. Funnel roll-up is a Postgres VIEW — always live, no sync job
6. If `reply_required = true` → invoke Drafting Agent with `{venue_id, gmail_message_id}` only

**D — Drafting Agent (Claude LLM).** Fires ONLY on `reply_required = true`. Writes to Gmail Drafts via `drafts.create` with `threadId` and correct `In-Reply-To`/`References` headers and `Re: <original>` subject — a mismatched subject creates an orphan draft. **NEVER sends.** Human reviews Drafts folder twice daily, edits, hits send.

Context packet (assembled by code, not fetched by the LLM):
1. Cleaned thread — most recent 3 messages verbatim, older summarized
2. The venue's full Supabase row
3. Triage's `key_details` list — **every item must be either addressed in the draft or listed in an escalation note.** The drafter cannot ignore a detail.
4. The playbook for the classification:
   - `pricing_info` → confirm fit, request formal proposal / deposit terms / AV confirmation
   - `question` → answer from the canned event brief (75+ guests, fully private, budget band, AV)
   - `partnership_interest` → propose 2–3 concrete call slots pulled from Calendar free/busy (so slots are actually free)
   - `rejection` → polite close; CRM marks `lost`
5. Hard rule (prompt AND code-checked): missing info → draft starts with `[ESCALATION: …]` rather than an invented fact. `[ESCALATION` in a draft flips `needs_review` on the row.

## Supabase schema

```sql
create table venues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  neighborhood text,
  email text,                         -- legacy/primary; matching uses venue_contacts
  contact_name text,
  contact_method text not null default 'email',  -- 'email' | 'web_form' | 'phone' | 'none'
  stage text not null default '0_sourced',
  icp_verdict boolean,
  min_spend_usd numeric,
  fully_private boolean,
  capacity_ok boolean,
  needs_review boolean default false,
  review_reason text,
  gmail_thread_id text,
  email_1_sent_at timestamptz,
  email_2_sent_at timestamptz,
  email_3_sent_at timestamptz,
  last_inbound_at timestamptz,
  source_system text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Multiple contacts per venue; supports cross-account reply matching
create table venue_contacts (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid references venues(id) not null,
  email text not null,                -- always lowercased + trimmed
  is_primary boolean default false,
  shared_contact boolean default false,   -- one inbox serving multiple venues (agency)
  is_agency_domain boolean default false, -- domain is a mgmt group, not the venue's own
  source text not null default 'seed_import',  -- 'seed_import' | 'auto_linked' | 'human_confirmed'
  confidence text not null default 'confirmed', -- 'confirmed' | 'pending_review'
  created_at timestamptz default now(),
  unique(venue_id, email)
);
create index on venue_contacts (email);
create index on venue_contacts (venue_id);

-- Idempotency ledger: gmail_message_id PK makes reprocessing a no-op
create table inbound_messages (
  gmail_message_id text primary key,
  gmail_thread_id text not null,
  venue_id uuid references venues(id),   -- nullable: unmatched senders start null
  sender_email text,
  match_confidence text default 'NONE',  -- 'HIGH' | 'MEDIUM' | 'NONE'
  reviewed boolean default false,
  classification text,
  extraction jsonb,
  confidence numeric,
  needs_human_review boolean,
  reply_required boolean,
  processed_at timestamptz default now()
);

-- Every outbound send; enables In-Reply-To matching for cross-account replies
create table outbound_messages (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid references venues(id) not null,
  gmail_message_id text not null,
  message_id_header text not null,   -- RFC Message-ID for In-Reply-To lookups
  gmail_thread_id text not null,
  sent_from_address text not null,   -- drafts must reply from the same identity
  sent_at timestamptz default now()
);
create index on outbound_messages (message_id_header);
create index on outbound_messages (gmail_thread_id);

-- Append-only event log: debugging + audit + "nothing silently drops"
create table pipeline_events (
  id bigserial primary key,
  venue_id uuid,
  gmail_message_id text,
  actor text,   -- 'drip' | 'triage' | 'crm' | 'drafter' | 'human'
  event text,   -- 'sent_email_1', 'classified', 'draft_created', 'error', ...
  detail jsonb,
  created_at timestamptz default now()
);
```

### Stage transitions (enforced by a Postgres TRIGGER, not application code)

```
0_sourced → 1_contacted → 2_responded → 3_in_icp → 4_proposal_received
→ 5_partnership_interest → 6_call_scheduled → 7_call_completed → 8_onboarded

any stage → lost | bounced | needs_review
```

A buggy agent physically cannot corrupt the funnel. Illegal transition at the DB level → rejected; CRM Writer catches the rejection and flags `needs_review`.

Venues with `contact_method != 'email'` use stage `sourced_manual`-style handling — they are excluded from Drip Engine's send query and never enter the automated funnel.

## Venue matching cascade (CRM Writer, deterministic)

Replies don't always come from the address you emailed. Resolution runs top-down; first match wins:

1. **Tier 1 — thread match.** `gmail_thread_id` matches an existing pipeline thread → HIGH confidence.
2. **Tier 1.5 — In-Reply-To header.** Inbound's `In-Reply-To`/`References` contains a `message_id_header` we generated (lookup in `outbound_messages`) → HIGH. Survives cross-account replies and forwards.
3. **Tier 2 — known contact.** Sender email exists in `venue_contacts`. If exactly one venue → HIGH. **If the email maps to multiple venues (`shared_contact = true`, e.g. an agency inbox) → MEDIUM at best, route to digest.**
4. **Tier 3 — domain match.** Sender's domain matches exactly one venue's contacts → MEDIUM. Auto-link, insert into `venue_contacts` as `pending_review`, flag in daily digest. **Skip auto-link if `is_agency_domain = true`** — agency domains can represent multiple venues.
5. **Tier 4 — body/header token.** Outbound emails embed a reference token (venue_id encoded in a booking link). If any inbound body contains it → MEDIUM, deterministic regex match.
6. **Tier 5 — no match.** `venue_id = null`, `match_confidence = 'NONE'`, message logged, **Drafting Agent is NOT invoked**, surfaces in digest for manual linking.

MEDIUM still drafts (don't lose response speed on "new employee at a known venue"). NONE never drafts — drafting against a wrong/absent venue record is worse than a delayed reply. This is the same escalate-don't-invent principle as the contract firewall.

## Gmail + Pub/Sub plumbing — the critical gotchas

These are the highest-risk items in the whole build. Do not skip any.

1. **Pub/Sub grant.** Create topic `gmail-inbound`; grant `gmail-api-push@system.gserviceaccount.com` the Publisher role on it. Without this exact grant, `watch()` succeeds but no notifications ever arrive — a silent failure.
2. **Watch expires every 7 days (certainty: 100%).** Daily Vercel cron re-calls `users.watch()`, logs the new expiration to `pipeline_events`. A second cron alerts if last successful renewal > 26h old. This is the #1 way event-driven Gmail pipelines silently die.
3. **Push payload contains no email content.** Only `{emailAddress, historyId}`. Webhook must call `history.list(startHistoryId=lastStoredHistoryId)` to find new messageIds, then `messages.get` per message. Store `lastHistoryId` in Supabase after every successful sync. `history.list` 404 (historyId too old after downtime) → fall back to `messages.list(q="newer_than:1d")` and reconcile against `inbound_messages` by messageId. **Build the fallback from day one.**
4. **OAuth token lifecycle.** Refresh token in Vercel env vars, exchanged per invocation. If the consent screen stays in "Testing" mode, refresh tokens die after 7 days and the pipeline dies quietly. Publish the app (internal is fine). Add an auth canary: daily cron makes one trivial Gmail call, alerts on failure.
5. **Filter history sync to INBOX label additions only.** Otherwise the pipeline sees its own sends and manual replies from the shared mailbox and triages its own emails.
6. **Ack discipline.** Return HTTP 200 to Pub/Sub only AFTER the `inbound_messages` row commits. Crash mid-processing → redelivery → the `gmail_message_id` PK absorbs it. Pub/Sub is at-least-once; duplicates are normal, not a bug.
7. **Concurrency.** Two messages on one thread arriving simultaneously: process both; the DB transition trigger guards against out-of-order corruption. Consider claiming the `inbound_messages` row (insert with a processing status) BEFORE invoking any LLM so redelivery mid-Triage can't double-classify.

## Known problem list (ranked by likelihood × pain)

1. Gmail watch expiration — renew daily + staleness alert (build this first)
2. Vercel timeouts — Hobby caps at 10s; Claude call + Gmail fetches exceed it. `maxDuration: 60` on Pro ($20/mo, budgeted), or split via Pub/Sub
3. OAuth refresh-token expiry in Testing mode — publish the app + auth canary
4. HistoryId gaps after downtime — `messages.list` fallback from day one
5. Follow-up race conditions — re-check `last_inbound_at` inside the send transaction
6. Quoted-text pollution — strip quoted history or Triage extracts your own template's numbers as the venue's pricing. Test Gmail, Outlook, and iPhone reply formats (each quotes differently)
7. Auto-replies / OOO loops — classify `auto_reply`; must NOT advance stage, NOT cancel follow-ups, NOT trigger a draft
8. Attachment-heavy proposals — "see attached" + PDF: flag `attachment_pending`; the drafter must not claim to have read a PDF it hasn't
9. DST cron drift — Vercel crons are UTC; Chicago flips in November
10. Shared-inbox conflicts — filter history sync to INBOX only
11. Claude API 529s — retry with backoff; Pub/Sub redelivery is the backstop
12. Supabase connection cap (60) — use the Supavisor pooled connection string, never the direct one

## Failure handling & observability

- **Daily digest email (cron):** `needs_review` rows with reasons, yesterday's sends/bounces/replies, funnel snapshot, watch-renewal status, auth-canary status, MEDIUM/NONE-confidence inbound for review. The single 5-minute morning check.
- **Retries:** Vercel error → Pub/Sub redelivery (up to 7 days) + idempotency = at-least-once delivery with exactly-once effect.
- **Dead-letter:** after 5 failed deliveries, Pub/Sub routes to a dead-letter topic → a function writes a `pipeline_events` error row → appears in the digest. Poison-pill emails can't clog the pipe. DLQ items MUST surface in the digest or they're silently dropped by definition.
- **Statelessness:** everything is functions + one DB. Total redeploy loses nothing; historyId fallback re-syncs anything missed.
- **Kill switch:** one `paused` flag in Supabase, checked by the drip cron, honored within one run. Any spam-folder report → set it, wait 48h.

## Build order (2 weeks target)

| Days | Work | Exit test |
|---|---|---|
| 1–2 | Supabase schema + transition trigger + event log; Vercel project; env/auth | Illegal stage transition rejected by the DB |
| 3–4 | Gmail OAuth (published app), Pub/Sub topic + push sub, watch + daily renewal, historyId sync + fallback | Test email fires webhook; twice-delivered message written once |
| 5–7 | Drip Engine: quota, warm-up, follow-ups, suppression, bounce pause, threading headers, outbound_messages writes, reference token in template | Dry-run logs intended sends; live test to 5 seed addresses; a reply suppresses its own follow-up |
| 8–10 | Triage v2 + CRM Writer: prompt, Zod validation, contract firewall, matching cascade, idempotent writes | Replay 25 labeled NYC emails → ≥95% accuracy, ALL contracts escalated, zero duplicate rows; unrecognized-sender email resolves to correct tier, never wrongly attached |
| 11–12 | Drafting Agent: context packet, playbooks, escalation rule, threaded drafts.create | Seeded pricing email → correct threaded draft < 10 min addressing every key_detail |
| 13–14 | End-to-end soak with 10 seed contacts; daily digest; kill switch; calendar hook | Full loop incl. one deliberately induced crash recovered via redelivery; redelivered message mid-Triage does not double-classify |
| 15+ | Warm-up sends begin (15/day) on the real Chicago queue | Leading indicators per playbook |

**No real venue receives an email before Day 15.** Days 3–14 use test addresses and seed contacts only.

**The replay harness (Day 8) is the highest-leverage artifact:** a folder of real, hand-labeled NYC emails re-run against every prompt change. It turns "the prompt feels better" into a number and holds the ≥95% bar without burning live leads.

## Current data state

Supabase already holds the Chicago sourcing import:
- **12 venues** with `contact_method = 'email'` and a `venue_contacts` row each (Aire Rooftop Bar, Broken English Taco Pub, Frontera Grill, Outside the Box Catering, Petit Pomeroy, Private Affairs, Smith & Wollensky, The Good Eating Company, Waterview, Gilt Bar, The Game Room, Ciccio Mio)
- Waterview (`firsthospitality.com`) and The Game Room (`caa.bokagrp.com`) are flagged `is_agency_domain = true` — management-group inboxes, not venue-owned domains
- **12 more venues** with `contact_method` of `web_form` (6), `phone` (2), or `none` (4) — tracked but excluded from the automated pipeline
- All emails are lowercased and trimmed at import; `unique(venue_id, email)` enforced
- The plan assumes the queue grows toward ≥500 validated candidates; the pipeline must not assume the current small count

## Stack

- **Supabase** (Postgres) — source of truth. Use the Supavisor pooled connection string.
- **Vercel Pro** — all serverless functions + crons. `maxDuration: 60` where Claude calls happen.
- **Google Cloud Pub/Sub** — event bus (free tier fine at this volume)
- **Gmail API** — send, watch/history, drafts.create
- **Google Calendar API** — free/busy for slot proposals; deterministic event creation (never LLM-driven)
- **Claude API (Sonnet)** — Triage v2 classification+extraction, Drafting Agent generation
- **Node.js / TypeScript** — all functions
- **Zod** — JSON schema validation on every Triage output before anything downstream trusts it
- **googleapis + supabase-js** — API clients
- **Git + GitHub → Vercel auto-deploy**

Budget: Vercel Pro $20 + Claude API ~$10–25 + free tiers ≈ $30–45/mo (cap: $75).

## Engineering principles (apply to every component)

1. **LLMs classify and draft. Code decides and writes.** ICP verdicts, stage transitions, calendar events, venue matching — all deterministic. Never let an LLM guess identity, write to the calendar, or advance the funnel.
2. **Escalate, never invent.** Missing info → `[ESCALATION]`, `needs_review`, or a digest entry. Applies to contracts, low confidence, unmatched senders, unread attachments.
3. **Idempotency everywhere.** `gmail_message_id` is the universal dedup key. Every write must be safe to replay.
4. **Nothing silently drops.** Every inbound is logged in `pipeline_events` even when it can't be processed. If it fails 5x it dead-letters INTO the digest, not into the void.
5. **Scoped context.** < 4k tokens per LLM invocation, < 1k for Triage input. No bloated threads, no full mailbox context.
6. **The DB is the only state.** Functions are stateless. Redeploy at any time.

## Definition of done

With the laptop off for 72 hours straight: every inbound email is classified and written to Supabase within 10 minutes, every reply-required message has a threaded draft waiting, follow-ups fire and suppress correctly, the watch has renewed itself, and the daily digest arrives each morning — with nothing silently dropped.