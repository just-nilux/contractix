import { z } from "zod";

import { citedValue, moneySchema, vestingFrequencySchema } from "./field.js";

/**
 * Employment offer / contract schema (FR-3.1). Covers the demo offers and the
 * Arbeitsvertrag. Field granularity is chosen so the rules engine (FR-4) can
 * check terms directly: non_compete carries the Karenzentschädigung %, ip
 * assignment carries the side-project carve-out flag, notice periods are split
 * per side, etc. Equity/leaver detail is frequently deferred to a VSOP contract
 * (offer_de §4), so those fields legitimately resolve to not_found here.
 */
export const employmentExtractionSchema = z.object({
  // Compensation
  base_salary: citedValue(
    z.object({
      amount: z.number(),
      currency: z.string(),
      period: z.enum(["year", "month"]),
    }),
  ),
  bonus: citedValue(
    z.object({
      type: z.enum(["fixed", "target", "discretionary", "none"]),
      amount: z.number().nullable(),
      percent: z.number().nullable(),
    }),
  ),
  signing_bonus: citedValue(
    z.object({
      amount: z.number(),
      currency: z.string(),
      clawback_months: z.number().nullable(),
    }),
  ),
  benefits_summary: citedValue(z.string()),

  // Equity
  equity_instrument: citedValue(
    z.enum(["vsop", "esop_options", "real_shares_geschaeftsanteile", "rsu", "none"]),
  ),
  equity_grant: citedValue(
    z.object({ units: z.number().nullable(), percent: z.number().nullable() }),
  ),
  strike_price: citedValue(moneySchema),
  vesting: citedValue(
    z.object({
      duration_months: z.number(),
      cliff_months: z.number(),
      frequency: vestingFrequencySchema.nullable(),
    }),
  ),
  acceleration: citedValue(z.enum(["none", "single_trigger", "double_trigger"])),

  // Leaver
  good_leaver_definition: citedValue(z.string()),
  bad_leaver_definition: citedValue(z.string()),
  leaver_forfeiture: citedValue(
    z.object({
      unvested: z.enum(["forfeit", "retain", "pro_rata"]),
      vested_bad_leaver: z.enum(["forfeit", "retain", "buyback"]),
      price_basis: z.string().nullable(),
    }),
  ),

  // Employment terms
  start_date: citedValue(z.string()),
  probation_period_months: citedValue(z.number()),
  notice_period_employee: citedValue(
    z.object({
      months: z.number().nullable(),
      to: z.enum(["month_end", "any", "fifteenth_or_month_end", "statutory"]).nullable(),
    }),
  ),
  notice_period_employer: citedValue(
    z.object({
      months: z.number().nullable(),
      basis: z.enum(["statutory", "contractual"]).nullable(),
    }),
  ),
  working_hours_per_week: citedValue(z.number()),
  overtime_treatment: citedValue(
    z.enum(["covered_by_salary", "paid", "time_off", "surcharge", "unspecified"]),
  ),
  vacation_days: citedValue(z.number()),
  remote_policy: citedValue(z.string()),

  // Restrictive covenants
  non_compete: citedValue(
    z.object({
      present: z.boolean(),
      duration_months: z.number().nullable(),
      karenzentschaedigung_percent: z.number().nullable(),
      scope: z.string().nullable(),
    }),
  ),
  non_solicit: citedValue(
    z.object({ present: z.boolean(), duration_months: z.number().nullable() }),
  ),
  ip_assignment: citedValue(z.object({ present: z.boolean(), side_project_carveout: z.boolean() })),
  confidentiality_survival: citedValue(z.enum(["none", "fixed_term", "indefinite"])),

  // Contract
  governing_law: citedValue(z.string()),
  contract_type: citedValue(z.enum(["befristet", "unbefristet"])),
  fixed_term_months: citedValue(z.number()),
  exclusivity: citedValue(z.enum(["none", "consent_required", "prohibited"])),
});
export type EmploymentExtraction = z.infer<typeof employmentExtractionSchema>;
