import { z } from "zod";

/**
 * PRD FR-1.2 document taxonomy. Mirrors `documentTypeEnum` in the API's Drizzle
 * schema (packages/api/src/db/schema/documents.ts) — the two lists must stay in
 * lockstep; this one is the shared source used by extraction-schema dispatch.
 */
export const documentTypeSchema = z.enum([
  "employment_offer",
  "employment_contract",
  "vsop_esop_agreement",
  "term_sheet",
  "shareholders_agreement",
  "side_letter",
  "other",
]);
export type DocumentType = z.infer<typeof documentTypeSchema>;

export const languageSchema = z.enum(["de", "en", "mixed"]);
export type Language = z.infer<typeof languageSchema>;
