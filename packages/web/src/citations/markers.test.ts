import { describe, expect, it } from "vitest";

import { hasMarkers, splitMarkers } from "./markers.js";

const CLAUSE = "018f4b3e-7c2a-7000-8000-000000000001:2:§11";

describe("splitMarkers", () => {
  it("splits prose around a clause marker and links it to its citation", () => {
    const parts = splitMarkers(`The non-compete pays nothing [[${CLAUSE}]].`, [CLAUSE]);

    expect(parts).toEqual([
      { type: "text", value: "The non-compete pays nothing " },
      { type: "marker", kind: "clause", value: CLAUSE, citationIndex: 0 },
      { type: "text", value: "." },
    ]);
  });

  it("keeps the three non-document marker kinds distinct", () => {
    // These are the model saying "this is not from your documents". Collapsing
    // them into ordinary citations would erase the distinction it was asked to
    // draw (ADR-0010).
    const parts = splitMarkers(
      "Statute says X [[statute:§74 Abs. 2 HGB]]. Market norm is Y [[context:seed rounds]]. I am unsure [[caveat]].",
      [],
    );
    const markers = parts.filter((p) => p.type === "marker");

    expect(markers).toEqual([
      { type: "marker", kind: "statute", value: "§74 Abs. 2 HGB", citationIndex: null },
      { type: "marker", kind: "context", value: "seed rounds", citationIndex: null },
      { type: "marker", kind: "caveat", value: "", citationIndex: null },
    ]);
  });

  it("reports a clause marker with no matching citation rather than dropping it", () => {
    const parts = splitMarkers(`Claim [[${CLAUSE}]].`, []);

    // A marker the validator let through but the citations do not cover is a
    // bug worth seeing, not one to hide.
    expect(parts[1]).toMatchObject({ kind: "clause", citationIndex: null });
  });

  it("handles several markers on one sentence", () => {
    const other = "018f4b3e-7c2a-7000-8000-000000000001:1:§3";
    const parts = splitMarkers(`Both [[${CLAUSE}]] [[${other}]] apply.`, [other, CLAUSE]);
    const markers = parts.filter((p) => p.type === "marker");

    expect(markers.map((m) => m.citationIndex)).toEqual([1, 0]);
  });

  it("returns plain text unchanged", () => {
    expect(splitMarkers("No markers here.", [])).toEqual([
      { type: "text", value: "No markers here." },
    ]);
  });

  it("handles a marker at the very start and very end", () => {
    const parts = splitMarkers(`[[caveat]] middle [[caveat]]`, []);
    expect(parts.map((p) => p.type)).toEqual(["marker", "text", "marker"]);
  });
});

describe("hasMarkers", () => {
  it.each([
    [`Text [[${CLAUSE}]]`, true],
    ["[[caveat]]", true],
    ["Plain text", false],
    ["Brackets [not a marker]", false],
  ])("%s -> %s", (text, expected) => {
    expect(hasMarkers(text)).toBe(expected);
  });
});
