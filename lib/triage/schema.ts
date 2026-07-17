import { z } from "zod";

export const triageClassificationSchema = z.enum([
  "pricing_info",
  "proposal",
  "contract",
  "question",
  "partnership_interest",
  "rejection",
  "bounce",
  "auto_reply",
  "out_of_scope",
]);

export const triageExtractedSchema = z.object({
  min_spend_usd: z.number().nullable().optional(),
  fully_private: z.boolean().nullable().optional(),
  capacity_ok: z.boolean().nullable().optional(),
  contact_name: z.string().nullable().optional(),
  proposed_dates: z.array(z.string()).default([]),
  key_details: z.array(z.string()).default([]),
});

export const triageResultSchema = z.object({
  thread_id: z.string(),
  classification: triageClassificationSchema,
  extracted: triageExtractedSchema,
  confidence: z.number().min(0).max(1),
  needs_human_review: z.boolean(),
  reply_required: z.boolean(),
});

export type TriageResult = z.infer<typeof triageResultSchema>;

export type TriageInput = {
  threadId: string;
  subject: string;
  bodyPlain: string;
  attachments: Array<{ filename: string; mimeType: string }>;
};
