# CLAUDE.md — VenueHopper Phase 2: Automated Email Pipeline (v3 — Unipile + HubSpot)

## What this project is

VenueHopper Phase 2 is a fully cloud-hosted, event-driven inbound email pipeline for venue outreach in Chicago. It sends outreach emails to venues, watches the inbox for replies, classifies and extracts structured data from every inbound message, updates the CRM, and prepares threaded reply drafts — with a human only in the loop at draft approval and calls.

**Core promise:** never sleeps, never silently drops an email, human touches only drafts + calls.

**v3 stack change:** the email transport layer (Gmail watch / Pub/Sub / historyId sync / OAuth lifecycle) is outsourced to **Unipile**, and the human-facing CRM layer is **HubSpot free CRM** (contacts + one deal pipeline). **Supabase remains the operational spine**: venue↔HubSpot mapping, `venue_contacts`, the idempotency ledger, `outbound_messages`, and the event log. All decision logic (triage contract, contract firewall, matching cascade, ICP verdict, stage whitelist, escalation rules) stays in our code — none of it is delegated to a SaaS tool.

This is a rebuild. Phase 1 (NYC) failed in specific ways, and every design decision exists to kill one of those failures:

| NYC failure | Root cause | Fix in this build |
|---|---|---|
| Monitoring agent "fell asleep" | Local process polling inbox on a laptop | Unipile hosted inbox sync → webhook → Vercel serverless. No machine to sleep, no watch to renew. |
| Agent collapse on backlog | Batch polling; one agent, bloated context, 80 emails at once | Event-driven, per-message; each function gets < 4k tokens of scoped input |
| Drafter missed key details | Read raw threads, no structure | Triage extracts structured JSON first; drafter must escalate rather than invent |
| Proposal vs. contract mix-up | No definitions, no escalation path | Hard classification rules + confidence thresholds; contracts ALWAYS escalate |
| Data corruption in tracker | Spreadsheet writes, no idempotency | Postgres idempotency ledger keyed on message id; stage whitelist validated on every write |
| Domain flagged for spam | Burst sending | Warm-up ramp in code, hard 50/day cap, randomized send spacing |
| (v2 plan's own fragility) | Gmail watch expiry, historyId gaps, OAuth testing-mode token death | Unipile owns OAuth, token refresh, sync, and webhook delivery |

## Architecture

```
              ┌─────────────────────────────────────────┐
              │  UNIPILE — email transport               │
              │  OAuth · inbox sync · webhooks · send ·  │
              │  threading · token refresh                │
              └─────┬──────────────────────────▲─────────┘
        webhook:    │                          │ send / draft API
        normalized  ▼                          │
   ┌──────────────────────────────────────────────────────┐
   │           VERCEL FUNCTIONS — the four workers          │
   │  A · DRIP ENGINE (cron, deterministic)                 │
   │  B · TRIAGE / EXTRACTOR v2 (Claude LLM)                │
   │  C · CRM WRITER (deterministic code)                   │
   │  D · DRAFTING AGENT (Claude LLM, fires on              │
   │      reply_required)                                   │
   └──────┬──────────────────────────────────┬─────────────┘
          │ dual write                       │
          ▼                                  ▼
┌───────────────────────────┐   ┌────────────────────────────┐
│ SUPABASE — operational     │   │ HUBSPOT — human-facing CRM  │
│ spine                      │   │ Contacts + 1 deal pipeline  │
│ venues (mapping/cache) ·   │   │ = venue records, stage      │
│ venue_contacts ·           │   │ board, timeline, reporting  │
│ inbound_messages ·         │   │ (authoritative for STAGE)   │
│ outbound_messages ·        │   └────────────────────────────┘
│ pipeline_events · config   │
└───────────────────────────┘

Google Calendar API — event created when call slot confirmed (deterministic, never LLM)
Human works out of: HubSpot pipeline board + Gmail Drafts folder
```

### The one inviolable data-flow contract

**Agents NEVER pass state to each other.** Every hop carries only:

```json
{ "venue_id": "<supabase uuid>", "message_id": "<unipile/gmail message id>" }
```

Everything else is read fresh (Supabase for operational data, HubSpot for venue/stage data). Do not add fields to inter-agent payloads. Do not cache state between invocations. If a component needs data, it queries the source.

### Division of responsibility

- **Unipile** — everything between Gmail's servers and our webhook: OAuth consent, token refresh, inbox monitoring, normalized push delivery, outbound send with correct threading/MIME.
- **HubSpot** — who each venue is and where they stand: contact fields, deal stage, activity timeline. What a human looks at. **Authoritative for stage** (see reconciliation rule).
- **Supabase** — what the machine has done: idempotency, contact/email matching data, outbound message headers, audit log, operational config. What makes "nothing silently drops" provable.
- **Our code** — all decisions: classification, matching, ICP verdict, stage-transition validation, quota math, escalation.

### The four workers

**A — Drip Engine (deterministic, NOT an LLM).** Vercel cron at 9:00 and 13:00 CT (14:00/19:00 UTC — mind DST, Chicago flips CDT↔CST in November). Per run: check `paused` flag in `config` FIRST. Compute quota from warm-up table (days 1–3 → 15/day, days 4–6 → 30/day, day 7+ → 50/day hard cap; each run sends half the daily quota). Follow-ups take priority over new sends. Email 2 at +4 days, Email 3 at +9 days, only if `last_inbound_at IS NULL` and stage is `1_contacted`. **Suppression is checked at send time inside the send transaction, not schedule time** — a reply arriving 5 minutes before the cron must still suppress. Randomize send spacing 30–120s. Every send goes through the **Unipile send endpoint** (thread reference on follow-ups; Unipile handles RFC 2822 `In-Reply-To`/`References` and MIME assembly — but threading correctness still gets an exit test because broken threading = triage can't match inbound to venue). Every send: write to `outbound_messages` (capture the message id, `message_id_header`, thread id from Unipile's response), advance the HubSpot deal `0 Sourced → 1 Contacted` via CRM Writer's stage function, update `stage_cache`, log to `pipeline_events`. Bounces > 3% on any day → auto-pause via the `paused` flag.

**B — Triage / Email Extractor v2 (Claude LLM).** Event-driven Vercel function on the Unipile webhook: verify webhook signature → for each message not already in `inbound_messages` → classify. Input discipline: pass Claude ONLY subject, plain-text body with quoted history stripped (Unipile normalizes the payload, but **quoted-text stripping is still our job** — test Gmail, Outlook, and iPhone reply formats), attachment filenames + MIME types (never contents), thread id. Target < 1k input tokens. Output is a JSON packet validated with Zod before anything downstream runs:

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
- Sender resolving to Tier 5 / NONE in the matching cascade → no venue write, no draft.
- `auto_reply` must NOT advance stage, NOT cancel follow-ups, NOT trigger a draft.

**C — CRM Writer (deterministic code).** Runs in the same Vercel invocation as Triage, sequentially (no second queue hop at this volume). Conceptually separate because classification is probabilistic and allowed to be wrong 5% of the time; bookkeeping must be right 100% of the time. Steps:
1. Resolve inbound → venue via the tiered matching cascade (below)
2. **Supabase writes:** `inbound_messages` finalized, `last_inbound_at` on the mapping row (this is what kills pending follow-ups), `pipeline_events` entries
3. Compute ICP verdict IN CODE: `min_spend_usd ≤ 4200 AND fully_private AND capacity_ok`
4. **HubSpot writes:** update contact custom properties (ICP fields, `key_details`, `last_classification`, `needs_review` + reason) and advance the deal stage per the transition whitelist — with reconciliation (below)
5. If `reply_required = true` → invoke Drafting Agent with `{venue_id, message_id}` only

**Stage whitelist + reconciliation (replaces the v2 Postgres trigger):** HubSpot cannot enforce transition rules at the data layer, so the whitelist lives in CRM Writer, and **CRM Writer is the ONLY code path that moves deal stages.** Before any stage write: read the current HubSpot stage fresh. If it differs from `stage_cache`, HubSpot wins — adopt it, log `stage_conflict` to `pipeline_events`, and validate the transition from the HubSpot value. `stage_cache` is a cache, never truth. Illegal transition → move to `Needs Review` instead and log. A human dragging a card on the board is a legitimate action, not an error.

**D — Drafting Agent (Claude LLM).** Fires ONLY on `reply_required = true`. Creates a threaded **draft** (subject `Re: <original>`, correct reply headers, same thread) via Unipile's draft endpoint — or, if the Day-1 spike shows Unipile can't create Gmail drafts, via a single retained `googleapis` `drafts.create` call (one scope, one mailbox, published consent screen for that token only). Drafts must be sent from the same identity recorded in `outbound_messages.sent_from_address`. **NEVER sends.** Human reviews the Drafts folder twice daily, edits, hits send.

Context packet (assembled by code, not fetched by the LLM):
1. Cleaned thread — most recent 3 messages verbatim, older summarized (via Unipile thread endpoint)
2. The venue's record — HubSpot contact properties + deal stage, fetched fresh by ID, plus the Supabase mapping row
3. Triage's `key_details` list — **every item must be either addressed in the draft or listed in an escalation note.** The drafter cannot ignore a detail.
4. The playbook for the classification:
   - `pricing_info` → confirm fit, request formal proposal / deposit terms / AV confirmation
   - `question` → answer from the canned event brief (75+ guests, fully private, budget band, AV)
   - `partnership_interest` → propose 2–3 concrete call slots pulled from Calendar free/busy (so slots are actually free)
   - `rejection` → polite close; CRM marks `Lost`
5. Hard rule (prompt AND code-checked): missing info → draft starts with `[ESCALATION: …]` rather than an invented fact. `[ESCALATION` in a draft flips `needs_review` on the record so it surfaces in the digest and on the HubSpot board.

## HubSpot configuration

Free tier constraints that shape the design (verify current numbers under Usage & Limits):
- ~1,000-contact cap on newer free accounts — 500 Chicago venues fit; a second city triggers the Sales Hub Starter (~$15–20/seat/mo) decision
- 2 users, **1 deal pipeline**, **10 custom properties** (the binding constraint)
- No workflows/sequences on free — irrelevant; the Drip Engine is better for this use case

**Pipeline stages** (one deal per venue):

```
0 Sourced → 1 Contacted → 2 Responded → 3 In ICP → 4 Proposal Received
→ 5 Partnership Interest → 6 Call Scheduled → 7 Call Completed → 8 Onboarded
Closed-lost variants: Lost · Bounced · Needs Review
```

**Custom-property budget (exactly 10 — map name/email/phone/city to built-ins):**
1. `icp_verdict` (bool) 2. `min_spend_usd` (number) 3. `fully_private` (bool) 4. `capacity_ok` (bool) 5. `needs_review` (bool) 6. `review_reason` (text) 7. `key_details` (multiline text) 8. `thread_id` (text) 9. `last_classification` (text) 10. reserved. Do not add an 11th — consolidate into `key_details` or trigger the upgrade decision.

Auth: **private app token** in Vercel env vars (~100 req/10s burst limit — far above this volume; batch the initial venue migration).

Venues with `contact_method != 'email'` are tracked (Supabase + optionally HubSpot at `0 Sourced`) but excluded from Drip Engine's send query and never enter the automated funnel.

## Supabase schema (operational spine)

Venue truth (name, contact fields, ICP, stage) lives in HubSpot; Supabase keeps the mapping row plus everything the machine needs for matching, idempotency, and audit.

```sql
-- Mapping + operational cache. HubSpot owns the human-facing fields.
create table venues (
  id uuid primary key default gen_random_uuid(),
  hubspot_contact_id text unique,
  hubspot_deal_id text unique,
  name text not null,                 -- convenience copy for logs/digest
  contact_method text not null default 'email',  -- 'email' | 'web_form' | 'phone' | 'none'
  stage_cache text default '0_sourced',           -- cache only; HubSpot is truth
  thread_id text,
  email_1_sent_at timestamptz,
  email_2_sent_at timestamptz,
  email_3_sent_at timestamptz,
  last_inbound_at timestamptz,
  bounced boolean default false,
  source_system text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Multiple contacts per venue; supports cross-account reply matching (UNCHANGED)
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

-- Idempotency ledger: message_id PK makes reprocessing a no-op
create table inbound_messages (
  message_id text primary key,        -- Unipile/Gmail message id: universal dedup key
  thread_id text not null,
  venue_id uuid references venues(id),   -- nullable: unmatched senders start null
  sender_email text,
  match_confidence text default 'NONE',  -- 'HIGH' | 'MEDIUM' | 'NONE'
  status text not null default 'processing',  -- 'processing' | 'done' | 'error' — claim row BEFORE any LLM call
  reviewed boolean default false,
  classification text,
  extraction jsonb,
  confidence numeric,
  needs_human_review boolean,
  reply_required boolean,
  processed_at timestamptz default now()
);

-- Every outbound send; enables In-Reply-To matching for cross-account replies (UNCHANGED)
create table outbound_messages (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid references venues(id) not null,
  message_id text not null,          -- id from Unipile's send response
  message_id_header text not null,   -- RFC Message-ID for In-Reply-To lookups
  thread_id text not null,
  sent_from_address text not null,   -- drafts must reply from the same identity
  sent_at timestamptz default now()
);
create index on outbound_messages (message_id_header);
create index on outbound_messages (thread_id);

-- Append-only event log: debugging + audit + "nothing silently drops" (UNCHANGED)
create table pipeline_events (
  id bigserial primary key,
  venue_id uuid,
  message_id text,
  actor text,   -- 'drip' | 'triage' | 'crm' | 'drafter' | 'human' | 'unipile'
  event text,   -- 'sent_email_1', 'classified', 'draft_created', 'stage_conflict', 'error', ...
  detail jsonb,
  created_at timestamptz default now()
);

-- Operational config: kill switch, warm-up day counter, bounce tally
create table config (
  key text primary key,
  value jsonb,
  updated_at timestamptz default now()
);
```

Deleted from v2: the Postgres stage-transition trigger (whitelist moved to CRM Writer — see reconciliation rule), `lastHistoryId` bookkeeping, funnel roll-up views (HubSpot's board/reports replace them).

Always use the **Supavisor pooled connection string** — serverless functions will exhaust the 60-connection cap on the direct one.

## Venue matching cascade (CRM Writer, deterministic — UNCHANGED from v2)

Replies don't always come from the address you emailed. Resolution runs top-down; first match wins:

1. **Tier 1 — thread match.** Thread id matches an existing pipeline thread → HIGH confidence.
2. **Tier 1.5 — In-Reply-To header.** Inbound's `In-Reply-To`/`References` contains a `message_id_header` we generated (lookup in `outbound_messages`) → HIGH. Survives cross-account replies and forwards.
3. **Tier 2 — known contact.** Sender email exists in `venue_contacts`. If exactly one venue → HIGH. **If the email maps to multiple venues (`shared_contact = true`, e.g. an agency inbox) → MEDIUM at best, route to digest.**
4. **Tier 3 — domain match.** Sender's domain matches exactly one venue's contacts → MEDIUM. Auto-link, insert into `venue_contacts` as `pending_review`, flag in daily digest. **Skip auto-link if `is_agency_domain = true`** — agency domains can represent multiple venues.
5. **Tier 4 — body/header token.** Deferred (later iteration). Not implemented in v1 — matching uses thread + contact only for now.
6. **Tier 5 — no match.** `venue_id = null`, `match_confidence = 'NONE'`, message logged, **Drafting Agent is NOT invoked**, surfaces in digest for manual linking.

MEDIUM still drafts (don't lose response speed on "new employee at a known venue"). NONE never drafts — drafting against a wrong/absent venue record is worse than a delayed reply. Same escalate-don't-invent principle as the contract firewall.

## Unipile plumbing — what replaced the Gmail gotchas

Setup: link the sending mailbox via Unipile's hosted OAuth flow; register ONE webhook (`/api/inbound`) for new-message events; verify the webhook signature in the handler; API key + account id in Vercel env vars. No GCP Pub/Sub topic, no `users.watch()`, no consent-screen publishing (unless the drafts fallback is needed), no historyId sync.

**Gone from v2** (each was a silent-death mode): watch expiry + renewal cron, empty Pub/Sub payloads + `history.list` + 404 fallback, OAuth refresh-token death in Testing mode.

**Still ours — do not skip:**
1. **At-least-once discipline.** Treat Unipile webhooks like Pub/Sub: duplicates are normal, not a bug. The `message_id` PK absorbs them.
2. **Ack after commit.** Return 200 only AFTER the `inbound_messages` row commits. Crash mid-processing → redelivery → idempotent no-op.
3. **Claim before LLM.** Insert the `inbound_messages` row with `status='processing'` BEFORE invoking Claude, so a redelivery mid-Triage can't double-classify.
4. **Daily Unipile canary.** One trivial Unipile API call per day + check that ≥1 webhook arrived in the last 24h during active periods; alert on failure. Trust the vendor, verify daily.
5. **Reconciliation cron (self-healing backstop).** Confirm Unipile's redelivery window during the Day-1 spike; regardless, run a cron that lists recent messages via the Unipile API and back-fills any missing `inbound_messages` rows. ~20 lines against a normalized API; replaces the old historyId fallback.
6. **Inbound scoping.** Confirm during the spike that new-message events are inbound-only (don't triage our own sends or manual replies from the shared mailbox); filter by folder/direction if needed.

## Known problem list (ranked by likelihood × pain)

1. **Unipile webhook duplicates/ordering** — idempotency + claim-before-LLM + ack-after-commit
2. **HubSpot 10-custom-property ceiling** — budget is exact; the first "just add a field" breaks it
3. **Human/HubSpot stage edits conflicting with pipeline writes** — reconciliation rule, built day one
4. **Quoted-text pollution** — strip quoted history or Triage extracts our own template's numbers as the venue's pricing. Test Gmail, Outlook, iPhone reply formats
5. **Auto-replies / OOO loops** — `auto_reply` must NOT advance stage, cancel follow-ups, or trigger a draft
6. **Cross-account / agency replies** — the matching cascade + `is_agency_domain` guards; never auto-link agency domains
7. **Attachment-heavy proposals** — "see attached" + PDF: flag `attachment_pending`; the drafter must not claim to have read a PDF it hasn't
8. **Follow-up race conditions** — re-check `last_inbound_at` inside the send transaction
9. **Unipile outage / account disconnection** — canary + reconciliation cron mean delayed, never lost; disconnection alerts same-day
10. **HubSpot API rate limits** — fine at this volume; batch migrations/backfills
11. **Claude API 529s** — retry with backoff; webhook redelivery + reconciliation cron are the backstop
12. **DST cron drift** — Vercel crons are UTC; Chicago flips in November; log local time
13. **Supabase connection cap (60)** — Supavisor pooled connection string, never the direct one
14. **Vercel timeouts** — far less scary than v2 assumed (Fluid Compute defaults 300s; Pro up to 800s+). Keep Pro; a single-message function should never time out

## Failure handling & observability

- **Daily digest email (cron):** `needs_review` records with reasons, yesterday's sends/bounces/replies, MEDIUM/NONE-confidence inbound for review, Unipile canary status, any `stage_conflict` events. Funnel visibility now lives on the HubSpot board, so the digest is exceptions-only. The single 5-minute morning check.
- **Retries:** Vercel error → webhook redelivery + idempotency = at-least-once delivery with exactly-once effect. The reconciliation cron catches anything past the redelivery window.
- **Poison pills:** a message failing 5x gets a `pipeline_events` error row + `needs_review` flag and MUST surface in the digest — a dead message that isn't in the digest is silently dropped by definition.
- **Statelessness:** everything is functions + one ledger + one CRM. Total redeploy loses nothing.
- **Kill switch:** one `paused` flag in `config`, checked first by the drip cron, honored within one run. Any spam-folder report → set it, wait 48h.

## Build order (~10 days target)

| Days | Work | Exit test |
|---|---|---|
| 1 | **Spike + accounts:** Unipile mailbox link, webhook received + signature verified, **draft-creation support confirmed**, inbound-only scoping confirmed, redelivery policy noted; HubSpot portal, pipeline stages, 10 properties, private app; 20 test venues pushed via API | Test email → normalized webhook payload; deals visible on the board |
| 2 | Supabase schema + mapping/contacts/ledger/log/config; migrate current venues to HubSpot, write back IDs; Vercel project, env vars | Twice-delivered webhook written once; every email-eligible venue has HubSpot IDs |
| 3–4 | Drip Engine: quota, warm-up, follow-ups, suppression-at-send-time, bounce pause, kill switch, `outbound_messages` writes — via Unipile | Dry-run logs intended sends; live test to 5 seeds; a reply suppresses its own follow-up; sends thread correctly |
| 5–6 | Triage v2 + CRM Writer: prompt, Zod validation, contract firewall, **matching cascade**, dual write, stage whitelist + reconciliation, claim-before-LLM | **Replay 25 labeled NYC emails → ≥95% accuracy, ALL contracts escalated, zero duplicate rows; unrecognized-sender email resolves to the correct tier, never wrongly attached; deals advance correctly on the board** |
| 7–8 | Drafting Agent: context packet, playbooks, escalation rule, threaded draft creation | Seeded pricing email → threaded draft < 10 min addressing every key_detail |
| 9–10 | End-to-end soak with 10 seed contacts; daily digest; Unipile canary; reconciliation cron; calendar hook; one deliberately induced crash | Full loop with laptop off; crash recovered via redelivery/reconciliation; redelivered message mid-Triage does not double-classify; manual card drag reconciled, not clobbered |
| 11+ | Warm-up sends begin (15/day) on the real Chicago queue | Leading indicators per playbook |

**No real venue receives an email before warm-up day 1.** All prior days use test addresses and seed contacts only.

**The replay harness (Day 5) is the highest-leverage artifact:** a folder of real, hand-labeled NYC emails re-run against every prompt change. It turns "the prompt feels better" into a number and holds the ≥95% bar without burning live leads.

## Current data state

Supabase already holds the Chicago sourcing import:
- **12 venues** with `contact_method = 'email'` and a `venue_contacts` row each (Aire Rooftop Bar, Broken English Taco Pub, Frontera Grill, Outside the Box Catering, Petit Pomeroy, Private Affairs, Smith & Wollensky, The Good Eating Company, Waterview, Gilt Bar, The Game Room, Ciccio Mio)
- Waterview (`firsthospitality.com`) and The Game Room (`caa.bokagrp.com`) are flagged `is_agency_domain = true` — management-group inboxes, not venue-owned domains
- **12 more venues** with `contact_method` of `web_form` (6), `phone` (2), or `none` (4) — tracked but excluded from the automated pipeline
- All emails are lowercased and trimmed at import; `unique(venue_id, email)` enforced
- **Migration task (Day 2):** push email-eligible venues into HubSpot as contact + deal at `0 Sourced`; write `hubspot_contact_id`/`hubspot_deal_id` back to the mapping rows
- The queue grows toward ≥500 validated candidates; the pipeline must not assume the current small count. At ~1,000 contacts the HubSpot free cap forces the Starter upgrade decision.

## Stack

- **Unipile** (~$5/mo, 1 linked mailbox) — email transport: OAuth, sync, webhooks, send, threading, drafts (pending spike)
- **HubSpot free CRM** ($0) — venue records, deal pipeline, timeline, reporting UI; private app token
- **Supabase** (Postgres, $0) — operational spine. Supavisor pooled connection string only.
- **Vercel Pro** ($20/mo) — all serverless functions + crons + observability
- **Google Calendar API** — free/busy for slot proposals; deterministic event creation (never LLM-driven)
- **Gmail API** — contingency only: `drafts.create` if Unipile can't create drafts (one scope, published consent screen for that token)
- **Claude API (Sonnet)** (~$10–25/mo) — Triage v2 classification+extraction, Drafting Agent generation
- **Node.js / TypeScript** — all functions
- **Zod** — JSON schema validation on every Triage output before anything downstream trusts it
- **@hubspot/api-client · supabase-js · Unipile SDK (or fetch)** — API clients
- **Git + GitHub → Vercel auto-deploy**
- **Postmaster Tools** ($0) — domain reputation dashboard

Budget: Unipile ~$5 + Vercel Pro $20 + Claude ~$10–25 + free tiers ≈ **$35–50/mo** (cap: $75).

## Engineering principles (apply to every component)

1. **LLMs classify and draft. Code decides and writes.** ICP verdicts, stage transitions, calendar events, venue matching — all deterministic. Never let an LLM guess identity, write to the calendar, or advance the funnel.
2. **Escalate, never invent.** Missing info → `[ESCALATION]`, `needs_review`, or a digest entry. Applies to contracts, low confidence, unmatched senders, unread attachments.
3. **Idempotency everywhere.** `message_id` is the universal dedup key. Every write must be safe to replay. Claim the ledger row before any LLM call.
4. **Nothing silently drops.** Every inbound is logged in `pipeline_events` even when it can't be processed. Failures surface in the digest, never the void. Vendor trust is verified by the daily canary + reconciliation cron.
5. **Scoped context.** < 4k tokens per LLM invocation, < 1k for Triage input. No bloated threads, no full mailbox context.
6. **One writer for stage.** CRM Writer is the only code path that moves HubSpot deal stages; HubSpot is authoritative when a human has edited; every conflict is logged, never clobbered.
7. **Supabase for machine state, HubSpot for human state.** Don't duplicate human-facing fields into Supabase beyond the cache columns; don't put idempotency/audit data in HubSpot.
8. **Functions are stateless.** The ledger + CRM are the only state. Redeploy at any time.

## Definition of done

With the laptop off for 72 hours straight: every inbound email is classified and written to both Supabase and HubSpot within 10 minutes, every reply-required message has a threaded draft waiting, follow-ups fire and suppress correctly, the Unipile canary reports healthy, the HubSpot board reflects reality, and the daily digest arrives each morning — with nothing silently dropped.