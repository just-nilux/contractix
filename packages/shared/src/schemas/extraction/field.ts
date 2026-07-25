import { z } from "zod";

export const confidenceSchema = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof confidenceSchema>;

export const extractionStatusSchema = z.enum(["extracted", "not_found", "extraction_failed"]);
export type ExtractionStatus = z.infer<typeof extractionStatusSchema>;

/** Amount + ISO-4217-ish currency code. Normalizers (normalize.ts) produce this shape. */
export const moneySchema = z.object({
  amount: z.number(),
  currency: z.string(),
});
export type Money = z.infer<typeof moneySchema>;

export const vestingFrequencySchema = z.enum(["monthly", "quarterly", "annual"]);
export type VestingFrequency = z.infer<typeof vestingFrequencySchema>;

/**
 * Every extracted field is a cited value (FR-3): the typed value (null when
 * absent), an optional unit, a confidence band, the serialized clause ids that
 * support it, a verbatim anchor quoted from the source span, and a status.
 * `not_found` is first-class — a field with no supporting clause is reported,
 * never inferred; `extraction_failed` marks a field the model could not return
 * validly even after the repair pass (FR-3.4).
 */
export function citedValue<T extends z.ZodType>(value: T) {
  return z.object({
    value: value.nullable(),
    unit: z.string().optional(),
    confidence: confidenceSchema,
    // Citations are model-provided HINTS, resolved structurally downstream
    // (citation-resolver.ts; ADR-0006/0007) by locating verbatim_anchor in the
    // clause's frozen text — never by trusting the id's format. We accept any
    // string, not clauseIdSchema: a small model rarely echoes the long
    // "{uuid}:{page}:{path}" id verbatim, and a strict schema turned one bad id
    // into a whole-document extraction failure (the exact defect the live eval
    // caught). Format is validated at resolve time, where a bad id is tolerated.
    citations: z.array(z.string()),
    verbatim_anchor: z.string(),
    status: extractionStatusSchema,
  });
}

/** A field that was absent from the source — the canonical `not_found` cited value. */
export function notFound(): {
  value: null;
  confidence: Confidence;
  citations: string[];
  verbatim_anchor: string;
  status: ExtractionStatus;
} {
  return {
    value: null,
    confidence: "low",
    citations: [],
    verbatim_anchor: "",
    status: "not_found",
  };
}

/**
 * Runtime shape of a single cited field, for code that iterates an extraction
 * without knowing the family at compile time (the extraction service persisting
 * rows, the eval scoring fields). The Zod family schemas guarantee this shape.
 */
export interface CitedFieldValue {
  value: unknown;
  unit?: string;
  confidence: Confidence;
  citations: string[];
  verbatim_anchor: string;
  status: ExtractionStatus;
}

/** A validated extraction as a field map (fieldPath -> cited value). */
export type ExtractedFields = Record<string, CitedFieldValue>;
