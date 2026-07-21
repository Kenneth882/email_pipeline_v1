/**
 * Day 3–5 automated checks (no live Unipile send required).
 * Usage: npm run test:day3
 */

import { createClient } from "@supabase/supabase-js";
import { stripQuotedHistory } from "../lib/email/strip-quotes";
import { applyTriageFirewall } from "../lib/triage/firewall";
import {
  extractPdfAttachments,
  isPdfAttachment,
  MAX_PDF_BYTES,
} from "../lib/triage/pdf";
import type { TriageResult } from "../lib/triage/schema";
import { ATTACHMENT_PENDING_DETAIL } from "../lib/triage/schema";
import { dailyQuotaForWarmupDay, halfQuota } from "../lib/config";
import { runDrip } from "../lib/drip/engine";
import { setConfigValue } from "../lib/config";
import { buildReviewReason } from "../lib/crm/writer";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function firewallCase() {
  const base: TriageResult = {
    thread_id: "t1",
    classification: "pricing_info",
    extracted: { proposed_dates: [], key_details: [] },
    confidence: 0.9,
    needs_human_review: false,
    reply_required: true,
  };

  const contract = applyTriageFirewall(
    { ...base, classification: "contract" },
    {
      threadId: "t1",
      subject: "Agreement",
      bodyPlain: "Please sign the agreement",
      attachments: [],
    },
  );
  assert(contract.reply_required === false, "contract must not reply");
  assert(contract.needs_human_review === true, "contract must review");

  const low = applyTriageFirewall(
    { ...base, confidence: 0.4 },
    {
      threadId: "t1",
      subject: "Hi",
      bodyPlain: "hello",
      attachments: [],
    },
  );
  assert(low.needs_human_review && !low.reply_required, "low confidence escalate");

  const auto = applyTriageFirewall(
    { ...base, classification: "auto_reply" },
    {
      threadId: "t1",
      subject: "OOO",
      bodyPlain: "out of office",
      attachments: [],
    },
  );
  assert(auto.reply_required === false, "auto_reply no draft");

  // Readable PDF (pending false): do not escalate on PDF presence alone
  const readablePdf = applyTriageFirewall(
    {
      ...base,
      classification: "proposal",
      extracted: {
        proposed_dates: [],
        key_details: ["F&B min $2000"],
        min_spend_usd: 2000,
      },
    },
    {
      threadId: "t1",
      subject: "Proposal",
      bodyPlain: "See our rates below.",
      attachments: [
        { id: "a1", filename: "menu.pdf", mimeType: "application/pdf" },
      ],
      attachmentTexts: [
        { filename: "menu.pdf", text: "Food and beverage minimum $2000" },
      ],
      attachmentPending: false,
    },
  );
  assert(readablePdf.reply_required === true, "readable PDF proposal may draft");
  assert(
    readablePdf.needs_human_review === false,
    "readable PDF does not force review",
  );

  // Unread PDF + body has commercial facts → tag pending, still draft
  const unreadBodyOk = applyTriageFirewall(
    {
      ...base,
      extracted: {
        proposed_dates: [],
        key_details: [],
        min_spend_usd: 2500,
        fully_private: true,
      },
    },
    {
      threadId: "t1",
      subject: "Pricing",
      bodyPlain: "Our private room min is $2500. Menu PDF attached for reference.",
      attachments: [
        { id: "a1", filename: "menu.pdf", mimeType: "application/pdf" },
      ],
      attachmentPending: true,
    },
  );
  assert(
    unreadBodyOk.extracted.key_details.includes(ATTACHMENT_PENDING_DETAIL),
    "unread tags attachment_pending",
  );
  assert(unreadBodyOk.reply_required === true, "body-sufficient unread PDF drafts");
  assert(
    unreadBodyOk.needs_human_review === false,
    "body-sufficient unread PDF no forced review",
  );
  assert(
    buildReviewReason(unreadBodyOk) === "",
    "no HubSpot review reason when still draftable",
  );

  // Unread PDF + see attached + no body facts → escalate
  const unreadLoadBearing = applyTriageFirewall(
    {
      ...base,
      classification: "proposal",
      extracted: { proposed_dates: [], key_details: [] },
    },
    {
      threadId: "t1",
      subject: "Proposal",
      bodyPlain: "Please see the attached menu for pricing and packages.",
      attachments: [
        { filename: "menu.pdf", mimeType: "application/pdf" },
      ],
      attachmentPending: true,
    },
  );
  assert(
    unreadLoadBearing.needs_human_review === true,
    "load-bearing unread PDF needs review",
  );
  assert(
    unreadLoadBearing.reply_required === false,
    "load-bearing unread PDF no draft",
  );
  assert(
    unreadLoadBearing.extracted.key_details.includes(ATTACHMENT_PENDING_DETAIL),
    "load-bearing has attachment_pending",
  );
  assert(
    buildReviewReason(unreadLoadBearing) === "attachment_unread_needed",
    "review reason attachment_unread_needed",
  );

  // Contract with PDF still blocks
  const contractPdf = applyTriageFirewall(
    { ...base, classification: "contract" },
    {
      threadId: "t1",
      subject: "Contract",
      bodyPlain: "Please execute the attached agreement.",
      attachments: [
        { filename: "contract.pdf", mimeType: "application/pdf" },
      ],
      attachmentPending: true,
    },
  );
  assert(contractPdf.reply_required === false, "contract PDF no draft");
  assert(contractPdf.needs_human_review === true, "contract PDF review");
  assert(
    buildReviewReason(contractPdf) === "contract_firewall",
    "contract reason wins over attachment",
  );
}

async function pdfExtractCase() {
  assert(
    isPdfAttachment({ filename: "x.pdf", mimeType: "application/octet-stream" }),
    "pdf by extension",
  );
  assert(
    isPdfAttachment({ filename: "x", mimeType: "application/pdf" }),
    "pdf by mime",
  );
  assert(
    !isPdfAttachment({ filename: "x.docx", mimeType: "application/msword" }),
    "docx not pdf",
  );

  const none = await extractPdfAttachments("email-1", []);
  assert(!none.pending && none.texts.length === 0, "no pdfs → not pending");

  const noId = await extractPdfAttachments("email-1", [
    { filename: "menu.pdf", mimeType: "application/pdf" },
  ]);
  assert(noId.pending && noId.unread.includes("menu.pdf"), "missing id → unread");

  const oversized = await extractPdfAttachments("email-1", [
    {
      id: "att-1",
      filename: "huge.pdf",
      mimeType: "application/pdf",
      size: MAX_PDF_BYTES + 1,
    },
  ]);
  assert(
    oversized.pending && oversized.unread.includes("huge.pdf"),
    "oversize → unread",
  );

  const failedDl = await extractPdfAttachments(
    "email-1",
    [{ id: "att-1", filename: "menu.pdf", mimeType: "application/pdf" }],
    {
      download: async () => {
        throw new Error("network");
      },
    },
  );
  assert(
    failedDl.pending && failedDl.unread.includes("menu.pdf"),
    "download fail → unread",
  );

  const emptyText = await extractPdfAttachments(
    "email-1",
    [{ id: "att-1", filename: "scan.pdf", mimeType: "application/pdf" }],
    {
      download: async () => Buffer.from("%PDF-1.4 empty-ish"),
    },
  );
  assert(
    emptyText.pending && emptyText.unread.includes("scan.pdf"),
    "bad/empty PDF → unread",
  );

  const tinyPdf = `%PDF-1.4
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj
4 0 obj<< /Length 55 >>stream
BT /F1 12 Tf 50 100 Td (F and B minimum 2000) Tj ET
endstream
endobj
5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000266 00000 n 
0000000371 00000 n 
trailer<< /Size 6 /Root 1 0 R >>
startxref
448
%%EOF`;

  const ok = await extractPdfAttachments(
    "email-1",
    [{ id: "att-1", filename: "menu.pdf", mimeType: "application/pdf" }],
    { download: async () => Buffer.from(tinyPdf) },
  );
  assert(!ok.pending && ok.texts.length === 1, "valid PDF extracts");
  assert(
    ok.texts[0]?.text.includes("2000"),
    "extracted text includes fee number",
  );
}

function quoteStripCase() {
  const gmail = stripQuotedHistory(
    "Thanks, our min is $2k.\n\nOn Mon, Jan 1 Jane wrote:\n> earlier",
  );
  assert(!gmail.includes("On Mon"), "gmail quote stripped");
  assert(gmail.includes("$2k"), "kept new content");

  const outlook = stripQuotedHistory(
    "We can do private.\nFrom: a@b.com\nSent: Monday\nTo: x\n\nold",
  );
  assert(!outlook.includes("Sent:"), "outlook quote stripped");
}

async function main() {
  console.log("0) PDF extract helpers…");
  await pdfExtractCase();
  console.log("  ok");

  console.log("1) Quota math…");
  assert(dailyQuotaForWarmupDay(1) === 15, "day1 quota");
  assert(dailyQuotaForWarmupDay(5) === 30, "day5 quota");
  assert(dailyQuotaForWarmupDay(9) === 50, "day9 quota");
  assert(halfQuota(15) === 8, "half of 15");
  console.log("  ok");

  console.log("2) Quote strip + firewall…");
  quoteStripCase();
  firewallCase();
  console.log("  ok");

  console.log("3) Schema: is_seed + seed isolation…");
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert(url && key, "Missing Supabase env");
  const supabase = createClient(url!, key!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { count: realSeeds } = await supabase
    .from("venues")
    .select("id", { count: "exact", head: true })
    .eq("is_seed", true)
    .neq("source_system", "seed_test");

  // Real Chicago venues should remain is_seed=false
  const { data: chicago } = await supabase
    .from("venues")
    .select("name, is_seed")
    .eq("contact_method", "email")
    .is("is_seed", true)
    .not("source_system", "eq", "seed_test");

  if (chicago && chicago.length) {
    console.warn(
      "  warn: some non-seed_test venues marked is_seed:",
      chicago.map((c) => c.name),
    );
  } else {
    console.log("  ok: Chicago venues not in seed allowlist");
  }
  void realSeeds;

  console.log("4) Drip dry-run + kill switch…");
  process.env.DRIP_DRY_RUN = "true";
  await setConfigValue(supabase, "drip_dry_run", true);
  await setConfigValue(supabase, "paused", true);
  const pausedRun = await runDrip(supabase);
  assert(pausedRun.paused === true, "paused should short-circuit");
  assert(pausedRun.intended.length === 0, "paused sends nothing");

  await setConfigValue(supabase, "paused", false);
  const dry = await runDrip(supabase);
  assert(dry.dryRun === true, "dry run flag");
  assert(dry.sent.length === 0, "dry run must not send");
  await setConfigValue(supabase, "paused", true);
  console.log("  ok: paused + dry-run", {
    intended: dry.intended.length,
    runQuota: dry.runQuota,
  });

  console.log("\nAll Day 3 automated checks passed.");
  console.log(
    "Manual remaining: Vercel CRON_SECRET + Supabase env, HubSpot properties scope,",
  );
  console.log(
    "SEED_EMAILS upsert + HubSpot IDs for seeds, then live drip with DRIP_DRY_RUN=false.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
