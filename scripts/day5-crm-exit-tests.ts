/**
 * Day 5 CRM Writer exit checks (pure helpers; no live HubSpot required).
 * Usage: npm run test:day5
 */

import { computeIcpVerdict } from "../lib/crm/icp";
import { isTransitionAllowed } from "../lib/crm/stage";
import {
  buildReviewReason,
  resolveTargetStage,
} from "../lib/crm/writer";
import { applyTriageFirewall } from "../lib/triage/firewall";
import type { TriageResult } from "../lib/triage/schema";
import { extractReplyMessageIdHeaders } from "../lib/unipile/send";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function baseTriage(over: Partial<TriageResult> = {}): TriageResult {
  return {
    thread_id: "t1",
    classification: "pricing_info",
    extracted: {
      min_spend_usd: 2000,
      fully_private: true,
      capacity_ok: true,
      proposed_dates: [],
      key_details: ["AV included"],
    },
    confidence: 0.9,
    needs_human_review: false,
    reply_required: true,
    ...over,
  };
}

function icpCases() {
  assert(
    computeIcpVerdict({
      min_spend_usd: 2000,
      fully_private: true,
      capacity_ok: true,
    }) === true,
    "ICP true when all fit",
  );
  assert(
    computeIcpVerdict({
      min_spend_usd: 5000,
      fully_private: true,
      capacity_ok: true,
    }) === false,
    "ICP false when spend too high",
  );
  assert(
    computeIcpVerdict({
      min_spend_usd: 2000,
      fully_private: null,
      capacity_ok: true,
    }) === false,
    "ICP false when null field",
  );
  assert(
    computeIcpVerdict({
      min_spend_usd: undefined,
      fully_private: true,
      capacity_ok: true,
    }) === false,
    "ICP false when undefined spend",
  );
  assert(
    computeIcpVerdict({
      min_spend_usd: 2000,
      fully_private: false,
      capacity_ok: true,
    }) === false,
    "ICP false when not private",
  );
  assert(
    computeIcpVerdict({
      min_spend_usd: 2000,
      fully_private: true,
      capacity_ok: true,
      provides_food: false,
    }) === false,
    "ICP false when no in-house food",
  );
}

function whitelistCases() {
  assert(
    isTransitionAllowed("1_contacted", "2_responded") === true,
    "1→2 allowed",
  );
  assert(
    isTransitionAllowed("1_contacted", "3_in_icp") === true,
    "1→3 allowed",
  );
  assert(
    isTransitionAllowed("2_responded", "2_responded") === true,
    "same stage allowed",
  );
  assert(
    isTransitionAllowed("1_contacted", "lost") === true,
    "closed lost allowed",
  );
  assert(
    isTransitionAllowed("1_contacted", "bounced") === true,
    "bounced allowed",
  );
  assert(
    isTransitionAllowed("1_contacted", "needs_review") === true,
    "needs_review allowed",
  );
  assert(
    isTransitionAllowed("3_in_icp", "1_contacted") === false,
    "backward illegal",
  );
  assert(
    isTransitionAllowed("8_onboarded", "2_responded") === false,
    "backward from onboarded illegal",
  );
}

function targetStageCases() {
  const pricing = baseTriage();
  assert(
    resolveTargetStage(pricing, false) === "2_responded",
    "pricing → 2_responded",
  );
  assert(
    resolveTargetStage(pricing, true) === "3_in_icp",
    "pricing + ICP → 3_in_icp",
  );

  assert(
    resolveTargetStage(baseTriage({ classification: "auto_reply" }), false) ===
      null,
    "auto_reply → no stage",
  );
  assert(
    resolveTargetStage(baseTriage({ classification: "bounce" }), false) ===
      "bounced",
    "bounce → bounced",
  );
  assert(
    resolveTargetStage(baseTriage({ classification: "rejection" }), false) ===
      "lost",
    "rejection → lost",
  );
  assert(
    resolveTargetStage(
      baseTriage({
        extracted: {
          min_spend_usd: 10000,
          fully_private: true,
          capacity_ok: true,
          proposed_dates: [],
          key_details: [],
        },
      }),
      false,
    ) === "lost",
    "hard fail spend → lost",
  );
  assert(
    resolveTargetStage(
      baseTriage({
        extracted: {
          min_spend_usd: 2000,
          fully_private: true,
          capacity_ok: false,
          proposed_dates: [],
          key_details: [],
        },
      }),
      false,
    ) === "lost",
    "hard fail capacity → lost",
  );
  assert(
    resolveTargetStage(
      baseTriage({
        classification: "proposal",
        confidence: 0.6,
        needs_human_review: true,
        reply_required: false,
        extracted: {
          min_spend_usd: null,
          fully_private: false,
          capacity_ok: null,
          provides_food: false,
          proposed_dates: [],
          key_details: [
            "Cash bar package — bar remains open to public",
            "No in-house food; partner caterer only",
          ],
        },
      }),
      false,
    ) === "lost",
    "Burwood-style not private + no food → lost (beats needs_review)",
  );
  assert(
    resolveTargetStage(
      baseTriage({
        needs_human_review: true,
        extracted: {
          min_spend_usd: 2000,
          fully_private: false,
          capacity_ok: true,
          proposed_dates: [],
          key_details: [],
        },
      }),
      false,
    ) === "lost",
    "fully_private false → lost",
  );
  assert(
    resolveTargetStage(
      baseTriage({
        needs_human_review: true,
        extracted: {
          min_spend_usd: 2000,
          fully_private: true,
          capacity_ok: true,
          provides_food: false,
          proposed_dates: [],
          key_details: ["Outside catering / BYO only"],
        },
      }),
      false,
    ) === "lost",
    "provides_food false → lost",
  );
  assert(
    resolveTargetStage(baseTriage({ classification: "proposal" }), true) ===
      "4_proposal_received",
    "proposal → 4",
  );
  assert(
    resolveTargetStage(
      baseTriage({ classification: "partnership_interest" }),
      false,
    ) === "5_partnership_interest",
    "partnership → 5",
  );
  assert(
    resolveTargetStage(
      baseTriage({ classification: "contract", needs_human_review: true }),
      false,
    ) === "needs_review",
    "contract → needs_review",
  );
  assert(
    resolveTargetStage(
      baseTriage({ needs_human_review: true, classification: "question" }),
      false,
    ) === "needs_review",
    "needs_human_review wins",
  );
  assert(
    resolveTargetStage(
      baseTriage({
        classification: "proposal",
        confidence: 0.8,
        needs_human_review: false,
        reply_required: true,
        extracted: {
          min_spend_usd: 2800,
          fully_private: true,
          capacity_ok: true,
          proposed_dates: ["August 13"],
          key_details: [
            "soft_deposit_hold",
            "Signed contract and $700 deposit required to secure space",
          ],
        },
      }),
      true,
    ) === "4_proposal_received",
    "soft deposit hold proposal → 4 (not needs_review)",
  );
  assert(
    resolveTargetStage(
      baseTriage({
        classification: "proposal",
        confidence: 0.65,
        needs_human_review: true,
        reply_required: false,
        extracted: {
          min_spend_usd: 5000,
          fully_private: true,
          capacity_ok: true,
          proposed_dates: [],
          key_details: ["Room rental $5000 (F&B additional)"],
          fees: {
            room_rental_usd: 5000,
            fb_minimum_usd: null,
          },
        },
      }),
      false,
    ) === "lost",
    "360-style $5k room rental → lost (beats needs_review)",
  );
  assert(
    resolveTargetStage(
      baseTriage({
        classification: "proposal",
        needs_human_review: true,
        extracted: {
          min_spend_usd: null,
          fully_private: true,
          capacity_ok: true,
          proposed_dates: [],
          key_details: ["Room rental $5000 (F&B additional)"],
          fees: { room_rental_usd: 5000 },
        },
      }),
      false,
    ) === "lost",
    "room_rental_usd alone → lost via all-in gate",
  );
  assert(
    buildReviewReason(
      baseTriage({ classification: "contract", needs_human_review: true }),
    ) === "contract_firewall",
    "review reason contract",
  );
}

function replyHeaderCases() {
  const ids = extractReplyMessageIdHeaders({
    in_reply_to: { message_id: "<abc@mail.gmail.com>" },
    headers: [
      { name: "References", value: "<abc@mail.gmail.com> <def@mail.gmail.com>" },
      { name: "Subject", value: "Re: hello" },
    ],
  });
  assert(ids.includes("<abc@mail.gmail.com>"), "in_reply_to extracted");
  assert(ids.includes("<def@mail.gmail.com>"), "references extracted");
  assert(ids.length === 2, "deduped ids");

  const bare = extractReplyMessageIdHeaders({
    in_reply_to: "xyz@host",
  });
  assert(bare[0] === "<xyz@host>", "bare id wrapped");
}

function firewallStillBlocks() {
  const contract = applyTriageFirewall(
    baseTriage({ classification: "contract" }),
    {
      threadId: "t1",
      subject: "Agreement",
      bodyPlain: "Please sign the agreement",
      attachments: [],
    },
  );
  assert(contract.reply_required === false, "contract must not reply");
  assert(contract.needs_human_review === true, "contract must review");

  const softHold = applyTriageFirewall(
    baseTriage({
      classification: "proposal",
      confidence: 0.8,
      needs_human_review: false,
      reply_required: true,
      extracted: {
        min_spend_usd: 2800,
        fully_private: true,
        capacity_ok: true,
        proposed_dates: [],
        key_details: ["$2800 F&B"],
      },
    }),
    {
      threadId: "t1",
      subject: "Proposal",
      bodyPlain:
        "To secure the space we will need a signed contract along with a deposit of $700. F&B min $2800.",
      attachments: [],
    },
  );
  assert(softHold.needs_human_review === false, "soft hold no review flag");
  assert(softHold.reply_required === true, "soft hold drafts");
  assert(
    (softHold.extracted.key_details ?? []).includes("soft_deposit_hold"),
    "soft hold tagged",
  );
  assert(
    resolveTargetStage(softHold, true) === "4_proposal_received",
    "soft hold → proposal stage",
  );
}

function softUnreadPdfCases() {
  // Unread + see attached + empty extract → escalate + review reason
  const loadBearing = applyTriageFirewall(
    baseTriage({
      classification: "proposal",
      extracted: { proposed_dates: [], key_details: [] },
      needs_human_review: false,
      reply_required: true,
    }),
    {
      threadId: "t1",
      subject: "Proposal",
      bodyPlain: "Please see the attached proposal for full pricing.",
      attachments: [
        { filename: "proposal.pdf", mimeType: "application/pdf" },
      ],
      attachmentPending: true,
    },
  );
  assert(loadBearing.needs_human_review === true, "load-bearing unread review");
  assert(loadBearing.reply_required === false, "load-bearing unread no draft");
  assert(
    buildReviewReason(loadBearing) === "attachment_unread_needed",
    "attachment_unread_needed reason",
  );

  // Unread but body already priced → draft ok, no review reason
  const bodyOk = applyTriageFirewall(
    baseTriage({
      extracted: {
        min_spend_usd: 2000,
        fully_private: true,
        capacity_ok: true,
        proposed_dates: [],
        key_details: [],
      },
    }),
    {
      threadId: "t1",
      subject: "Pricing",
      bodyPlain: "Min spend is $2000 for a private buyout. PDF attached.",
      attachments: [{ filename: "menu.pdf", mimeType: "application/pdf" }],
      attachmentPending: true,
    },
  );
  assert(bodyOk.reply_required === true, "body-ok unread still drafts");
  assert(
    (bodyOk.extracted.key_details ?? []).includes("attachment_pending"),
    "still tags attachment_pending",
  );
  assert(buildReviewReason(bodyOk) === "", "no review reason when draftable");
}

function main() {
  console.log("1) ICP verdict…");
  icpCases();
  console.log("  ok");

  console.log("2) Stage whitelist…");
  whitelistCases();
  console.log("  ok");

  console.log("3) Classification → target stage…");
  targetStageCases();
  console.log("  ok");

  console.log("4) In-Reply-To header parse…");
  replyHeaderCases();
  console.log("  ok");

  console.log("5) Firewall still blocks contracts…");
  firewallStillBlocks();
  console.log("  ok");

  console.log("6) Soft unread PDF firewall…");
  softUnreadPdfCases();
  console.log("  ok");

  console.log("\nAll Day 5 CRM automated checks passed.");
  console.log(
    "Manual smoke: seed reply → HubSpot contact props + deal leaves 1 Contacted.",
  );
}

main();
