import { isHardIcpFail } from "@/lib/crm/icp";
import type { TriageInput, TriageResult } from "@/lib/triage/schema";

const CONTRACT_BODY_RE =
  /\b(signature|sign here|countersign|deposit required|non[- ]refundable|governing law|indemnif|hereby agree|terms and conditions|please execute)\b/i;

const DOC_MIME_RE =
  /(pdf|msword|officedocument|application\/vnd\.|application\/msword)/i;

/**
 * Hard contract firewall + confidence / auto_reply / lost-no-draft rules (code, not prompt).
 */
export function applyTriageFirewall(
  result: TriageResult,
  input: TriageInput,
): TriageResult {
  const next = { ...result, extracted: { ...result.extracted } };

  const hasRiskyAttachment = input.attachments.some(
    (a) =>
      DOC_MIME_RE.test(a.mimeType) ||
      /\.(pdf|docx?|doc)$/i.test(a.filename),
  );

  const bodyLooksLegal = CONTRACT_BODY_RE.test(input.bodyPlain);

  if (
    next.classification === "contract" ||
    bodyLooksLegal ||
    (hasRiskyAttachment && next.confidence < 0.85)
  ) {
    next.classification =
      next.classification === "contract" ? "contract" : next.classification;
    if (bodyLooksLegal && next.classification !== "contract") {
      // keep model class but escalate
    }
    next.needs_human_review = true;
    next.reply_required = false;
  }

  if (next.confidence < 0.7) {
    next.needs_human_review = true;
    next.reply_required = false;
  }

  if (next.classification === "auto_reply") {
    next.reply_required = false;
  }

  if (next.classification === "bounce") {
    next.needs_human_review = true;
    next.reply_required = false;
  }

  // Lost suits: no draft (rejection or hard commercial fail).
  if (next.classification === "rejection" || isHardIcpFail(next.extracted)) {
    next.reply_required = false;
  }

  return next;
}
