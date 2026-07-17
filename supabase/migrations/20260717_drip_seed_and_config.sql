-- Day 3: seed allowlist + drip config
ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS is_seed boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS venues_is_seed_idx ON venues (is_seed) WHERE is_seed = true;

UPDATE venues SET is_seed = false WHERE is_seed IS DISTINCT FROM true;

INSERT INTO config (key, value, updated_at) VALUES
  ('paused', 'true'::jsonb, now()),
  ('drip_dry_run', 'true'::jsonb, now())
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = now();

INSERT INTO config (key, value, updated_at) VALUES
  ('warmup_day', '1'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

INSERT INTO config (key, value, updated_at) VALUES
  ('bounce_stats', '{"date": null, "sent": 0, "bounced": 0}'::jsonb, now())
ON CONFLICT (key) DO NOTHING;
