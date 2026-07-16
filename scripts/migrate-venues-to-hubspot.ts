/**
 * Day 2: ensure 10 HubSpot contact properties, create contact + deal
 * at "0 Sourced" for each email-eligible venue, write IDs back to Supabase.
 *
 * Usage: npx tsx --env-file=.env scripts/migrate-venues-to-hubspot.ts
 */

import { createClient } from "@supabase/supabase-js";

const HS_BASE = "https://api.hubapi.com";

const CUSTOM_PROPERTIES: Array<{
  name: string;
  label: string;
  type: string;
  fieldType: string;
}> = [
  {
    name: "icp_verdict",
    label: "ICP Verdict",
    type: "bool",
    fieldType: "booleancheckbox",
  },
  {
    name: "min_spend_usd",
    label: "Min Spend USD",
    type: "number",
    fieldType: "number",
  },
  {
    name: "fully_private",
    label: "Fully Private",
    type: "bool",
    fieldType: "booleancheckbox",
  },
  {
    name: "capacity_ok",
    label: "Capacity OK",
    type: "bool",
    fieldType: "booleancheckbox",
  },
  {
    name: "needs_review",
    label: "Needs Review",
    type: "bool",
    fieldType: "booleancheckbox",
  },
  {
    name: "review_reason",
    label: "Review Reason",
    type: "string",
    fieldType: "text",
  },
  {
    name: "key_details",
    label: "Key Details",
    type: "string",
    fieldType: "textarea",
  },
  {
    name: "thread_id",
    label: "Thread ID",
    type: "string",
    fieldType: "text",
  },
  {
    name: "last_classification",
    label: "Last Classification",
    type: "string",
    fieldType: "text",
  },
  {
    name: "reserved",
    label: "Reserved",
    type: "string",
    fieldType: "text",
  },
];

type HsJson = Record<string, unknown>;

async function hs<T = HsJson>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${HS_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }

  if (!res.ok) {
    throw new Error(
      `HubSpot ${method} ${path} → ${res.status}: ${JSON.stringify(json)}`,
    );
  }

  return json as T;
}

async function ensureCustomProperties(token: string) {
  const existing = await hs<{ results: Array<{ name: string }> }>(
    token,
    "GET",
    "/crm/v3/properties/contacts?archived=false",
  );
  const names = new Set(existing.results.map((p) => p.name));
  const missing: typeof CUSTOM_PROPERTIES = [];

  for (const prop of CUSTOM_PROPERTIES) {
    if (names.has(prop.name)) {
      console.log(`  property exists: ${prop.name}`);
      continue;
    }
    missing.push(prop);
  }

  for (const prop of missing) {
    try {
      await hs(token, "POST", "/crm/v3/properties/contacts", {
        name: prop.name,
        label: prop.label,
        type: prop.type,
        fieldType: prop.fieldType,
        groupName: "contactinformation",
      });
      console.log(`  property created: ${prop.name}`);
      names.add(prop.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("403") || msg.includes("MISSING_SCOPES")) {
        console.warn(
          `  cannot create ${prop.name}: private app needs crm.schemas.contacts.write (or create manually in HubSpot UI)`,
        );
      } else {
        throw err;
      }
    }
  }

  const stillMissing = CUSTOM_PROPERTIES.filter((p) => !names.has(p.name)).map(
    (p) => p.name,
  );
  if (stillMissing.length) {
    console.warn(
      `  WARNING: missing contact properties: ${stillMissing.join(", ")}`,
    );
    console.warn(
      "  Continuing migration (contacts/deals). Add properties before Triage/CRM Writer.",
    );
  } else {
    console.log("  all 10 custom properties present");
  }
}

async function resolveSourcedStageId(token: string): Promise<{
  pipelineId: string;
  stageId: string;
}> {
  const pipelines = await hs<{
    results: Array<{
      id: string;
      label: string;
      stages: Array<{ id: string; label: string }>;
    }>;
  }>(token, "GET", "/crm/v3/pipelines/deals");

  if (!pipelines.results?.length) {
    throw new Error("No HubSpot deal pipelines found");
  }

  // Prefer a pipeline that has "0 Sourced"; else first pipeline.
  for (const pipeline of pipelines.results) {
    const stage = pipeline.stages.find(
      (s) =>
        s.label.trim().toLowerCase() === "0 sourced" ||
        s.label.trim().toLowerCase() === "0_sourced",
    );
    if (stage) {
      console.log(
        `  pipeline=${pipeline.label} (${pipeline.id}) stage=${stage.label} (${stage.id})`,
      );
      return { pipelineId: pipeline.id, stageId: stage.id };
    }
  }

  const first = pipelines.results[0];
  const labels = first.stages.map((s) => s.label).join(", ");
  throw new Error(
    `Could not find stage "0 Sourced" in any pipeline. First pipeline stages: ${labels}`,
  );
}

function splitName(name: string): { firstname: string; lastname: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { firstname: parts[0], lastname: "Venue" };
  return {
    firstname: parts[0],
    lastname: parts.slice(1).join(" "),
  };
}

async function main() {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!token) throw new Error("Missing HUBSPOT_ACCESS_TOKEN");
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log("1) Ensuring 10 custom contact properties…");
  await ensureCustomProperties(token);

  console.log("2) Resolving deal pipeline stage “0 Sourced”…");
  const { pipelineId, stageId } = await resolveSourcedStageId(token);

  console.log("3) Loading email-eligible venues from Supabase…");
  const { data: venues, error: venuesError } = await supabase
    .from("venues")
    .select(
      "id, name, city, phone, website, contact_method, hubspot_contact_id, hubspot_deal_id, venue_contacts(email, is_primary)",
    )
    .eq("contact_method", "email");

  if (venuesError) throw new Error(venuesError.message);
  if (!venues?.length) {
    console.log("No email venues found.");
    return;
  }

  let created = 0;
  let skipped = 0;

  for (const venue of venues) {
    if (venue.hubspot_contact_id && venue.hubspot_deal_id) {
      console.log(`  skip (already migrated): ${venue.name}`);
      skipped += 1;
      continue;
    }

    const contacts = (venue.venue_contacts ?? []) as Array<{
      email: string;
      is_primary: boolean | null;
    }>;
    const primary =
      contacts.find((c) => c.is_primary) ?? contacts[0] ?? null;
    if (!primary?.email) {
      console.warn(`  skip (no contact email): ${venue.name}`);
      skipped += 1;
      continue;
    }

    const { firstname, lastname } = splitName(venue.name);
    const contactProps: Record<string, string> = {
      email: primary.email.toLowerCase().trim(),
      firstname,
      lastname,
      company: venue.name,
    };
    if (venue.phone) contactProps.phone = venue.phone;
    if (venue.city) contactProps.city = venue.city;
    if (venue.website) contactProps.website = venue.website;

    let contactId = venue.hubspot_contact_id as string | null;
    if (!contactId) {
      try {
        const createdContact = await hs<{ id: string }>(
          token,
          "POST",
          "/crm/v3/objects/contacts",
          { properties: contactProps },
        );
        contactId = createdContact.id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Conflict: look up by email
        if (msg.includes("409") || msg.toLowerCase().includes("already")) {
          const search = await hs<{
            results: Array<{ id: string }>;
          }>(token, "POST", "/crm/v3/objects/contacts/search", {
            filterGroups: [
              {
                filters: [
                  {
                    propertyName: "email",
                    operator: "EQ",
                    value: contactProps.email,
                  },
                ],
              },
            ],
            limit: 1,
          });
          contactId = search.results[0]?.id ?? null;
          if (!contactId) throw err;
          console.log(`  reused existing contact for ${venue.name}: ${contactId}`);
        } else {
          throw err;
        }
      }
    }

    let dealId = venue.hubspot_deal_id as string | null;
    if (!dealId) {
      const createdDeal = await hs<{ id: string }>(
        token,
        "POST",
        "/crm/v3/objects/deals",
        {
          properties: {
            dealname: venue.name,
            pipeline: pipelineId,
            dealstage: stageId,
          },
          associations: [
            {
              to: { id: contactId },
              types: [
                {
                  associationCategory: "HUBSPOT_DEFINED",
                  associationTypeId: 3, // contact_to_deal
                },
              ],
            },
          ],
        },
      );
      dealId = createdDeal.id;
    }

    const { error: updateError } = await supabase
      .from("venues")
      .update({
        hubspot_contact_id: contactId,
        hubspot_deal_id: dealId,
        stage_cache: "0_sourced",
        updated_at: new Date().toISOString(),
      })
      .eq("id", venue.id);

    if (updateError) {
      throw new Error(
        `Supabase update failed for ${venue.name}: ${updateError.message}`,
      );
    }

    console.log(
      `  migrated: ${venue.name} → contact=${contactId} deal=${dealId}`,
    );
    created += 1;

    // Gentle pacing under HubSpot free burst limits
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(
    `\nDone. migrated=${created} skipped=${skipped} total=${venues.length}`,
  );

  const { data: check, error: checkError } = await supabase
    .from("venues")
    .select("id")
    .eq("contact_method", "email")
    .or("hubspot_contact_id.is.null,hubspot_deal_id.is.null");

  if (checkError) throw new Error(checkError.message);
  if (check?.length) {
    console.warn(
      `WARNING: ${check.length} email venue(s) still missing HubSpot IDs`,
    );
    process.exitCode = 1;
  } else {
    console.log("Exit check: every email venue has HubSpot contact + deal IDs.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
