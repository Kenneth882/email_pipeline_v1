import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { DraftContext } from "@/lib/draft/context";
import { draftHasEscalation } from "@/lib/draft/escalation";
import { EVENT_BRIEF } from "@/lib/event-brief";

export const draftOutputSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
});

export type DraftOutput = z.infer<typeof draftOutputSchema>;

const SYSTEM = `You draft threaded reply emails for VenueHopper venue outreach (Chicago private events).
Return ONLY valid JSON: { "subject": string, "body": string }.
Rules:
- Follow the playbook intent exactly. Do not invent prices, discounts, capacity, or terms.
- Address every key_details item in the draft OR list it under a leading line [ESCALATION: …].
- If information is missing that you would need to invent, start the body with [ESCALATION: …].
- Plain text only. Sign as ${EVENT_BRIEF.signerName}.
- Never claim you read PDF/DOC attachments.
- Keep under ~250 words.`;

function buildUserPrompt(ctx: DraftContext, errorNote?: string): string {
  const keyDetails = ctx.triage.extracted.key_details ?? [];
  return [
    errorNote ? `Previous JSON failed validation: ${errorNote}\nFix and retry.` : null,
    `Venue: ${ctx.venueName}`,
    `Classification: ${ctx.triage.classification}`,
    `Reply intent: ${ctx.intentResult.intent}`,
    `Missing ICP fields: ${ctx.intentResult.missing.join(", ") || "(none)"}`,
    `Date conflict: ${ctx.intentResult.dateConflict}`,
    `Extracted JSON: ${JSON.stringify(ctx.triage.extracted)}`,
    `key_details:\n${keyDetails.length ? keyDetails.map((d) => `- ${d}`).join("\n") : "(none)"}`,
    `Event brief:\n${ctx.eventBriefText}`,
    `Playbook:\n${ctx.playbook}`,
    `Preferred subject (may adjust Re:): ${ctx.subject}`,
    `Thread context:\n${ctx.recentThread}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1]?.trim() ?? text.trim();
  return JSON.parse(raw);
}

export async function generateDraftBody(
  ctx: DraftContext,
): Promise<DraftOutput & { hasEscalation: boolean }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");

  const client = new Anthropic({ apiKey });
  let lastError: string | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const msg = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 2048,
      system: SYSTEM,
      messages: [{ role: "user", content: buildUserPrompt(ctx, lastError) }],
    });

    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    try {
      const parsed = draftOutputSchema.parse(extractJson(text));
      return {
        ...parsed,
        hasEscalation: draftHasEscalation(parsed.body),
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  // Fail closed into an escalation draft rather than inventing.
  const body = `[ESCALATION: draft_generation_failed — ${lastError ?? "unknown"}]\n\nHi — thanks for your note. I want to make sure I respond accurately and will follow up shortly.\n\nBest,\n${EVENT_BRIEF.signerName}\n`;
  return {
    subject: ctx.subject,
    body,
    hasEscalation: true,
  };
}
