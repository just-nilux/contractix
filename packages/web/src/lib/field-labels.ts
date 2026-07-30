/**
 * Human labels for extraction field paths.
 *
 * German terms are kept in German where that *is* the term of art - a reader
 * negotiating a DE contract is looking for "Probezeit", not "probation period",
 * and translating it makes the report harder to check against the document.
 */
const LABELS: Record<string, string> = {
  // employment
  base_salary: "Base salary",
  bonus: "Bonus",
  signing_bonus: "Signing bonus",
  benefits_summary: "Benefits",
  equity_instrument: "Equity instrument",
  equity_grant: "Grant size",
  strike_price: "Strike / base price",
  vesting: "Vesting",
  acceleration: "Acceleration",
  good_leaver_definition: "Good-leaver definition",
  bad_leaver_definition: "Bad-leaver definition",
  leaver_forfeiture: "Forfeiture on leaving",
  start_date: "Start date",
  probation_period_months: "Probezeit",
  notice_period_employee: "Notice period (employee)",
  notice_period_employer: "Notice period (employer)",
  working_hours_per_week: "Working hours per week",
  overtime_treatment: "Overtime",
  vacation_days: "Vacation days",
  remote_policy: "Remote policy",
  non_compete: "Post-contractual non-compete",
  non_solicit: "Non-solicit",
  ip_assignment: "IP assignment",
  confidentiality_survival: "Confidentiality survival",
  governing_law: "Governing law",
  contract_type: "Contract type",
  fixed_term_months: "Fixed term",
  exclusivity: "Exclusivity / side work",

  // vsop
  allocation: "Allocation",
  settlement: "Settlement",
  exit_definition: "Exit definition",
  payout_trigger: "Payout trigger",
  board_discretion: "Board discretion",
  leaver_matrix: "Leaver treatment",
  anti_dilution_protection: "Anti-dilution protection",
  transfer_restrictions: "Transfer restrictions",
  tax_remark_present: "Tax remark present",
  pool_size_percent: "Pool size",

  // term sheet
  instrument: "Instrument",
  round_amount: "Round amount",
  pre_money_valuation: "Pre-money valuation",
  post_money_valuation: "Post-money valuation",
  price_per_share_basis: "Price per share",
  liquidation_preference: "Liquidation preference",
  anti_dilution: "Anti-dilution",
  dividends: "Dividends",
  esop_pool: "ESOP pool",
  board_composition: "Board composition",
  consent_matters: "Consent / veto matters",
  information_rights: "Information rights",
  founder_vesting: "Founder vesting",
  lockup_months: "Lock-up",
  drag_along_threshold_percent: "Drag-along threshold",
  tag_along: "Tag-along",
  pro_rata_rights: "Pro-rata rights",
  exclusivity_no_shop_days: "Exclusivity / no-shop",
  expenses_cap: "Expenses cap",
  binding_sections: "Binding sections",
};

/** `notice_period_employee` -> "Notice period employee" when nothing better exists. */
export function labelFor(fieldPath: string): string {
  const known = LABELS[fieldPath];
  if (known !== undefined) return known;
  const words = fieldPath.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
