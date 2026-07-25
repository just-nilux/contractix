import { serializeClauseId } from "@contractix/shared";
import { describe, expect, it } from "vitest";

import { type ClauseForCitation, resolveFieldCitations } from "./citation-resolver.js";

const DOC_ID = "0197a3b2-1c4d-7e5f-8a9b-0c1d2e3f4a5b";
const OTHER_DOC = "0197a3b2-1c4d-7e5f-8a9b-0c1d2e3f4aaa";

const TEXT = "Das Wettbewerbsverbot beträgt 12 Monate. Karenzentschädigung 30%.";
const clause: ClauseForCitation = {
  id: "row-1",
  clauseRef: "2:§11",
  charStart: 100,
  charEnd: 100 + TEXT.length,
  text: TEXT,
};
const byRef = new Map([[clause.clauseRef, clause]]);
const cid = serializeClauseId(DOC_ID, clause.clauseRef);

describe("resolveFieldCitations", () => {
  it("resolves an anchor to an absolute span that slices back to the anchor", () => {
    const anchor = "Karenzentschädigung 30%";
    const { citations, unresolved } = resolveFieldCitations(
      { citations: [cid], verbatim_anchor: anchor },
      byRef,
      DOC_ID,
    );
    expect(unresolved).toEqual([]);
    expect(citations).toHaveLength(1);
    const c = citations[0]!;
    expect(c.clauseId).toBe("row-1");
    // ADR-0005 slice-identity, relative to the clause's frozen text.
    expect(clause.text.slice(c.charStart - clause.charStart, c.charEnd - clause.charStart)).toBe(
      anchor,
    );
  });

  it("cites the whole clause span when the anchor is empty", () => {
    const { citations } = resolveFieldCitations(
      { citations: [cid], verbatim_anchor: "" },
      byRef,
      DOC_ID,
    );
    expect(citations[0]).toMatchObject({ charStart: clause.charStart, charEnd: clause.charEnd });
  });

  it("marks an anchor absent from the cited clause as unresolved", () => {
    const { citations, unresolved } = resolveFieldCitations(
      { citations: [cid], verbatim_anchor: "not in the clause" },
      byRef,
      DOC_ID,
    );
    expect(citations).toEqual([]);
    expect(unresolved).toEqual([cid]);
  });

  it("rejects citations to another document or an unknown clause", () => {
    const foreign = serializeClauseId(OTHER_DOC, "2:§11");
    const unknown = serializeClauseId(DOC_ID, "9:§99");
    const { citations, unresolved } = resolveFieldCitations(
      { citations: [foreign, unknown], verbatim_anchor: "" },
      byRef,
      DOC_ID,
    );
    expect(citations).toEqual([]);
    expect(unresolved).toEqual([foreign, unknown]);
  });

  it("resolves via the anchor even when the model's clause id is malformed (ADR-0007)", () => {
    // A small model returns the right verbatim_anchor but citation ids it never
    // reproduced exactly — anchor-first resolution still grounds the value.
    const anchor = "12 Monate";
    const { citations, unresolved } = resolveFieldCitations(
      { citations: ["§11", "not-a-clause-id"], verbatim_anchor: anchor },
      byRef,
      DOC_ID,
    );
    expect(unresolved).toEqual([]);
    expect(citations).toHaveLength(1);
    const c = citations[0]!;
    expect(c.clauseId).toBe("row-1");
    expect(clause.text.slice(c.charStart - clause.charStart, c.charEnd - clause.charStart)).toBe(
      anchor,
    );
  });

  it("does not guess when an anchor is ambiguous across clauses without a hint", () => {
    const cA: ClauseForCitation = {
      id: "a",
      clauseRef: "1:§1",
      charStart: 0,
      charEnd: 24,
      text: "Vesting 48 months total.",
    };
    const cB: ClauseForCitation = {
      id: "b",
      clauseRef: "1:§2",
      charStart: 100,
      charEnd: 120,
      text: "Cliff 48 months min.",
    };
    const twoClauses = new Map([
      [cA.clauseRef, cA],
      [cB.clauseRef, cB],
    ]);

    // Ambiguous anchor, no usable hint -> unresolved (never fuzzy-guess, ADR-0005).
    const ambiguous = resolveFieldCitations(
      { citations: [], verbatim_anchor: "48 months" },
      twoClauses,
      DOC_ID,
    );
    expect(ambiguous.citations).toEqual([]);

    // Same anchor, but the model hints the second clause -> resolves there.
    const hinted = resolveFieldCitations(
      { citations: [serializeClauseId(DOC_ID, cB.clauseRef)], verbatim_anchor: "48 months" },
      twoClauses,
      DOC_ID,
    );
    expect(hinted.citations).toHaveLength(1);
    expect(hinted.citations[0]!.clauseId).toBe("b");
  });
});

describe("resolveFieldCitations — whitespace/typography invariance (ADR-0009)", () => {
  const START = 200;
  function clauseWith(text: string): Map<string, ClauseForCitation> {
    const clause: ClauseForCitation = {
      id: "c1",
      clauseRef: "1:§1",
      charStart: START,
      charEnd: START + text.length,
      text,
    };
    return new Map([[clause.clauseRef, clause]]);
  }

  it("matches across a line break the model echoed as a space, keeping exact offsets", () => {
    const text = "Homeoffice ist an bis zu drei Tagen pro Woche\nnach Abstimmung erlaubt.";
    const byRef = clauseWith(text);
    const { citations, unresolved } = resolveFieldCitations(
      { citations: [], verbatim_anchor: "drei Tagen pro Woche nach Abstimmung" },
      byRef,
      DOC_ID,
    );
    expect(unresolved).toEqual([]);
    expect(citations).toHaveLength(1);
    const c = citations[0]!;
    // The stored span is the ORIGINAL frozen text — it keeps the newline (ADR-0005),
    // not the model's re-spaced anchor.
    const slice = text.slice(c.charStart - START, c.charEnd - START);
    expect(slice).toBe("drei Tagen pro Woche\nnach Abstimmung");
    expect(c.verbatimAnchor).toBe(slice);
  });

  it("folds NBSP, doubled spaces, German quotes and en-dashes", () => {
    // clause: NBSP, „…" German quotes, en-dash, and a double space
    const byRef = clauseWith("Ein „Exit–Ereignis“ ist  die Veräußerung.");
    const { citations, unresolved } = resolveFieldCitations(
      { citations: [], verbatim_anchor: 'Ein "Exit-Ereignis" ist die Veräußerung.' },
      byRef,
      DOC_ID,
    );
    expect(unresolved).toEqual([]);
    expect(citations).toHaveLength(1);
  });

  it("still refuses to guess an ambiguous anchor after normalization", () => {
    const cA: ClauseForCitation = {
      id: "a",
      clauseRef: "1:§1",
      charStart: 0,
      charEnd: 31,
      text: "Vesting über  48 Monate gesamt.",
    };
    const cB: ClauseForCitation = {
      id: "b",
      clauseRef: "1:§2",
      charStart: 100,
      charEnd: 125,
      text: "Cliff:\n48 Monate minimum.",
    };
    const byRef = new Map([
      [cA.clauseRef, cA],
      [cB.clauseRef, cB],
    ]);
    // Both clauses contain "48 Monate" once normalized; with no hint -> unresolved.
    const { citations } = resolveFieldCitations(
      { citations: [], verbatim_anchor: "48 Monate" },
      byRef,
      DOC_ID,
    );
    expect(citations).toEqual([]);
  });
});
