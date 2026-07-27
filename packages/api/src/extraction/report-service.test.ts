import { serializeClauseId } from "@contractix/shared";
import { describe, expect, it } from "vitest";

import { composeDocumentReport, type ComposeReportInput } from "./report-service.js";

const DOC_ID = "0197a3b2-1c4d-7e5f-8a9b-0c1d2e3f4a5b";
const CLAUSE_A = "0197a3b2-1c4d-7e5f-8a9b-0c1d2e3f4a01";
const CLAUSE_B = "0197a3b2-1c4d-7e5f-8a9b-0c1d2e3f4a02";

function baseDoc(): ComposeReportInput["document"] {
  return {
    id: DOC_ID,
    caseId: "0197a3b2-1c4d-7e5f-8a9b-0c1d2e3f4a00",
    filename: "offer.pdf",
    type: "employment_offer",
    language: "de",
    status: "ready",
    analysisStatus: "analyzed",
    pageCount: 3,
  };
}

describe("composeDocumentReport", () => {
  it("attaches stored citation spans to fields verbatim (no recompute)", () => {
    const report = composeDocumentReport({
      document: baseDoc(),
      extractionRows: [
        {
          id: "e1",
          schemaVer: "employment@1",
          fieldPath: "base_salary",
          value: 90000,
          unit: "EUR",
          confidence: "high",
          status: "extracted",
        },
        {
          id: "e2",
          schemaVer: "employment@1",
          fieldPath: "bonus",
          value: null,
          unit: null,
          confidence: "low",
          status: "not_found",
        },
      ],
      citationRows: [
        {
          extractionId: "e1",
          clauseId: CLAUSE_A,
          charStart: 40,
          charEnd: 52,
          verbatimAnchor: "90.000 EUR",
        },
      ],
      flagRows: [],
      clauseById: new Map([[CLAUSE_A, { clauseRef: "1:§4", page: 1, heading: "Vergütung" }]]),
    });

    expect(report.extraction?.schemaVer).toBe("employment@1");
    const salary = report.extraction!.fields.find((f) => f.fieldPath === "base_salary")!;
    expect(salary.citations).toHaveLength(1);
    const cit = salary.citations[0]!;
    expect(cit.charStart).toBe(40);
    expect(cit.charEnd).toBe(52);
    expect(cit.verbatimAnchor).toBe("90.000 EUR");
    expect(cit.serializedClauseId).toBe(serializeClauseId(DOC_ID, "1:§4"));
    expect(cit.page).toBe(1);

    // A not_found field carries no citations.
    expect(report.extraction!.fields.find((f) => f.fieldPath === "bonus")!.citations).toEqual([]);
    expect(report.summary).toEqual({
      flagCounts: { red: 0, amber: 0, info: 0 },
      extractedFieldCount: 1,
      notFoundCount: 1,
    });
    expect(report.disclaimer).toMatch(/not legal or tax advice/u);
  });

  it("sorts flags red -> amber -> info, counts them, and cites whole clauses", () => {
    const report = composeDocumentReport({
      document: baseDoc(),
      extractionRows: [],
      citationRows: [],
      flagRows: [
        {
          ruleId: "R-INFO",
          ruleVersion: "1",
          severity: "info",
          clauseIds: [CLAUSE_B],
          rationale: "fyi",
          negotiationHint: null,
          sources: [],
        },
        {
          ruleId: "R-RED",
          ruleVersion: "1",
          severity: "red",
          clauseIds: [CLAUSE_A],
          rationale: "bad",
          negotiationHint: "push back",
          sources: ["§74 HGB"],
        },
        {
          ruleId: "R-AMBER",
          ruleVersion: "1",
          severity: "amber",
          clauseIds: [],
          rationale: "meh",
          negotiationHint: null,
          sources: null,
        },
      ],
      clauseById: new Map([
        [CLAUSE_A, { clauseRef: "2:§11", page: 2, heading: "Wettbewerbsverbot" }],
        [CLAUSE_B, { clauseRef: "1:§1", page: 1, heading: null }],
      ]),
    });

    expect(report.flags.map((f) => f.ruleId)).toEqual(["R-RED", "R-AMBER", "R-INFO"]);
    expect(report.summary.flagCounts).toEqual({ red: 1, amber: 1, info: 1 });
    // No extraction rows -> the section is null (Q&A-only type or not yet analyzed).
    expect(report.extraction).toBeNull();

    const red = report.flags[0]!;
    expect(red.citations[0]!.serializedClauseId).toBe(serializeClauseId(DOC_ID, "2:§11"));
    expect(red.citations[0]!.charStart).toBeNull(); // flags cite whole clauses, not spans
    expect(red.sources).toEqual(["§74 HGB"]);
    expect(report.flags[2]!.sources).toEqual([]); // null sources normalize to []
  });
});
