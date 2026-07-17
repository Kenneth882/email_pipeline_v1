/**
 * Day 7 draft intent + ICP band checks (pure helpers; no live Unipile).
 * Usage: npm run test:day7
 */

import {
  analyzeIcp,
  computeIcpVerdict,
  isHardIcpFail,
  listMissingIcpFields,
  STATED_BUDGET_USD,
} from "../lib/crm/icp";
import { resolveTargetStage } from "../lib/crm/writer";
import { draftHasEscalation } from "../lib/draft/escalation";
import {
  detectDateConflict,
  resolveReplyIntent,
} from "../lib/draft/intent";
import { EVENT_BRIEF } from "../lib/event-brief";
import { applyTriageFirewall } from "../lib/triage/firewall";
import type { TriageResult } from "../lib/triage/schema";

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

  console.log("\nAll Day 7 draft automated checks passed.");
}

main();
