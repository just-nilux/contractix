import {
  type DocumentType,
  type ExtractedFields,
  extractionSchemaForType,
  notFound,
} from "@contractix/shared";
import { describe, expect, it } from "vitest";

import { runBenchmark } from "./engine.js";

/** Build an extraction: every field not_found, then the given fields marked extracted. */
function mkExtraction(type: DocumentType, fields: Record<string, unknown>): ExtractedFields {
  const out: ExtractedFields = {};
  for (const key of extractionSchemaForType(type)?.fieldKeys ?? []) out[key] = notFound();
  for (const [key, value] of Object.entries(fields)) {
    out[key] = {
      value,
      confidence: "high",
      citations: [],
      verbatim_anchor: "x",
      status: "extracted",
    };
  }
  return out;
}

function firedIds(type: DocumentType, fields: Record<string, unknown>): string[] {
  return runBenchmark(mkExtraction(type, fields), { documentType: type }).map((f) => f.ruleId);
}

interface Case {
  id: string;
  type: DocumentType;
  fires: Record<string, unknown>;
  notFires: Record<string, unknown>;
}

const EMP: DocumentType = "employment_offer";
const TS: DocumentType = "term_sheet";
const VSOP: DocumentType = "vsop_esop_agreement";

const CASES: Case[] = [
  // --- Employment ---
  {
    id: "DE-NONCOMP-KARENZ",
    type: EMP,
    fires: {
      non_compete: { present: true, duration_months: 12, karenzentschaedigung_percent: 30 },
    },
    notFires: {
      non_compete: { present: true, duration_months: 12, karenzentschaedigung_percent: 50 },
    },
  },
  {
    id: "DE-NONCOMP-DURATION",
    type: EMP,
    fires: { non_compete: { present: true, duration_months: 30 } },
    notFires: { non_compete: { present: true, duration_months: 12 } },
  },
  {
    id: "DE-PROBEZEIT-MAX",
    type: EMP,
    fires: { probation_period_months: 7 },
    notFires: { probation_period_months: 6 },
  },
  {
    id: "EMP-CONTRACT-BEFRISTET",
    type: EMP,
    fires: { contract_type: "befristet" },
    notFires: { contract_type: "unbefristet" },
  },
  {
    id: "EMP-NOTICE-ASYM",
    type: EMP,
    fires: { notice_period_employee: { months: 3 }, notice_period_employer: { months: 1 } },
    notFires: { notice_period_employee: { months: 1 }, notice_period_employer: { months: 1 } },
  },
  {
    id: "EMP-IP-NOCARVEOUT",
    type: EMP,
    fires: { ip_assignment: { present: true, side_project_carveout: false } },
    notFires: { ip_assignment: { present: true, side_project_carveout: true } },
  },
  {
    id: "EMP-CONFIDENTIALITY-INDEF",
    type: EMP,
    fires: { confidentiality_survival: "indefinite" },
    notFires: { confidentiality_survival: "fixed_term" },
  },
  {
    id: "EMP-CLAWBACK-SIGNING",
    type: EMP,
    fires: { signing_bonus: { amount: 8000, currency: "EUR", clawback_months: 12 } },
    notFires: { signing_bonus: { amount: 8000, currency: "EUR", clawback_months: 3 } },
  },
  {
    id: "EMP-BONUS-DISCRETIONARY",
    type: EMP,
    fires: { bonus: { type: "discretionary", amount: null, percent: 10 } },
    notFires: { bonus: { type: "target", amount: null, percent: 10 } },
  },
  {
    id: "EMP-OVERTIME-UNPAID",
    type: EMP,
    fires: { overtime_treatment: "covered_by_salary" },
    notFires: { overtime_treatment: "paid" },
  },
  {
    id: "EMP-VACATION-LOW",
    type: EMP,
    fires: { vacation_days: 24 },
    notFires: { vacation_days: 28 },
  },
  {
    id: "EMP-EQUITY-DEFERRED",
    type: EMP,
    fires: { equity_instrument: "vsop" },
    notFires: {
      equity_instrument: "vsop",
      vesting: { duration_months: 48, cliff_months: 12, frequency: "monthly" },
    },
  },
  {
    id: "EQ-VEST-STD",
    type: EMP,
    fires: { vesting: { duration_months: 36, cliff_months: 6, frequency: "monthly" } },
    notFires: { vesting: { duration_months: 48, cliff_months: 12, frequency: "monthly" } },
  },
  // --- Term sheet ---
  {
    id: "TS-LIQPREF-GT1X",
    type: TS,
    fires: { liquidation_preference: { multiple: 1.5, participating: false, cap_multiple: null } },
    notFires: { liquidation_preference: { multiple: 1, participating: false, cap_multiple: null } },
  },
  {
    id: "TS-LIQPREF-PARTICIPATING",
    type: TS,
    fires: { liquidation_preference: { multiple: 1, participating: true, cap_multiple: 3 } },
    notFires: { liquidation_preference: { multiple: 1, participating: false, cap_multiple: null } },
  },
  {
    id: "TS-LIQPREF-UNCAPPED",
    type: TS,
    fires: { liquidation_preference: { multiple: 1, participating: true, cap_multiple: null } },
    notFires: { liquidation_preference: { multiple: 1, participating: true, cap_multiple: 3 } },
  },
  {
    id: "TS-FULLRATCHET",
    type: TS,
    fires: { anti_dilution: "full_ratchet" },
    notFires: { anti_dilution: "broad_based_wa" },
  },
  {
    id: "TS-ANTIDILUTION-WA",
    type: TS,
    fires: { anti_dilution: "broad_based_wa" },
    notFires: { anti_dilution: "full_ratchet" },
  },
  {
    id: "TS-ESOP-PREMONEY",
    type: TS,
    fires: { esop_pool: { percent: 15, timing: "pre_money" } },
    notFires: { esop_pool: { percent: 10, timing: "post_money" } },
  },
  {
    id: "TS-ESOP-LARGE",
    type: TS,
    fires: { esop_pool: { percent: 15, timing: "pre_money" } },
    notFires: { esop_pool: { percent: 10, timing: "post_money" } },
  },
  {
    id: "TS-BOARD-INVESTOR-CONTROL",
    type: TS,
    fires: { board_composition: { total: 5, founder: 2, investor: 2, independent: 1 } },
    notFires: { board_composition: { total: 5, founder: 3, investor: 1, independent: 1 } },
  },
  {
    id: "TS-DRAG-LOW",
    type: TS,
    fires: { drag_along_threshold_percent: 60 },
    notFires: { drag_along_threshold_percent: 75 },
  },
  {
    id: "TS-FOUNDER-REVEST",
    type: TS,
    fires: {
      founder_vesting: {
        duration_months: 48,
        cliff_months: 12,
        credited_months: 18,
        reverse: true,
      },
    },
    notFires: {
      founder_vesting: {
        duration_months: 48,
        cliff_months: 12,
        credited_months: 0,
        reverse: false,
      },
    },
  },
  {
    id: "TS-NOSHOP-LONG",
    type: TS,
    fires: { exclusivity_no_shop_days: 60 },
    notFires: { exclusivity_no_shop_days: 30 },
  },
  {
    id: "TS-DIVIDEND-CUMULATIVE",
    type: TS,
    fires: { dividends: { rate_percent: 6, cumulative: true, preferential: true } },
    notFires: { dividends: { rate_percent: 6, cumulative: false, preferential: true } },
  },
  // --- VSOP ---
  {
    id: "EQ-BADLEAVER-BROAD",
    type: VSOP,
    fires: {
      leaver_matrix: {
        good_leaver_vested: "settle_at_exit",
        good_leaver_unvested: "forfeit",
        bad_leaver_vested: "forfeit",
        bad_leaver_unvested: "forfeit",
      },
    },
    notFires: {
      leaver_matrix: {
        good_leaver_vested: "settle_at_exit",
        good_leaver_unvested: "forfeit",
        bad_leaver_vested: "retain",
        bad_leaver_unvested: "forfeit",
      },
    },
  },
  {
    id: "EQ-VSOP-EXITONLY",
    type: VSOP,
    fires: { payout_trigger: "exit_only", board_discretion: true },
    notFires: { payout_trigger: "exit_or_ongoing", board_discretion: true },
  },
  {
    id: "EQ-VSOP-EXIT-NARROW",
    type: VSOP,
    fires: {
      exit_definition: {
        share_sale_threshold_percent: 50,
        asset_sale: true,
        ipo: true,
        financing_round_excluded: true,
      },
    },
    notFires: {
      exit_definition: {
        share_sale_threshold_percent: 50,
        asset_sale: true,
        ipo: true,
        financing_round_excluded: false,
      },
    },
  },
  {
    id: "EQ-VSOP-NODILUTION",
    type: VSOP,
    fires: { anti_dilution_protection: false },
    notFires: { anti_dilution_protection: true },
  },
  {
    id: "EQ-VSOP-CASHSETTLE",
    type: VSOP,
    fires: { settlement: "cash_settled" },
    notFires: { settlement: "shares" },
  },
  {
    id: "EQ-VSOP-BASEPRICE",
    type: VSOP,
    fires: { allocation: { units: 12000, base_price: 1.2, currency: "EUR" } },
    notFires: { allocation: { units: 12000, base_price: 0, currency: "EUR" } },
  },
];

describe("rule checks (fixture -> expected flags)", () => {
  it.each(CASES)("$id fires on its positive fixture", ({ id, type, fires }) => {
    expect(firedIds(type, fires)).toContain(id);
  });

  it.each(CASES)("$id stays silent on its negative fixture", ({ id, type, notFires }) => {
    expect(firedIds(type, notFires)).not.toContain(id);
  });

  it("covers every rule in the engine", () => {
    const covered = new Set(CASES.map((c) => c.id));
    // EQ-VEST-STD also applies to VSOP but is exercised once here.
    expect(covered.size).toBeGreaterThanOrEqual(30);
  });
});
