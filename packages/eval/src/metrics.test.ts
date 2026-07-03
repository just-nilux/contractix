import { describe, expect, it } from "vitest";

import { computeMetrics, type QuestionResult } from "./metrics.js";

const q = (
  id: string,
  firstGoldRank: number | null,
  goldFound = firstGoldRank ? 1 : 0,
  goldTotal = 1,
): QuestionResult => ({
  id,
  hit: firstGoldRank !== null,
  firstGoldRank,
  goldFound,
  goldTotal,
  latencyMs: 10,
});

describe("computeMetrics", () => {
  it("computes recall, mrr, and all-gold coverage", () => {
    const m = computeMetrics([
      q("a", 1), // rr 1
      q("b", 4), // rr 0.25
      q("c", null), // miss
      q("d", 2, 1, 2), // rr 0.5, partial gold coverage
    ]);
    expect(m.n).toBe(4);
    expect(m.recallAtK).toBeCloseTo(3 / 4);
    expect(m.mrrAtK).toBeCloseTo((1 + 0.25 + 0 + 0.5) / 4);
    expect(m.allGoldCoverageAtK).toBeCloseTo(2 / 4); // d found 1 of 2 golds
  });

  it("refuses empty result sets", () => {
    expect(() => computeMetrics([])).toThrow();
  });
});
