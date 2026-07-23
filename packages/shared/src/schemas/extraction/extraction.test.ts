import { describe, expect, it } from "vitest";

import { notFound } from "./field.js";
import { employmentExtractionSchema } from "./employment.js";
import { extractionSchemaForType } from "./index.js";
import { termSheetExtractionSchema } from "./term-sheet.js";
import { vsopExtractionSchema } from "./vsop.js";

const DOC_ID = "0197a3b2-1c4d-7e5f-8a9b-0c1d2e3f4a5b";

function allNotFound(schema: { shape: Record<string, unknown> }): Record<string, unknown> {
  return Object.fromEntries(Object.keys(schema.shape).map((k) => [k, notFound()]));
}

describe("extraction family schemas", () => {
  it("accept an all-not_found document (not_found is a first-class value)", () => {
    for (const schema of [
      employmentExtractionSchema,
      vsopExtractionSchema,
      termSheetExtractionSchema,
    ]) {
      expect(schema.safeParse(allNotFound(schema)).success).toBe(true);
    }
  });

  it("accept a populated field with a serialized clause-id citation", () => {
    const doc = allNotFound(employmentExtractionSchema);
    doc.probation_period_months = {
      value: 6,
      confidence: "high",
      citations: [`${DOC_ID}:1:§2`],
      verbatim_anchor: "Die Probezeit beträgt sechs Monate.",
      status: "extracted",
    };
    expect(employmentExtractionSchema.safeParse(doc).success).toBe(true);
  });

  it("reject a citation that is a clause_ref rather than a full clause_id", () => {
    const doc = allNotFound(employmentExtractionSchema);
    doc.probation_period_months = {
      value: 6,
      confidence: "high",
      citations: ["1:§2"],
      verbatim_anchor: "x",
      status: "extracted",
    };
    expect(employmentExtractionSchema.safeParse(doc).success).toBe(false);
  });
});

describe("extractionSchemaForType", () => {
  it("maps document types to extraction families", () => {
    expect(extractionSchemaForType("employment_offer")?.family).toBe("employment");
    expect(extractionSchemaForType("employment_contract")?.family).toBe("employment");
    expect(extractionSchemaForType("vsop_esop_agreement")?.schemaVer).toBe("vsop@1");
    expect(extractionSchemaForType("term_sheet")?.family).toBe("term_sheet");
    expect(extractionSchemaForType("other")).toBeNull();
    expect(extractionSchemaForType("shareholders_agreement")).toBeNull();
  });
});
