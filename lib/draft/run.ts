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

const SYSTEM = `You draft threaded reply emails for venue outreach (Chicago private events).
Return ONLY valid JSON: { "subject": string, "body": string }.
Rules:
- You are a client writing TO the venue. Never write as the venue or address yourself.
- Follow the playbook intent exactly. Do not invent prices, discounts, capacity, or terms.
- Do NOT re-ask fully_private, capacity_ok, or min_spend when they appear under Known facts.
- Address every key_details item in the draft OR list it under a leading line [ESCALATION: …].
- If information is missing that you would need to invent, start the body with [ESCALATION: …].
- Use the full Thread context (multiple turns). Respond to the latest venue message using prior constraints.
- Plain text only. Sign as ${EVENT_BRIEF.signerName}.
- Never claim you read PDF/DOC attachments.
- Never invent fee math. If a code spend estimate is in Known facts / Playbook, use those figures only — do not recalculate.
- Only escalate for unknown building/landlord fees when the playbook marks the estimate incomplete and you would otherwise need to invent them; routine negotiate does not require escalation solely for incomplete building fees.
- Keep under ~250 words.
- If venue asks to call say that you cannot and ask them about the venue details that are needed.
- If venue says they dont do food or you need to bring your own like catering that makes the venue not applicable to the icp.
- Payment preference: always request ONE combined group tab for food + drinks. Never propose splitting checks, individual tabs, or switching mid-event. If the venue offers tab flexibility, acknowledge briefly and state we want a single group tab covering F&B.
- If key_details contains soft_deposit_hold (or clear deposit / signed-contract-to-hold language): start the body with [ESCALATION: deposit/contract hold — human must approve before signing] then write the normal commercial reply. Still address other key_details; do not invent signing terms; still never send.
`;


function buildUserPrompt(ctx: DraftContext, errorNote?: string): string {
  const keyDetails = ctx.triage.extracted.key_details ?? [];
  return [
    errorNote ? `Previous JSON failed validation: ${errorNote}\nFix and retry.` : null,
    `Venue: ${ctx.venueName}`,
    `Classification: ${ctx.triage.classification}`,
    `Reply intent: ${ctx.intentResult.intent}`,
    `Missing ICP fields: ${ctx.intentResult.missing.join(", ") || "(none)"}`,
    `Date conflict: ${ctx.intentResult.dateConflict}`,
    `Known facts (do not re-ask):\n${ctx.knownFacts}`,
    `Spend estimate (code):\n${ctx.spendEstimate.breakdown}`,
    `Extracted JSON (merged): ${JSON.stringify(ctx.triage.extracted)}`,
    `key_details:\n${keyDetails.length ? keyDetails.map((d) => `- ${d}`).join("\n") : "(none)"}`,
    `Event brief:\n${ctx.eventBriefText}`,
    `Playbook:\n${ctx.playbook}`,
    `Preferred subject (may adjust Re:): ${ctx.subject}`,
    `Thread context (oldest → newest):\n${ctx.recentThread}`,
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
