import { isHardIcpFail } from "@/lib/crm/icp";
import { isPdfAttachment } from "@/lib/triage/pdf";
import {
  ATTACHMENT_PENDING_DETAIL,
  type TriageInput,
  type TriageResult,
} from "@/lib/triage/schema";

const CONTRACT_BODY_RE =
  /\b(signature|sign here|countersign|deposit required|non[- ]refundable|governing law|indemnif|hereby agree|terms and conditions|please execute)\b/i;

const OFFICE_MIME_RE =
  /(msword|officedocument|application\/vnd\.|application\/msword)/i;

/** Body points at an attached menu/proposal/file rather than stating facts inline. */
const SEE_ATTACHED_RE =
  /\b(see|find|per|please\s+(see|find)|attached|attachment|enclosed)\b[\s\S]{0,40}\b(pdf|menu|proposal|pricing|deck|document|file|packet|brochure)\b|\b(please\s+)?(see|find)\s+(the\s+)?attached\b|\b(menu|proposal|pricing)\s+attached\b|\battached\s+(is|are|please)\b/i;

function hasCommercialBodyFacts(result: TriageResult): boolean {
  const e = result.extracted;
  if (e.min_spend_usd != null) return true;
  if (e.fully_private != null) return true;
  if (e.capacity_ok != null) return true;
  if (e.fees != null && typeof e.fees === "object") {
    const f = e.fees;
    if (
      f.fb_minimum_usd != null ||
      f.after_hours_usd_per_hour != null ||
      (Array.isArray(f.staff) && f.staff.length > 0) ||
      f.sales_tax_pct != null ||
      f.processing_fee_pct != null ||
      f.gratuity_pct != null
    ) {
      return true;
    }
  }
  const details = (e.key_details ?? []).filter(
    (d) => d !== ATTACHMENT_PENDING_DETAIL,
  );
  return details.length > 0;
}

/**
 * Unread PDF is load-bearing when body defers to the attachment and triage
 * has no commercial facts from the body alone.
 */
export function isUnreadPdfLoadBearing(
  input: TriageInput,
  result: TriageResult,
): boolean {
  if (!input.attachmentPending) return false;
  const commercial =
    result.classification === "pricing_info" ||
    result.classification === "proposal";
  if (!commercial) return false;
  if (!SEE_ATTACHED_RE.test(input.bodyPlain)) return false;
  return !hasCommercialBodyFacts(result);
}

function ensureAttachmentPendingDetail(next: TriageResult): void {
  const details = [...(next.extracted.key_details ?? [])];
  if (!details.includes(ATTACHMENT_PENDING_DETAIL)) {
    details.push(ATTACHMENT_PENDING_DETAIL);
  }
  next.extracted.key_details = details;
}

/**
 * Hard contract firewall + soft unread-PDF + confidence / auto_reply / lost-no-draft.
 */
export function applyTriageFirewall(
  result: TriageResult,
  input: TriageInput,
): TriageResult {
  const next = { ...result, extracted: { ...result.extracted } };

  // DOC/DOCX only — successfully read PDFs are not escalated on presence alone.
  const hasRiskyOfficeAttachment = input.attachments.some(
    (a) =>
      !isPdfAttachment(a) &&
      (OFFICE_MIME_RE.test(a.mimeType) || /\.(docx?|doc)$/i.test(a.filename)),
  );

  const bodyLooksLegal = CONTRACT_BODY_RE.test(input.bodyPlain);

  if (
    next.classification === "contract" ||
    bodyLooksLegal ||
    (hasRiskyOfficeAttachment && next.confidence < 0.85)
  ) {
    next.classification =
      next.classification === "contract" ? "contract" : next.classification;
    next.needs_human_review = true;
    next.reply_required = false;
  }

  if (input.attachmentPending) {
    ensureAttachmentPendingDetail(next);
    if (isUnreadPdfLoadBearing(input, next)) {
      next.needs_human_review = true;
      next.reply_required = false;
    }
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
