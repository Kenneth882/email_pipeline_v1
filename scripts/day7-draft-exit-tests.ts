/**
 * Day 7 draft intent + ICP band checks (pure helpers; no live Unipile).
 * Usage: npm run test:day7
 */

import {
  analyzeIcp,
  computeIcpVerdict,
  isHardIcpFail,
  listMissingIcpFields,
  mergeIcpExtracted,
  STATED_BUDGET_USD,
} from "../lib/crm/icp";
import { estimateAllInSpend } from "../lib/crm/pricing";
import { buildReviewReason, resolveTargetStage } from "../lib/crm/writer";
import { formatThreadMessagesForDraft } from "../lib/draft/context";
import { draftHasEscalation } from "../lib/draft/escalation";
import {
  detectDateConflict,
  resolveReplyIntent,
} from "../lib/draft/intent";
import { EVENT_BRIEF } from "../lib/event-brief";
import { applyTriageFirewall } from "../lib/triage/firewall";
import type { TriageResult } from "../lib/triage/schema";
import { normalizeUnipileEmailList } from "../lib/unipile/send";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function baseTriage(over: Partial<TriageResult> = {}): TriageResult {
  const extractedOver = over.extracted;
  const { extracted: _ignored, ...rest } = over;
  return {
    thread_id: "t1",
    classification: "pricing_info",
    extracted: {
      min_spend_usd: 1800,
      fully_private: true,
      capacity_ok: true,
      proposed_dates: [],
      key_details: ["AV included"],
      ...extractedOver,
    },
    confidence: 0.9,
    needs_human_review: false,
    reply_required: true,
    ...rest,
  };
}

function intentCases() {
  assert(STATED_BUDGET_USD === 2000, "stated budget is 2000");
  assert(EVENT_BRIEF.statedBudgetUsd === 2000, "event brief budget is 2000");

  const missingPrice = resolveReplyIntent(
    baseTriage({
      extracted: {
        min_spend_usd: null,
        fully_private: true,
        capacity_ok: true,
        proposed_dates: [],
        key_details: ["Can host 80"],
      },
    }),
  );
  assert(missingPrice.intent === "ask_missing", "missing price → ask_missing");
  assert(
    missingPrice.missing.includes("min_spend_usd"),
    "missing includes min_spend_usd",
  );
  assert(missingPrice.draftable === true, "ask_missing is draftable");
  assert(
    listMissingIcpFields({
      min_spend_usd: null,
      fully_private: true,
      capacity_ok: true,
    }).includes("min_spend_usd"),
    "listMissingIcpFields works",
  );

  const negotiate = resolveReplyIntent(
    baseTriage({
      extracted: {
        min_spend_usd: 2500,
        fully_private: true,
        capacity_ok: true,
        proposed_dates: [],
        key_details: [],
      },
    }),
  );
  assert(negotiate.intent === "negotiate", "2500 → negotiate");
  assert(negotiate.draftable === true, "negotiate draftable");
  assert(
    resolveTargetStage(
      baseTriage({
        extracted: {
          min_spend_usd: 2500,
          fully_private: true,
          capacity_ok: true,
          proposed_dates: [],
          key_details: [],
        },
      }),
      true,
    ) === "3_in_icp",
    "negotiate band still in ICP stage",
  );

  const confirm = resolveReplyIntent(
    baseTriage({
      extracted: {
        min_spend_usd: 2000,
        fully_private: true,
        capacity_ok: true,
        proposed_dates: [],
        key_details: [],
      },
    }),
  );
  assert(confirm.intent === "confirm_fit", "2000 → confirm_fit");
  assert(confirm.draftable === true, "confirm_fit draftable");

  const under = resolveReplyIntent(
    baseTriage({
      extracted: {
        min_spend_usd: 1800,
        fully_private: true,
        capacity_ok: true,
        proposed_dates: [],
        key_details: [],
      },
    }),
  );
  assert(under.intent === "confirm_fit", "1800 → confirm_fit");

  const analysis = analyzeIcp({
    min_spend_usd: 2500,
    fully_private: true,
    capacity_ok: true,
  });
  assert(analysis.verdict === true, "2500 still ICP verdict true");
  assert(analysis.negotiatePrice === true, "2500 negotiatePrice");
  assert(analysis.hardFail === false, "2500 not hardFail");
}

function lostNoDraftCases() {
  const highSpend = baseTriage({
    extracted: {
      min_spend_usd: 10000,
      fully_private: true,
      capacity_ok: true,
      proposed_dates: [],
      key_details: ["min 10k"],
    },
  });
  assert(isHardIcpFail(highSpend.extracted) === true, "10k hard fail");
  assert(computeIcpVerdict(highSpend.extracted) === false, "10k ICP false");
  const highIntent = resolveReplyIntent(highSpend);
  assert(highIntent.intent === "close_lost", "10k → close_lost");
  assert(highIntent.draftable === false, "close_lost not draftable");
  assert(
    resolveTargetStage(highSpend, false) === "lost",
    "10k stage → lost",
  );

  const fired = applyTriageFirewall(highSpend, {
    threadId: "t1",
    subject: "Pricing",
    bodyPlain: "Our minimum is $10,000",
    attachments: [],
  });
  assert(fired.reply_required === false, "hard fail forces reply_required false");

  const noCap = baseTriage({
    extracted: {
      min_spend_usd: 2000,
      fully_private: true,
      capacity_ok: false,
      proposed_dates: [],
      key_details: ["cannot host 80"],
    },
  });
  const noCapIntent = resolveReplyIntent(noCap);
  assert(noCapIntent.intent === "close_lost", "no capacity → close_lost");
  assert(noCapIntent.draftable === false, "no capacity not draftable");
  assert(resolveTargetStage(noCap, false) === "lost", "no capacity → lost");

  const notPrivate = baseTriage({
    confidence: 0.6,
    needs_human_review: true,
    extracted: {
      min_spend_usd: null,
      fully_private: false,
      capacity_ok: null,
      provides_food: false,
      proposed_dates: [],
      key_details: ["bar open to public", "outside catering only"],
    },
  });
  const notPrivateIntent = resolveReplyIntent(notPrivate);
  assert(notPrivateIntent.intent === "close_lost", "not private → close_lost");
  assert(notPrivateIntent.draftable === false, "not private not draftable");
  assert(
    resolveTargetStage(notPrivate, false) === "lost",
    "not private + no food → lost",
  );

  const noFood = baseTriage({
    extracted: {
      min_spend_usd: 2000,
      fully_private: true,
      capacity_ok: true,
      provides_food: false,
      proposed_dates: [],
      key_details: ["BYO / partner caterer only"],
    },
  });
  const noFoodIntent = resolveReplyIntent(noFood);
  assert(noFoodIntent.intent === "close_lost", "no food → close_lost");
  assert(resolveTargetStage(noFood, false) === "lost", "no food → lost");

  const rejection = resolveReplyIntent(
    baseTriage({ classification: "rejection", reply_required: true }),
  );
  assert(rejection.intent === "close_lost", "rejection → close_lost");
  assert(rejection.draftable === false, "rejection not draftable");

  const rejFired = applyTriageFirewall(
    baseTriage({ classification: "rejection", reply_required: true }),
    {
      threadId: "t1",
      subject: "No thanks",
      bodyPlain: "We are not interested",
      attachments: [],
    },
  );
  assert(rejFired.reply_required === false, "rejection reply_required false");
}

function dateAndEscalationCases() {
  assert(
    detectDateConflict({
      proposed_dates: ["August 20"],
      key_details: [],
    }) === true,
    "other proposed date → conflict",
  );
  assert(
    detectDateConflict({
      proposed_dates: ["August 12 evening"],
      key_details: [],
    }) === false,
    "primary date in proposed → no conflict",
  );
  assert(
    detectDateConflict({
      proposed_dates: [],
      key_details: ["We are fully booked that night"],
    }) === true,
    "key_details conflict",
  );

  const dateNeg = resolveReplyIntent(
    baseTriage({
      extracted: {
        min_spend_usd: 1500,
        fully_private: true,
        capacity_ok: true,
        proposed_dates: ["September 1"],
        key_details: [],
      },
    }),
  );
  assert(dateNeg.intent === "negotiate", "date conflict → negotiate");

  assert(
    draftHasEscalation("[ESCALATION: missing AV details]\nHi…") === true,
    "escalation marker detected",
  );
  assert(draftHasEscalation("Hi there, thanks!") === false, "no false escalation");
}

function multiTurnMergeCases() {
  // Seed-2 shape: round 1 settled private/capacity/$2800; round 2 offers $2k on Aug 10.
  const prior = {
    min_spend_usd: 2800,
    fully_private: true,
    capacity_ok: true,
    proposed_dates: ["August 12"],
    key_details: ["fully private buyout", "can host 70-80"],
  };
  const current = {
    min_spend_usd: 2000,
    fully_private: null,
    capacity_ok: null,
    proposed_dates: ["August 10"],
    key_details: ["AV available", "$2k if Monday August 10"],
  };
  const merged = mergeIcpExtracted(prior, current);
  assert(merged.fully_private === true, "merge keeps prior fully_private");
  assert(merged.capacity_ok === true, "merge keeps prior capacity_ok");
  assert(merged.min_spend_usd === 2000, "merge takes current spend");
  assert(
    (merged.proposed_dates ?? [])[0] === "August 10",
    "merge takes current dates",
  );
  assert(
    (merged.key_details ?? []).some((d) => /AV available/i.test(d)),
    "merge unions key_details",
  );
  assert(
    (merged.key_details ?? []).some((d) => /fully private/i.test(d)),
    "merge keeps prior key_details",
  );

  const followUp = resolveReplyIntent(
    baseTriage({
      extracted: {
        ...merged,
        proposed_dates: merged.proposed_dates ?? [],
        key_details: merged.key_details ?? [],
      },
    }),
  );
  assert(followUp.intent === "negotiate", "merged Aug 10 offer → negotiate");
  assert(followUp.draftable === true, "merged negotiate is draftable");
  assert(followUp.missing.length === 0, "merged has no missing ICP");
  assert(followUp.dateConflict === true, "Aug 10 is date conflict");

  // Current omits private/capacity entirely → still not ask_missing
  const omit = mergeIcpExtracted(prior, {
    min_spend_usd: 2500,
    key_details: ["still flexible"],
  });
  const omitIntent = resolveReplyIntent(
    baseTriage({
      extracted: {
        min_spend_usd: omit.min_spend_usd,
        fully_private: omit.fully_private,
        capacity_ok: omit.capacity_ok,
        proposed_dates: omit.proposed_dates ?? [],
        key_details: omit.key_details ?? [],
      },
    }),
  );
  assert(omitIntent.intent === "negotiate", "omit fields still negotiate");
  assert(omitIntent.missing.length === 0, "omit fields not ask_missing");

  // Hard fail still wins
  const hardCap = mergeIcpExtracted(prior, {
    capacity_ok: false,
    key_details: ["cannot host 80"],
  });
  const hardCapIntent = resolveReplyIntent(
    baseTriage({
      extracted: {
        min_spend_usd: hardCap.min_spend_usd,
        fully_private: hardCap.fully_private,
        capacity_ok: hardCap.capacity_ok,
        proposed_dates: hardCap.proposed_dates ?? [],
        key_details: hardCap.key_details ?? [],
      },
    }),
  );
  assert(hardCapIntent.intent === "close_lost", "capacity false → close_lost");
  assert(hardCapIntent.draftable === false, "hard fail not draftable");

  const hardSpend = mergeIcpExtracted(prior, { min_spend_usd: 7500 });
  const hardSpendIntent = resolveReplyIntent(
    baseTriage({
      extracted: {
        min_spend_usd: hardSpend.min_spend_usd,
        fully_private: hardSpend.fully_private,
        capacity_ok: hardSpend.capacity_ok,
        proposed_dates: hardSpend.proposed_dates ?? [],
        key_details: hardSpend.key_details ?? [],
      },
    }),
  );
  assert(hardSpendIntent.intent === "close_lost", "7500 → close_lost");
}

function threadFormatCases() {
  const listed = normalizeUnipileEmailList({
    items: [
      {
        subject: "Re: Event",
        body_plain: "Newest venue note",
        from_attendee: { identifier: "venue@example.com" },
      },
      {
        subject: "Re: Event",
        body_plain: "Our prior reply",
        from_attendee: { identifier: "us@venuehopper.com" },
      },
    ],
  });
  assert(listed.length === 2, "normalize list items");

  const formatted = formatThreadMessagesForDraft(listed, {
    ourAddresses: ["us@venuehopper.com"],
  });
  assert(formatted.includes("[Us]"), "labels our messages");
  assert(formatted.includes("[Venue]"), "labels venue messages");
  // oldest → newest: Us block before Venue newest
  assert(
    formatted.indexOf("Our prior reply") < formatted.indexOf("Newest venue note"),
    "oldest to newest order",
  );
}

/** Sample catering email fees from plan fixture. */
function sampleCateringFees() {
  return {
    fb_minimum_usd: 3000,
    after_hours_usd_per_hour: 52.5,
    venue_close_hour_local: 19,
    staff: [
      {
        role: "bartender",
        count: 2,
        rate_usd_per_hour: 45,
        min_hours: 4,
      },
      {
        role: "event attendant",
        count: 2,
        rate_usd_per_hour: 35,
        min_hours: 4,
      },
    ],
    sales_tax_pct: 11.75,
    processing_fee_pct: 3,
    gratuity_pct: 18,
    gratuity_mandatory: false,
    building_fees_unknown: true,
  };
}

function pricingEstimateCases() {
  // F&B only $2500 → negotiate (unchanged band)
  const onlyFb = resolveReplyIntent(
    baseTriage({
      extracted: {
        min_spend_usd: 2500,
        fully_private: true,
        capacity_ok: true,
        proposed_dates: [],
        key_details: [],
        fees: null,
      },
    }),
  );
  assert(onlyFb.intent === "negotiate", "2500 F&B only → negotiate");
  assert(onlyFb.spendEstimate.estimated_all_in_usd === 2500, "all-in = F&B");
  assert(onlyFb.spendEstimate.optional_gratuity_usd === null, "no tip");

  // F&B $1800 only → confirm_fit
  const under = resolveReplyIntent(
    baseTriage({
      extracted: {
        min_spend_usd: 1800,
        fully_private: true,
        capacity_ok: true,
        proposed_dates: [],
        key_details: [],
      },
    }),
  );
  assert(under.intent === "confirm_fit", "1800 → confirm_fit");

  // Missing min_spend → ask_missing, no invented all-in
  const missing = resolveReplyIntent(
    baseTriage({
      extracted: {
        min_spend_usd: null,
        fully_private: true,
        capacity_ok: true,
        proposed_dates: [],
        key_details: [],
        fees: null,
      },
    }),
  );
  assert(missing.intent === "ask_missing", "missing F&B → ask_missing");
  assert(missing.spendEstimate.usedForGating === false, "no gating without fb");
  assert(missing.spendEstimate.estimated_all_in_usd === null, "no invented all-in");

  const sample = estimateAllInSpend({
    min_spend_usd: 3000,
    fees: sampleCateringFees(),
  });
  // labor = 2*45*4 + 2*35*4 = 640; AH = 2*52.5 = 105; sub = 3745
  // *1.1175 *1.03 ≈ 4310.59
  assert(sample.labor_usd === 640, `labor 640 got ${sample.labor_usd}`);
  assert(sample.after_hours_usd === 105, `AH 105 got ${sample.after_hours_usd}`);
  assert(sample.usedForGating === true, "sample used for gating");
  assert(
    typeof sample.estimated_all_in_usd === "number" &&
      sample.estimated_all_in_usd > 4200,
    `sample all-in > 4200 got ${sample.estimated_all_in_usd}`,
  );
  assert(
    sample.optional_gratuity_usd !== null && sample.optional_gratuity_usd > 0,
    "optional tip present",
  );
  assert(sample.incomplete === true, "building fees → incomplete");

  const sampleTriage = baseTriage({
    extracted: {
      min_spend_usd: 3000,
      fully_private: true,
      capacity_ok: true,
      proposed_dates: [],
      key_details: ["F&B min $3000"],
      fees: sampleCateringFees(),
    },
  });
  const sampleIntent = resolveReplyIntent(sampleTriage);
  assert(sampleIntent.intent === "close_lost", "sample all-in → close_lost");
  assert(sampleIntent.draftable === false, "sample not draftable");
  assert(
    resolveTargetStage(sampleTriage, true, sample) === "lost",
    "sample all-in → HubSpot lost",
  );
  assert(
    buildReviewReason(sampleTriage, sample) === "all_in_above_icp",
    "review reason all_in_above_icp",
  );

  // Fees that stay in negotiate band (F&B 2200 + small labor, no tax)
  const midFees = resolveReplyIntent(
    baseTriage({
      extracted: {
        min_spend_usd: 2200,
        fully_private: true,
        capacity_ok: true,
        proposed_dates: [],
        key_details: [],
        fees: {
          fb_minimum_usd: 2200,
          staff: [
            {
              role: "bartender",
              count: 1,
              rate_usd_per_hour: 40,
              min_hours: 4,
            },
          ],
          gratuity_pct: 18,
          gratuity_mandatory: false,
        },
      },
    }),
  );
  // labor = 1*40*4 = 160 → all-in 2360 → negotiate
  assert(midFees.intent === "negotiate", "mid fees → negotiate");
  assert(midFees.draftable === true, "mid fees draftable");
  assert(
    midFees.spendEstimate.estimated_all_in_usd === 2360,
    `mid all-in 2360 got ${midFees.spendEstimate.estimated_all_in_usd}`,
  );
  assert(
    midFees.spendEstimate.optional_gratuity_usd !== null,
    "mid optional tip excluded from gate",
  );

  // Fee merge: prior staff + current tax
  const mergedFees = mergeIcpExtracted(
    {
      min_spend_usd: 3000,
      fees: {
        fb_minimum_usd: 3000,
        staff: [
          {
            role: "bartender",
            count: 2,
            rate_usd_per_hour: 45,
            min_hours: 4,
          },
        ],
      },
    },
    {
      min_spend_usd: 3000,
      fees: {
        sales_tax_pct: 10,
        processing_fee_pct: null,
      },
    },
  );
  assert(mergedFees.fees?.fb_minimum_usd === 3000, "merged keeps fb");
  assert(
    (mergedFees.fees?.staff?.length ?? 0) === 1,
    "merged keeps prior staff",
  );
  assert(mergedFees.fees?.sales_tax_pct === 10, "merged takes current tax");

  // Assumed venue close when after-hours rate but no close hour
  const assumedClose = estimateAllInSpend({
    min_spend_usd: 2000,
    fees: {
      fb_minimum_usd: 2000,
      after_hours_usd_per_hour: 50,
    },
  });
  assert(assumedClose.assumed_venue_close === true, "assumes 7pm close");
  assert(assumedClose.after_hours_hours === 2, "2h after hours 7→9");
  assert(assumedClose.after_hours_usd === 100, "AH $100");
}

function main() {
  console.log("1) Intent bands ($2k confirm / negotiate)…");
  intentCases();
  console.log("  ok");

  console.log("2) Lost = no draft…");
  lostNoDraftCases();
  console.log("  ok");

  console.log("3) Date conflict + escalation helper…");
  dateAndEscalationCases();
  console.log("  ok");

  console.log("4) Multi-turn ICP merge (Seed-2 negotiation)…");
  multiTurnMergeCases();
  console.log("  ok");

  console.log("5) Thread format helper…");
  threadFormatCases();
  console.log("  ok");

  console.log("6) Fee estimate + all-in intent gating…");
  pricingEstimateCases();
  console.log("  ok");

  console.log("\nAll Day 7 draft automated checks passed.");
}

main();
