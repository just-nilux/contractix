import { z } from "zod";

import { citedValue, vestingFrequencySchema } from "./field.js";

/**
 * VSOP/ESOP agreement schema (FR-3.3). Captures the mechanics the rules engine
 * needs for virtual-option red flags: the leaver_matrix (bad-leaver full
 * forfeiture), the narrow exit_definition (financing rounds excluded),
 * board_discretion over payout, and settlement (cash vs shares).
 */
export const vsopExtractionSchema = z.object({
  allocation: citedValue(
    z.object({
      units: z.number(),
      base_price: z.number().nullable(),
      currency: z.string().nullable(),
    }),
  ),
  vesting: citedValue(
    z.object({
      duration_months: z.number(),
      cliff_months: z.number(),
      cliff_percent: z.number().nullable(),
      frequency: vestingFrequencySchema.nullable(),
    }),
  ),
  settlement: citedValue(z.enum(["cash_settled", "shares", "either"])),
  exit_definition: citedValue(
    z.object({
      share_sale_threshold_percent: z.number().nullable(),
      asset_sale: z.boolean(),
      ipo: z.boolean(),
      financing_round_excluded: z.boolean(),
    }),
  ),
  payout_trigger: citedValue(z.enum(["exit_only", "exit_or_ongoing", "ongoing"])),
  board_discretion: citedValue(z.boolean()),
  good_leaver_definition: citedValue(z.string()),
  bad_leaver_definition: citedValue(z.string()),
  leaver_matrix: citedValue(
    z.object({
      good_leaver_vested: z.enum(["retain", "forfeit", "settle_at_exit"]),
      good_leaver_unvested: z.enum(["retain", "forfeit"]),
      bad_leaver_vested: z.enum(["retain", "forfeit"]),
      bad_leaver_unvested: z.enum(["retain", "forfeit"]),
    }),
  ),
  anti_dilution_protection: citedValue(z.boolean()),
  transfer_restrictions: citedValue(z.enum(["non_assignable", "restricted", "free"])),
  tax_remark_present: citedValue(z.boolean()),
  pool_size_percent: citedValue(z.number()),
});
export type VsopExtraction = z.infer<typeof vsopExtractionSchema>;
