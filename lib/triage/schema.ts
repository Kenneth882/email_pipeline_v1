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

export const feeStaffSchema = z.object({
  role: z.string(),
  count: z.number(),
  rate_usd_per_hour: z.number(),
  min_hours: z.number(),
});

/** Structured fee line items from triage (never invent — null when unknown). */
export const venueFeesSchema = z
  .object({
    fb_minimum_usd: z.number().nullable().optional(),
    after_hours_usd_per_hour: z.number().nullable().optional(),
    /** 24h local hour venue typically closes, e.g. 19 for 7pm. */
    venue_close_hour_local: z.number().nullable().optional(),
    staff: z.array(feeStaffSchema).nullable().optional(),
    sales_tax_pct: z.number().nullable().optional(),
    processing_fee_pct: z.number().nullable().optional(),
    gratuity_pct: z.number().nullable().optional(),
    gratuity_mandatory: z.boolean().nullable().optional(),
    building_fees_unknown: z.boolean().nullable().optional(),
  })
  .nullable()
  .optional();

export type VenueFees = NonNullable<z.infer<typeof venueFeesSchema>>;
export type FeeStaff = z.infer<typeof feeStaffSchema>;

export const triageExtractedSchema = z.object({
  min_spend_usd: z.number().nullable().optional(),
  fully_private: z.boolean().nullable().optional(),
  capacity_ok: z.boolean().nullable().optional(),
  contact_name: z.string().nullable().optional(),
  proposed_dates: z.array(z.string()).default([]),
  key_details: z.array(z.string()).default([]),
  fees: venueFeesSchema,
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
export type TriageExtracted = z.infer<typeof triageExtractedSchema>;

export type TriageInput = {
  threadId: string;
  subject: string;
  bodyPlain: string;
  attachments: Array<{ filename: string; mimeType: string }>;
};
