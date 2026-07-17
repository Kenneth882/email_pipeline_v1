/**
 * Shared HubSpot REST client (private app token).
 */

export async function hs<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error("Missing HUBSPOT_ACCESS_TOKEN");

  const res = await fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`HubSpot ${method} ${path} → ${res.status}: ${text}`);
  }
  return json as T;
}

export type ContactPropertyUpdates = {
  icp_verdict?: boolean | null;
  min_spend_usd?: number | null;
  fully_private?: boolean | null;
  capacity_ok?: boolean | null;
  needs_review?: boolean | null;
  review_reason?: string | null;
  key_details?: string | null;
  thread_id?: string | null;
  last_classification?: string | null;
};

function boolProp(v: boolean | null | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  return v ? "true" : "false";
}

/**
 * PATCH contact custom properties. Omits undefined keys; null clears to "".
 */
export async function updateContactProperties(
  contactId: string,
  props: ContactPropertyUpdates,
): Promise<void> {
  const properties: Record<string, string> = {};

  const icp = boolProp(props.icp_verdict);
  if (icp !== undefined) properties.icp_verdict = icp;

  if (props.min_spend_usd !== undefined) {
    properties.min_spend_usd =
      props.min_spend_usd === null ? "" : String(props.min_spend_usd);
  }

  const fully = boolProp(props.fully_private);
  if (fully !== undefined) properties.fully_private = fully;

  const cap = boolProp(props.capacity_ok);
  if (cap !== undefined) properties.capacity_ok = cap;

  const review = boolProp(props.needs_review);
  if (review !== undefined) properties.needs_review = review;

  if (props.review_reason !== undefined) {
    properties.review_reason = props.review_reason ?? "";
  }
  if (props.key_details !== undefined) {
    properties.key_details = props.key_details ?? "";
  }
  if (props.thread_id !== undefined) {
    properties.thread_id = props.thread_id ?? "";
  }
  if (props.last_classification !== undefined) {
    properties.last_classification = props.last_classification ?? "";
  }

  if (Object.keys(properties).length === 0) return;

  await hs("PATCH", `/crm/v3/objects/contacts/${contactId}`, { properties });
}
