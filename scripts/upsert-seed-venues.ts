/**
 * Upsert up to 5 seed venues for drip live tests (is_seed=true).
 * Does NOT mark the 12 Chicago venues as seed.
 *
 * Usage:
 *   SEED_EMAILS=you@gmail.com,alt@gmail.com npm run seed:upsert
 * Or edit DEFAULT_SEEDS below.
 */

import { createClient } from "@supabase/supabase-js";

const DEFAULT_SEEDS = [
  { name: "Seed Venue 1", email: "" },
  { name: "Seed Venue 2", email: "" },
  { name: "Seed Venue 3", email: "" },
  { name: "Seed Venue 4", email: "" },
  { name: "Seed Venue 5", email: "" },
];

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase env");

  const fromEnv = (process.env.SEED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const seeds = DEFAULT_SEEDS.map((s, i) => ({
    name: s.name,
    email: fromEnv[i] || s.email,
  })).filter((s) => s.email);

  if (!seeds.length) {
    console.error(
      "Provide SEED_EMAILS=a@x.com,b@y.com (up to 5) — will not use real Chicago venues.",
    );
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  for (const seed of seeds) {
    const { data: existingContact } = await supabase
      .from("venue_contacts")
      .select("venue_id, venues(id, name, is_seed)")
      .eq("email", seed.email)
      .maybeSingle();

    if (existingContact?.venue_id) {
      await supabase
        .from("venues")
        .update({
          is_seed: true,
          contact_method: "email",
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingContact.venue_id);
      console.log(`updated existing → seed: ${seed.email}`);
      continue;
    }

    const { data: venue, error: vErr } = await supabase
      .from("venues")
      .insert({
        name: seed.name,
        city: "Chicago",
        contact_method: "email",
        stage_cache: "0_sourced",
        is_seed: true,
        source_system: "seed_test",
      })
      .select("id")
      .single();

    if (vErr || !venue) throw new Error(vErr?.message ?? "venue insert failed");

    const { error: cErr } = await supabase.from("venue_contacts").insert({
      venue_id: venue.id,
      email: seed.email,
      is_primary: true,
      source: "seed_import",
      confidence: "confirmed",
    });
    if (cErr) throw new Error(cErr.message);

    console.log(`created seed venue ${seed.name} → ${seed.email} (${venue.id})`);
  }

  console.log(
    "\nNext: run HubSpot migrate for seeds missing IDs, keep DRIP_DRY_RUN=true until ready,",
  );
  console.log("then set paused=false + drip_dry_run=false only for seed live test.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
