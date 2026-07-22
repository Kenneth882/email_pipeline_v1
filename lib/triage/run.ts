import Anthropic from "@anthropic-ai/sdk";
import { applyTriageFirewall } from "@/lib/triage/firewall";
import {
  triageResultSchema,
  type TriageInput,
  type TriageResult,
} from "@/lib/triage/schema";

const SYSTEM = `You classify inbound venue-outreach replies for VenueHopper (Chicago private events).
Return ONLY valid JSON matching this shape:
{
  "thread_id": string,
  "classification": "pricing_info"|"proposal"|"contract"|"question"|"partnership_interest"|"rejection"|"bounce"|"auto_reply"|"out_of_scope",
  "extracted": {
    "min_spend_usd": number|null,
    "fully_private": boolean|null,
    "capacity_ok": boolean|null,
    "contact_name": string|null,
    "proposed_dates": string[],
    "key_details": string[],
    "fees": {
      "fb_minimum_usd": number|null,
      "room_rental_usd": number|null,
      "after_hours_usd_per_hour": number|null,
      "venue_close_hour_local": number|null,
      "staff": [{"role": string, "count": number, "rate_usd_per_hour": number, "min_hours": number}]|null,
      "sales_tax_pct": number|null,
      "processing_fee_pct": number|null,
      "gratuity_pct": number|null,
      "gratuity_mandatory": boolean|null,
      "building_fees_unknown": boolean|null
    }|null
  },
  "confidence": number,
  "needs_human_review": boolean,
  "reply_required": boolean
}
Rules:
- Put every commercial/logistical fact into key_details (fees, minimums, blackouts, deposits, capacity caveats).
- Also extract structured fee line items into fees when stated. Never invent fee numbers — use null / omit.
- min_spend_usd AND fees.fb_minimum_usd: set both from a clear F&B / food & beverage minimum when stated.
- Room rental / space fee / facility fee / space buyout (even when F&B is additional): set fees.room_rental_usd. If peak and non-peak both stated, use the lowest (e.g. non-peak $5,000). Add a key_details line like "Room rental $5000 (F&B additional)".
- When room rental is stated and no F&B minimum is stated, also set min_spend_usd = fees.room_rental_usd so spend gates still fire.
- When BOTH F&B minimum and room rental are stated: min_spend_usd / fb_minimum_usd = F&B only; fees.room_rental_usd = rental (all-in math adds them).
- venue_close_hour_local: 24h local hour (e.g. 19 if they operate until 7pm). null if unstated.
- staff: one row per required role (bartender, attendant, etc.) with count, hourly rate, and min hours when stated.
- gratuity_mandatory: true only if tip/gratuity is required; false if optional/appreciated; null if unmentioned.
- building_fees_unknown: true when they mention building/landlord fees that vary or need follow-up.
- fees: null when the email has no fee line items beyond a simple min spend (still set min_spend_usd).
- Soft hold (deposit / signed contract to hold or secure the date, inside an otherwise commercial pricing_info or proposal reply): keep classification pricing_info or proposal; needs_human_review false; reply_required true; add key_details token "soft_deposit_hold" and note the deposit amount if stated. Do NOT escalate soft holds to contract.
- Hard contract (please sign/execute, countersign, governing law, indemnity, attached contract to execute as a legal document): classification "contract", needs_human_review true, reply_required false.
- Auto-replies / OOO → auto_reply, reply_required false.
- capacity_ok: true only if they can host ~70–80 standing; false if they explicitly cannot; null if capacity is unmentioned.
- fully_private: true/false only when stated; null if unmentioned.
- min_spend_usd: number only when a clear F&B minimum or (rental-only) commercial floor is stated; null if unmentioned. Never invent spend.
- Be conservative on confidence.
- Do not invent numbers. Use null when unknown.
- Treat attachment_text blocks as part of the venue message for extraction (fees, capacity, terms).
- Never invent beyond body + attachment_text. If attachment_pending is noted, still extract everything usable from the body; include "attachment_pending" in key_details.`;

function buildUserPrompt(input: TriageInput, errorNote?: string): string {
  const atts =
    input.attachments.length === 0
      ? "(none)"
      : input.attachments
          .map((a) => `${a.filename} (${a.mimeType})`)
          .join(", ");

  const attachmentBlocks =
    input.attachmentTexts && input.attachmentTexts.length > 0
      ? input.attachmentTexts
          .map(
            (t) =>
              `attachment_text (${t.filename}):\n${t.text}`,
          )
          .join("\n\n")
      : null;

  return [
    errorNote ? `Previous JSON failed validation: ${errorNote}\nFix and retry.` : null,
    `thread_id: ${input.threadId}`,
    `subject: ${input.subject}`,
    `attachments: ${atts}`,
    input.attachmentPending
      ? "attachment_pending: true (one or more PDFs could not be read — extract from body; include attachment_pending in key_details)"
      : null,
    attachmentBlocks,
    `body:`,
    input.bodyPlain.slice(0, 2500),
  ]
    .filter(Boolean)
    .join("\n");
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1]?.trim() ?? text.trim();
  return JSON.parse(raw);
}

export async function runTriage(input: TriageInput): Promise<TriageResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY");
  }

  const client = new Anthropic({ apiKey });

  let lastError: string | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const msg = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 3024,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: buildUserPrompt(input, lastError),
        },
      ],
    });

    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    try {
      const parsed = extractJson(text);
      const validated = triageResultSchema.parse({
        ...(parsed as object),
        thread_id:
          (parsed as { thread_id?: string }).thread_id ?? input.threadId,
      });
      return applyTriageFirewall(validated, input);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  // Second failure → escalate raw
  return applyTriageFirewall(
    {
      thread_id: input.threadId,
      classification: "out_of_scope",
      extracted: {
        proposed_dates: [],
        key_details: ["triage_validation_failed"],
      },
      confidence: 0,
      needs_human_review: true,
      reply_required: false,
    },
    input,
  );
}
