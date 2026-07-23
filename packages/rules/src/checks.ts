import { type CitedFieldValue, type ExtractedFields } from "@contractix/shared";

import { type CheckFn } from "./types.js";

// --- typed accessors over the extraction (a field only "counts" when extracted) ---

function extracted(ex: ExtractedFields, path: string): CitedFieldValue | undefined {
  const f = ex[path];
  return f?.status === "extracted" ? f : undefined;
}
function numOf(ex: ExtractedFields, path: string): number | undefined {
  const f = extracted(ex, path);
  return typeof f?.value === "number" ? f.value : undefined;
}
function strOf(ex: ExtractedFields, path: string): string | undefined {
  const f = extracted(ex, path);
  return typeof f?.value === "string" ? f.value : undefined;
}
function boolOf(ex: ExtractedFields, path: string): boolean | undefined {
  const f = extracted(ex, path);
  return typeof f?.value === "boolean" ? f.value : undefined;
}
function objOf(ex: ExtractedFields, path: string): Record<string, unknown> | undefined {
  const f = extracted(ex, path);
  return f && typeof f.value === "object" && f.value !== null
    ? (f.value as Record<string, unknown>)
    : undefined;
}
function n(o: Record<string, unknown> | undefined, k: string): number | undefined {
  return typeof o?.[k] === "number" ? o[k] : undefined;
}
function b(o: Record<string, unknown> | undefined, k: string): boolean | undefined {
  return typeof o?.[k] === "boolean" ? o[k] : undefined;
}
function s(o: Record<string, unknown> | undefined, k: string): string | undefined {
  return typeof o?.[k] === "string" ? o[k] : undefined;
}

/**
 * The deterministic checks, keyed by rule id (metadata lives in rules.yaml).
 * Each returns the triggering field paths or null. Pure functions over the
 * extracted schema — no LLM, no DB — so results are reproducible and auditable.
 */
export const CHECKS: Record<string, CheckFn> = {
  // --- Employment ---
  "DE-NONCOMP-KARENZ": (ex) => {
    const nc = objOf(ex, "non_compete");
    if (b(nc, "present") !== true) return null;
    const k = n(nc, "karenzentschaedigung_percent");
    return k == null || k < 50 ? ["non_compete"] : null;
  },
  "DE-NONCOMP-DURATION": (ex) => {
    const nc = objOf(ex, "non_compete");
    const d = n(nc, "duration_months");
    return b(nc, "present") === true && d != null && d > 24 ? ["non_compete"] : null;
  },
  "DE-PROBEZEIT-MAX": (ex) => {
    const p = numOf(ex, "probation_period_months");
    return p != null && p > 6 ? ["probation_period_months"] : null;
  },
  "EMP-CONTRACT-BEFRISTET": (ex) =>
    strOf(ex, "contract_type") === "befristet" ? ["contract_type"] : null,
  "EMP-NOTICE-ASYM": (ex) => {
    const emp = n(objOf(ex, "notice_period_employee"), "months");
    const empr = n(objOf(ex, "notice_period_employer"), "months");
    return emp != null && empr != null && emp > empr
      ? ["notice_period_employee", "notice_period_employer"]
      : null;
  },
  "EMP-IP-NOCARVEOUT": (ex) => {
    const ip = objOf(ex, "ip_assignment");
    return b(ip, "present") === true && b(ip, "side_project_carveout") === false
      ? ["ip_assignment"]
      : null;
  },
  "EMP-CONFIDENTIALITY-INDEF": (ex) =>
    strOf(ex, "confidentiality_survival") === "indefinite" ? ["confidentiality_survival"] : null,
  "EMP-CLAWBACK-SIGNING": (ex) => {
    const c = n(objOf(ex, "signing_bonus"), "clawback_months");
    return c != null && c >= 12 ? ["signing_bonus"] : null;
  },
  "EMP-BONUS-DISCRETIONARY": (ex) =>
    s(objOf(ex, "bonus"), "type") === "discretionary" ? ["bonus"] : null,
  "EMP-OVERTIME-UNPAID": (ex) =>
    strOf(ex, "overtime_treatment") === "covered_by_salary" ? ["overtime_treatment"] : null,
  "EMP-VACATION-LOW": (ex) => {
    const v = numOf(ex, "vacation_days");
    return v != null && v < 25 ? ["vacation_days"] : null;
  },
  "EMP-EQUITY-DEFERRED": (ex) => {
    const inst = strOf(ex, "equity_instrument");
    return inst && inst !== "none" && ex.vesting?.status === "not_found"
      ? ["equity_instrument"]
      : null;
  },

  // --- Equity (employment + vsop) ---
  "EQ-VEST-STD": (ex) => {
    const v = objOf(ex, "vesting");
    const dur = n(v, "duration_months");
    const cliff = n(v, "cliff_months");
    if (dur == null || cliff == null) return null;
    return dur !== 48 || cliff !== 12 ? ["vesting"] : null;
  },

  // --- Term sheet ---
  "TS-LIQPREF-GT1X": (ex) => {
    const m = n(objOf(ex, "liquidation_preference"), "multiple");
    return m != null && m > 1 ? ["liquidation_preference"] : null;
  },
  "TS-LIQPREF-PARTICIPATING": (ex) =>
    b(objOf(ex, "liquidation_preference"), "participating") === true
      ? ["liquidation_preference"]
      : null,
  "TS-LIQPREF-UNCAPPED": (ex) => {
    const lp = objOf(ex, "liquidation_preference");
    return b(lp, "participating") === true && lp?.cap_multiple == null
      ? ["liquidation_preference"]
      : null;
  },
  "TS-FULLRATCHET": (ex) =>
    strOf(ex, "anti_dilution") === "full_ratchet" ? ["anti_dilution"] : null,
  "TS-ANTIDILUTION-WA": (ex) => {
    const a = strOf(ex, "anti_dilution");
    return a === "broad_based_wa" || a === "narrow_based_wa" ? ["anti_dilution"] : null;
  },
  "TS-ESOP-PREMONEY": (ex) =>
    s(objOf(ex, "esop_pool"), "timing") === "pre_money" ? ["esop_pool"] : null,
  "TS-ESOP-LARGE": (ex) => {
    const p = n(objOf(ex, "esop_pool"), "percent");
    return p != null && p >= 15 ? ["esop_pool"] : null;
  },
  "TS-BOARD-INVESTOR-CONTROL": (ex) => {
    const bd = objOf(ex, "board_composition");
    const f = n(bd, "founder");
    const i = n(bd, "investor");
    return f != null && i != null && i >= f ? ["board_composition"] : null;
  },
  "TS-DRAG-LOW": (ex) => {
    const d = numOf(ex, "drag_along_threshold_percent");
    return d != null && d < 66 ? ["drag_along_threshold_percent"] : null;
  },
  "TS-FOUNDER-REVEST": (ex) =>
    b(objOf(ex, "founder_vesting"), "reverse") === true ? ["founder_vesting"] : null,
  "TS-NOSHOP-LONG": (ex) => {
    const d = numOf(ex, "exclusivity_no_shop_days");
    return d != null && d > 45 ? ["exclusivity_no_shop_days"] : null;
  },
  "TS-DIVIDEND-CUMULATIVE": (ex) =>
    b(objOf(ex, "dividends"), "cumulative") === true ? ["dividends"] : null,

  // --- VSOP / ESOP ---
  "EQ-BADLEAVER-BROAD": (ex) =>
    s(objOf(ex, "leaver_matrix"), "bad_leaver_vested") === "forfeit" ? ["leaver_matrix"] : null,
  "EQ-VSOP-EXITONLY": (ex) =>
    strOf(ex, "payout_trigger") === "exit_only" && boolOf(ex, "board_discretion") === true
      ? ["payout_trigger", "board_discretion"]
      : null,
  "EQ-VSOP-EXIT-NARROW": (ex) =>
    b(objOf(ex, "exit_definition"), "financing_round_excluded") === true
      ? ["exit_definition"]
      : null,
  "EQ-VSOP-NODILUTION": (ex) =>
    boolOf(ex, "anti_dilution_protection") === false ? ["anti_dilution_protection"] : null,
  "EQ-VSOP-CASHSETTLE": (ex) =>
    strOf(ex, "settlement") === "cash_settled" ? ["settlement"] : null,
  "EQ-VSOP-BASEPRICE": (ex) => {
    const bp = n(objOf(ex, "allocation"), "base_price");
    return bp != null && bp > 0 ? ["allocation"] : null;
  },
};
