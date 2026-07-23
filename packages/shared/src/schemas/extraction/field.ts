import { z } from "zod";

import { clauseIdSchema } from "../ids.js";

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
    citations: z.array(clauseIdSchema),
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
