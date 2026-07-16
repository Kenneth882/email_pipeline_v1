-- Day 2: reshape to v3 Unipile + HubSpot ops spine
-- Preserve venues + venue_contacts rows; recreate empty message tables.
-- Project: email_pipeline_chicago_v1

-- 1) venues: add HubSpot mapping + ops cache columns
ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS hubspot_contact_id text,
  ADD COLUMN IF NOT EXISTS hubspot_deal_id text,
  ADD COLUMN IF NOT EXISTS stage_cache text,
  ADD COLUMN IF NOT EXISTS thread_id text,
  ADD COLUMN IF NOT EXISTS email_1_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_2_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_3_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_inbound_at timestamptz,
  ADD COLUMN IF NOT EXISTS bounced boolean DEFAULT false;

-- Map legacy stage -> stage_cache, then drop stage
UPDATE venues
SET stage_cache = CASE
  WHEN stage = 'sourced' THEN '0_sourced'
  WHEN stage IS NULL OR stage = '' THEN '0_sourced'
  ELSE stage
END
WHERE stage_cache IS NULL;

ALTER TABLE venues
  ALTER COLUMN stage_cache SET DEFAULT '0_sourced';

UPDATE venues SET stage_cache = '0_sourced' WHERE stage_cache IS NULL;

ALTER TABLE venues DROP COLUMN IF EXISTS stage;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'venues_hubspot_contact_id_key'
  ) THEN
    ALTER TABLE venues ADD CONSTRAINT venues_hubspot_contact_id_key UNIQUE (hubspot_contact_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'venues_hubspot_deal_id_key'
  ) THEN
    ALTER TABLE venues ADD CONSTRAINT venues_hubspot_deal_id_key UNIQUE (hubspot_deal_id);
  END IF;
END $$;

-- 2) venue_contacts: unique + indexes
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'venue_contacts_venue_id_email_key'
  ) THEN
    ALTER TABLE venue_contacts ADD CONSTRAINT venue_contacts_venue_id_email_key UNIQUE (venue_id, email);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS venue_contacts_email_idx ON venue_contacts (email);
CREATE INDEX IF NOT EXISTS venue_contacts_venue_id_idx ON venue_contacts (venue_id);

-- 3) Drop empty Gmail-shaped message / event tables
DROP TABLE IF EXISTS inbound_messages;
DROP TABLE IF EXISTS outbound_messages;
DROP TABLE IF EXISTS pipeline_events;

-- 4) inbound_messages (idempotency ledger; PK = Unipile email_id)
CREATE TABLE inbound_messages (
  message_id text PRIMARY KEY,
  thread_id text NOT NULL,
  venue_id uuid REFERENCES venues(id),
  sender_email text,
  match_confidence text DEFAULT 'NONE',
  status text NOT NULL DEFAULT 'processing',
  reviewed boolean DEFAULT false,
  classification text,
  extraction jsonb,
  confidence numeric,
  needs_human_review boolean,
  reply_required boolean,
  processed_at timestamptz DEFAULT now()
);

-- 5) outbound_messages
CREATE TABLE outbound_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid REFERENCES venues(id) NOT NULL,
  message_id text NOT NULL,
  message_id_header text NOT NULL,
  thread_id text NOT NULL,
  sent_from_address text NOT NULL,
  sent_at timestamptz DEFAULT now()
);
CREATE INDEX outbound_messages_message_id_header_idx ON outbound_messages (message_id_header);
CREATE INDEX outbound_messages_thread_id_idx ON outbound_messages (thread_id);

-- 6) pipeline_events
CREATE TABLE pipeline_events (
  id bigserial PRIMARY KEY,
  venue_id uuid,
  message_id text,
  actor text,
  event text,
  detail jsonb,
  created_at timestamptz DEFAULT now()
);

-- 7) config + seed paused = false
CREATE TABLE IF NOT EXISTS config (
  key text PRIMARY KEY,
  value jsonb,
  updated_at timestamptz DEFAULT now()
);

INSERT INTO config (key, value)
VALUES ('paused', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE inbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE config ENABLE ROW LEVEL SECURITY;
