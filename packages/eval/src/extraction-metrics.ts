import { valuesMatch } from "@contractix/shared";

/**
 * Gold match with subset semantics for objects: gold may specify only the
 * salient keys of a compound value (e.g. non_compete without `scope`), and a
 * field matches if every gold key matches. Scalars/arrays use the shared
 * normalized comparator.
 */
export function goldMatches(gold: unknown, actual: unknown): boolean {
  if (
    gold !== null &&
    typeof gold === "object" &&
    !Array.isArray(gold) &&
    actual !== null &&
    typeof actual === "object" &&
    !Array.isArray(actual)
  ) {
    const g = gold as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    return Object.keys(g).every((k) => goldMatches(g[k], a[k]));
  }
  return valuesMatch(gold, actual);
}

export interface ScoredField {
  /** gold says this field is absent from the document. */
  goldNotFound: boolean;
  /** the model returned a value (status "extracted"). */
  extracted: boolean;
  /** goldMatches(gold.value, actual.value) — only meaningful for present + extracted fields. */
  valueMatch: boolean;
  /** number of gold citation refs for this field. */
  goldCitations: number;
  /** gold citations the extraction actually cited. */
  citationHits: number;
}

export interface ExtractionMetrics {
  n: number;
  presentFields: number;
  absentFields: number;
  /** correct present extractions / present gold fields (the headline accuracy). */
  extractionAccuracy: number;
  /** (correct present + correct absent) / all gold fields. */
  overallAccuracy: number;
  /** correct not_found / all model not_found predictions — abstention quality. */
  notFoundPrecision: number;
  /** present-but-invented on absent fields / absent gold fields — the worst failure. */
  hallucinationRate: number;
  /** gold citations cited / gold citations total, over present fields. */
  citationRecall: number;
}

function ratio(num: number, den: number): number {
  return den === 0 ? 1 : num / den;
}

export function computeExtractionMetrics(fields: ScoredField[]): ExtractionMetrics {
  const present = fields.filter((f) => !f.goldNotFound);
  const absent = fields.filter((f) => f.goldNotFound);

  const correctPresent = present.filter((f) => f.extracted && f.valueMatch).length;
  const correctAbsent = absent.filter((f) => !f.extracted).length;
  const hallucinated = absent.filter((f) => f.extracted).length;
  const predictedNotFound = fields.filter((f) => !f.extracted).length;

  const goldCitations = present.reduce((s, f) => s + f.goldCitations, 0);
  const citationHits = present.reduce((s, f) => s + f.citationHits, 0);

  return {
    n: fields.length,
    presentFields: present.length,
    absentFields: absent.length,
    extractionAccuracy: ratio(correctPresent, present.length),
    overallAccuracy: ratio(correctPresent + correctAbsent, fields.length),
    notFoundPrecision: ratio(correctAbsent, predictedNotFound),
    hallucinationRate: ratio(hallucinated, absent.length),
    citationRecall: ratio(citationHits, goldCitations),
  };
}
