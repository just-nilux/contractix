import { type z } from "zod";

import { type DocumentType } from "../documents.js";
import { employmentExtractionSchema } from "./employment.js";
import { termSheetExtractionSchema } from "./term-sheet.js";
import { vsopExtractionSchema } from "./vsop.js";

export * from "./field.js";
export * from "./normalize.js";
export * from "./employment.js";
export * from "./term-sheet.js";
export * from "./vsop.js";

/** The extraction families and their schema versions (stamped onto extractions.schema_ver). */
export const EXTRACTION_SCHEMAS = {
  employment: { version: 1, schema: employmentExtractionSchema },
  vsop: { version: 1, schema: vsopExtractionSchema },
  term_sheet: { version: 1, schema: termSheetExtractionSchema },
} as const;

export type ExtractionFamily = keyof typeof EXTRACTION_SCHEMAS;

/** Which family applies to a document type; null = Q&A-only, no structured extraction (FR-1.2). */
const FAMILY_BY_TYPE: Record<DocumentType, ExtractionFamily | null> = {
  employment_offer: "employment",
  employment_contract: "employment",
  vsop_esop_agreement: "vsop",
  term_sheet: "term_sheet",
  shareholders_agreement: null,
  side_letter: null,
  other: null,
};

export interface ExtractionSchemaRef {
  family: ExtractionFamily;
  version: number;
  /** `${family}@${version}` — persisted as extractions.schema_ver. */
  schemaVer: string;
  schema: z.ZodType;
}

/** Resolve the extraction schema + versioned id for a document type, or null if none applies. */
export function extractionSchemaForType(type: DocumentType): ExtractionSchemaRef | null {
  const family = FAMILY_BY_TYPE[type];
  if (!family) return null;
  const entry = EXTRACTION_SCHEMAS[family];
  return {
    family,
    version: entry.version,
    schemaVer: `${family}@${entry.version}`,
    schema: entry.schema,
  };
}
