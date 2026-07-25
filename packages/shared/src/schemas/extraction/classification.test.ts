import { describe, expect, it } from "vitest";

import { classificationSchema } from "./classification.js";

describe("classificationSchema", () => {
  it("accepts a valid classification over the FR-1.2 taxonomy", () => {
    const parsed = classificationSchema.safeParse({
      document_type: "employment_offer",
      confidence: "high",
      reasoning: "Titled 'Arbeitsvertrag' with base salary and start date.",
    });
    expect(parsed.success).toBe(true);
  });

  it("makes reasoning optional", () => {
    expect(
      classificationSchema.safeParse({ document_type: "term_sheet", confidence: "medium" }).success,
    ).toBe(true);
  });

  it("rejects a document_type outside the taxonomy", () => {
    expect(
      classificationSchema.safeParse({ document_type: "invoice", confidence: "low" }).success,
    ).toBe(false);
  });

  it("rejects an invalid confidence band", () => {
    expect(
      classificationSchema.safeParse({ document_type: "other", confidence: "certain" }).success,
    ).toBe(false);
  });
});
