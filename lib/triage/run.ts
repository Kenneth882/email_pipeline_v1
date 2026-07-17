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
    "key_details": string[]
  },
  "confidence": number,
  "needs_human_review": boolean,
  "reply_required": boolean
}
Rules:
- Put every commercial/logistical fact into key_details (fees, minimums, blackouts, deposits, capacity caveats).
- Contracts / legal / signature requests → classification "contract", needs_human_review true, reply_required false.
- Auto-replies / OOO → auto_reply, reply_required false.
- Be conservative on confidence.
- Do not invent numbers. Use null when unknown.`;

function buildUserPrompt(input: TriageInput, errorNote?: string): string {
  const atts =
    input.attachments.length === 0
      ? "(none)"
      : input.attachments
          .map((a) => `${a.filename} (${a.mimeType})`)
          .join(", ");

  return [
    errorNote ? `Previous JSON failed validation: ${errorNote}\nFix and retry.` : null,
    `thread_id: ${input.threadId}`,
    `subject: ${input.subject}`,
    `attachments: ${atts}`,
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
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
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
