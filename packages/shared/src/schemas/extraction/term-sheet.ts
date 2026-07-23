import { z } from "zod";

import { citedValue, moneySchema } from "./field.js";

/**
 * Term-sheet schema (FR-3.2). Fields track the economics and control terms the
 * rules engine flags: liquidation_preference carries multiple + participating +
 * cap, esop_pool carries pre/post-money timing, anti_dilution is an enum so
 * full-ratchet vs weighted-average is a direct check.
 */
export const termSheetExtractionSchema = z.object({
  // Round
  instrument: citedValue(z.enum(["priced_equity", "safe", "convertible", "wandeldarlehen"])),
  round_amount: citedValue(moneySchema),
  pre_money_valuation: citedValue(moneySchema),
  post_money_valuation: citedValue(moneySchema),
  price_per_share_basis: citedValue(z.enum(["fully_diluted", "as_converted", "other"])),

  // Economics
  liquidation_preference: citedValue(
    z.object({
      multiple: z.number(),
      participating: z.boolean(),
      cap_multiple: z.number().nullable(),
    }),
  ),
  anti_dilution: citedValue(z.enum(["none", "full_ratchet", "broad_based_wa", "narrow_based_wa"])),
  dividends: citedValue(
    z.object({
      rate_percent: z.number().nullable(),
      cumulative: z.boolean().nullable(),
      preferential: z.boolean().nullable(),
    }),
  ),

  // ESOP
  esop_pool: citedValue(
    z.object({ percent: z.number(), timing: z.enum(["pre_money", "post_money"]) }),
  ),

  // Control
  board_composition: citedValue(
    z.object({
      total: z.number(),
      founder: z.number().nullable(),
      investor: z.number().nullable(),
      independent: z.number().nullable(),
    }),
  ),
  consent_matters: citedValue(z.array(z.string())),
  information_rights: citedValue(z.string()),

  // Founder terms
  founder_vesting: citedValue(
    z.object({
      duration_months: z.number(),
      cliff_months: z.number(),
      credited_months: z.number().nullable(),
      reverse: z.boolean(),
    }),
  ),
  lockup_months: citedValue(z.number()),
  drag_along_threshold_percent: citedValue(z.number()),
  tag_along: citedValue(z.boolean()),
  pro_rata_rights: citedValue(z.boolean()),

  // Process
  exclusivity_no_shop_days: citedValue(z.number()),
  expenses_cap: citedValue(moneySchema),
  binding_sections: citedValue(z.string()),
});
export type TermSheetExtraction = z.infer<typeof termSheetExtractionSchema>;
