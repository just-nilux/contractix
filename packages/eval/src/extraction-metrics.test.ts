import { describe, expect, it } from "vitest";

import { computeExtractionMetrics, goldMatches, type ScoredField } from "./extraction-metrics.js";

describe("goldMatches", () => {
  it("matches an object gold as a subset of the actual value", () => {
    expect(
      goldMatches(
        { present: true, karenzentschaedigung_percent: 30 },
        { present: true, duration_months: 12, karenzentschaedigung_percent: 30, scope: "DE" },
      ),
    ).toBe(true);
    expect(
      goldMatches(
        { amount: 98000, currency: "EUR" },
        { amount: 98000, currency: "EUR", period: "year" },
      ),
    ).toBe(true);
  });

  it("fails when a specified gold key differs", () => {
    expect(
      goldMatches({ karenzentschaedigung_percent: 50 }, { karenzentschaedigung_percent: 30 }),
    ).toBe(false);
  });

  it("normalizes scalars", () => {
    expect(goldMatches(6, 6)).toBe(true);
    expect(goldMatches("indefinite", "Indefinite ")).toBe(true);
  });
});

describe("computeExtractionMetrics", () => {
  it("scores present/absent/hallucinated fields", () => {
    const fields: ScoredField[] = [
      { goldNotFound: false, extracted: true, valueMatch: true, goldCitations: 1, citationHits: 1 },
      {
        goldNotFound: false,
        extracted: true,
        valueMatch: false,
        goldCitations: 1,
        citationHits: 0,
      },
      {
        goldNotFound: false,
        extracted: false,
        valueMatch: false,
        goldCitations: 1,
        citationHits: 0,
      },
      {
        goldNotFound: true,
        extracted: false,
        valueMatch: false,
        goldCitations: 0,
        citationHits: 0,
      },
      { goldNotFound: true, extracted: true, valueMatch: false, goldCitations: 0, citationHits: 0 },
    ];
    const m = computeExtractionMetrics(fields);
    expect(m.n).toBe(5);
    expect(m.presentFields).toBe(3);
    expect(m.absentFields).toBe(2);
    expect(m.extractionAccuracy).toBeCloseTo(1 / 3, 6);
    expect(m.overallAccuracy).toBeCloseTo(0.4, 6);
    expect(m.notFoundPrecision).toBeCloseTo(0.5, 6);
    expect(m.hallucinationRate).toBeCloseTo(0.5, 6);
    expect(m.citationRecall).toBeCloseTo(1 / 3, 6);
  });
});
