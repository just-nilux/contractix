import { describe, expect, it } from "vitest";

import { computeRulesMetrics, type FlagObservation } from "./rules-metrics.js";

function obs(
  ruleId: string,
  severity: FlagObservation["severity"],
  expected: boolean,
  fired: boolean,
): FlagObservation {
  return { ruleId, severity, expected, fired };
}

describe("computeRulesMetrics", () => {
  it("scores a perfect run as precision/recall/F1 = 1", () => {
    const m = computeRulesMetrics([obs("A", "red", true, true), obs("B", "amber", true, true)], 1);
    expect(m.overall.precision).toBe(1);
    expect(m.overall.recall).toBe(1);
    expect(m.overall.f1).toBe(1);
    expect(m.expected).toBe(2);
    expect(m.fired).toBe(2);
  });

  it("penalizes a false positive in precision and a false negative in recall", () => {
    // tp=1 (A), fp=1 (B fired, not expected), fn=1 (C expected, not fired)
    const m = computeRulesMetrics(
      [obs("A", "red", true, true), obs("B", "amber", false, true), obs("C", "info", true, false)],
      1,
    );
    expect(m.overall.tp).toBe(1);
    expect(m.overall.fp).toBe(1);
    expect(m.overall.fn).toBe(1);
    expect(m.overall.precision).toBeCloseTo(0.5);
    expect(m.overall.recall).toBeCloseTo(0.5);
    expect(m.overall.f1).toBeCloseTo(0.5);
  });

  it("buckets precision/recall by severity", () => {
    const m = computeRulesMetrics(
      [
        obs("A", "red", true, true), // red tp
        obs("B", "red", false, true), // red fp
        obs("C", "amber", true, false), // amber fn
      ],
      1,
    );
    expect(m.bySeverity.red.tp).toBe(1);
    expect(m.bySeverity.red.fp).toBe(1);
    expect(m.bySeverity.red.precision).toBeCloseTo(0.5);
    expect(m.bySeverity.red.recall).toBe(1); // no red false negatives
    expect(m.bySeverity.amber.fn).toBe(1);
    expect(m.bySeverity.amber.recall).toBe(0);
    expect(m.bySeverity.info.f1).toBe(1); // empty bucket scores 1
  });

  it("treats an empty observation set as a pass (nothing to get wrong)", () => {
    const m = computeRulesMetrics([], 0);
    expect(m.overall.precision).toBe(1);
    expect(m.overall.recall).toBe(1);
    expect(m.overall.f1).toBe(1);
  });
});
