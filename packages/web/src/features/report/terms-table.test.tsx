import { type ReportField } from "@contractix/shared/schemas";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CitationProvider } from "../../citations/citation-context.js";
import { TermsTable } from "./terms-table.js";

function field(overrides: Partial<ReportField> & { fieldPath: string }): ReportField {
  return {
    value: null,
    unit: null,
    confidence: "high",
    status: "not_found",
    citations: [],
    ...overrides,
  };
}

function renderTable(fields: ReportField[], schemaVer = "employment@1") {
  return render(
    <CitationProvider>
      <TermsTable extraction={{ schemaVer, fields }} documentId="doc-1" />
    </CitationProvider>,
  );
}

describe("TermsTable", () => {
  it("shows a missing term as a first-class value, not a blank cell", () => {
    // FR-3: `not_found` is reported, never inferred — and never silently empty,
    // which would read as "we didn't look".
    renderTable([field({ fieldPath: "signing_bonus" })]);

    const row = screen.getByRole("row", { name: /signing bonus/i });
    expect(within(row).getByText("not found in document")).toBeInTheDocument();
  });

  it("distinguishes a failed extraction from an absent term", () => {
    renderTable([field({ fieldPath: "bonus", status: "extraction_failed" })]);

    expect(screen.getByText("could not be extracted")).toBeInTheDocument();
    expect(screen.queryByText("not found in document")).not.toBeInTheDocument();
  });

  it("formats money as money rather than as its JSON shape", () => {
    renderTable([
      field({
        fieldPath: "base_salary",
        status: "extracted",
        value: { amount: 98000, currency: "EUR", period: "year" },
      }),
    ]);

    expect(screen.getByText("€98,000 / year")).toBeInTheDocument();
  });

  it("renders an unrecognised value shape rather than hiding it", () => {
    renderTable([
      field({
        fieldPath: "vesting",
        status: "extracted",
        value: { months: 48, cliff_months: 12, single_trigger: false },
      }),
    ]);

    // A term the reader cannot see is worse than one that is ugly.
    expect(screen.getByText(/months: 48/)).toBeInTheDocument();
    expect(screen.getByText(/no single trigger/)).toBeInTheDocument();
  });

  it("orders rows by the schema's declaration order, not the response order", () => {
    renderTable([
      field({ fieldPath: "vacation_days" }),
      field({ fieldPath: "base_salary" }),
      field({ fieldPath: "equity_grant" }),
    ]);

    const headers = screen.getAllByRole("rowheader").map((el) => el.textContent);
    expect(headers).toEqual(["Base salary", "Grant size", "Vacation days"]);
  });

  it("shows confidence only where a value was actually extracted", () => {
    renderTable([
      field({ fieldPath: "base_salary", status: "extracted", value: 1, confidence: "low" }),
      field({ fieldPath: "bonus", confidence: "high" }),
    ]);

    expect(
      within(screen.getByRole("row", { name: /base salary/i })).getByText("low"),
    ).toBeInTheDocument();
    // A confidence score attached to "not found" would imply a judgement that
    // was never made.
    expect(within(screen.getByRole("row", { name: /bonus/i })).getByText("—")).toBeInTheDocument();
  });
});
