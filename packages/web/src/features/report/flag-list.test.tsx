import { type ReportFlag } from "@contractix/shared/schemas";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CitationProvider } from "../../citations/citation-context.js";
import { FlagList } from "./flag-list.js";

function flag(overrides: Partial<ReportFlag> & { ruleId: string }): ReportFlag {
  return {
    ruleVersion: "1",
    severity: "info",
    rationale: "Because.",
    negotiationHint: null,
    sources: [],
    citations: [],
    ...overrides,
  };
}

function renderFlags(flags: ReportFlag[], emptyNote?: string) {
  return render(
    <CitationProvider>
      <FlagList
        flags={flags}
        documentId="doc-1"
        {...(emptyNote === undefined ? {} : { emptyNote })}
      />
    </CitationProvider>,
  );
}

describe("FlagList", () => {
  it("preserves the order the rules engine returned", () => {
    // composeDocumentReport already sorts red → amber → info. Re-sorting here
    // would be a second opinion on severity this component has no basis for.
    renderFlags([
      flag({ ruleId: "A", severity: "red" }),
      flag({ ruleId: "B", severity: "amber" }),
      flag({ ruleId: "C", severity: "info" }),
    ]);

    const ids = screen.getAllByText(/^[ABC]@1$/).map((el) => el.textContent);
    expect(ids).toEqual(["A@1", "B@1", "C@1"]);
  });

  it("shows the rule id and version, so a finding can be traced to its rule", () => {
    renderFlags([flag({ ruleId: "DE-NONCOMP-KARENZ", ruleVersion: "1", severity: "red" })]);

    expect(screen.getByText("DE-NONCOMP-KARENZ@1")).toBeInTheDocument();
  });

  it("frames sources as references rather than determinations", () => {
    renderFlags([flag({ ruleId: "X", sources: ["§74 HGB"] })]);

    expect(screen.getByText(/Statutory reference: §74 HGB/)).toBeInTheDocument();
  });

  it("omits the ask when a rule has no negotiation hint", () => {
    renderFlags([flag({ ruleId: "X", negotiationHint: null })]);

    expect(screen.queryByText(/Ask for:/)).not.toBeInTheDocument();
  });

  it("explains an empty list when the document type has no extraction schema", () => {
    // The primary keyless experience, and the honest answer for an unclassified
    // document: no rules fired *because there was nothing for them to check*.
    renderFlags([], "The rules engine checks extracted terms.");

    expect(screen.getByText(/No rules fired for this document/)).toBeInTheDocument();
    expect(screen.getByText("The rules engine checks extracted terms.")).toBeInTheDocument();
  });
});
