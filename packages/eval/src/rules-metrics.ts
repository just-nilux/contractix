import { type Severity } from "@contractix/rules";

/**
 * One (document, rule) observation: was the flag expected by the gold, and did
 * the deterministic engine fire it? `severity` is the rule's severity (from the
 * fired flag when it fired, else from the gold entry) — used for the per-severity
 * breakdown.
 */
export interface FlagObservation {
  ruleId: string;
  severity: Severity;
  expected: boolean;
  fired: boolean;
}

export interface Prf {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface RulesMetrics {
  /** documents evaluated. */
  docs: number;
  /** total expected flags across all docs (tp + fn). */
  expected: number;
  /** total fired flags across all docs (tp + fp). */
  fired: number;
  overall: Prf;
  /** precision/recall/F1 restricted to each severity bucket. */
  bySeverity: Record<Severity, Prf>;
}

const SEVERITIES: Severity[] = ["red", "amber", "info"];

/** precision/recall/F1 from raw counts. Empty buckets score 1 (nothing to get wrong). */
function prf(tp: number, fp: number, fn: number): Prf {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

function countPrf(obs: FlagObservation[]): Prf {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const o of obs) {
    if (o.expected && o.fired) tp++;
    else if (!o.expected && o.fired) fp++;
    else if (o.expected && !o.fired) fn++;
  }
  return prf(tp, fp, fn);
}

/**
 * Corpus-level red-flag accuracy (PRD E-2, "rules engine"): precision, recall and
 * F1 of the fired flags against the human-labeled gold, overall and per severity.
 * Deterministic — the same observations always yield the same numbers.
 */
export function computeRulesMetrics(obs: FlagObservation[], docs: number): RulesMetrics {
  const bySeverity = Object.fromEntries(
    SEVERITIES.map((sev) => [sev, countPrf(obs.filter((o) => o.severity === sev))]),
  ) as Record<Severity, Prf>;

  return {
    docs,
    expected: obs.filter((o) => o.expected).length,
    fired: obs.filter((o) => o.fired).length,
    overall: countPrf(obs),
    bySeverity,
  };
}
