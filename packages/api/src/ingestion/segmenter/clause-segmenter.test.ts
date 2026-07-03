import { type Block, canonicalText } from "@contractix/shared";
import { describe, expect, it } from "vitest";

import { segmentClauses, type SegmentedClause } from "./clause-segmenter.js";

/** Build blocks with auto-frozen offsets, mimicking the parser contract. */
function mkBlocks(specs: { t: string; type?: Block["type"]; page?: number }[]): {
  blocks: Block[];
  canonical: string;
} {
  const blocks: Block[] = [];
  let cursor = 0;
  for (const s of specs) {
    blocks.push({
      page: s.page ?? 1,
      bbox: null,
      type: s.type ?? "paragraph",
      text: s.t,
      charStart: cursor,
      charEnd: cursor + s.t.length,
    });
    cursor += s.t.length + 1;
  }
  return { blocks, canonical: canonicalText(blocks) };
}

/** Tiling invariant: ordered, gap = exactly the 1-char \n separator, exact slices. */
function assertTiling(clauses: SegmentedClause[], canonical: string) {
  expect(clauses.length).toBeGreaterThan(0);
  const first = clauses[0];
  expect(first?.charStart).toBe(0);
  for (let i = 0; i < clauses.length; i++) {
    const c = clauses[i];
    if (!c) continue;
    expect(canonical.slice(c.charStart, c.charEnd)).toBe(c.text);
    const next = clauses[i + 1];
    if (next) expect(next.charStart).toBe(c.charEnd + 1);
  }
  expect(clauses.at(-1)?.charEnd).toBe(canonical.length);
}

describe("segmentClauses", () => {
  it("segments a German employment offer on § numbering with front matter", () => {
    const { blocks, canonical } = mkBlocks([
      { t: "Arbeitsvertrag", type: "heading" },
      { t: "zwischen der Beispiel GmbH und Frau Erika Musterfrau" },
      { t: "§ 1 Beginn und Tätigkeit", type: "heading" },
      { t: "Das Arbeitsverhältnis beginnt am 1. Januar 2027." },
      { t: "§ 2 Probezeit", type: "heading", page: 2 },
      { t: "Die Probezeit beträgt sechs Monate.", page: 2 },
    ]);

    const clauses = segmentClauses(blocks, canonical);
    assertTiling(clauses, canonical);

    expect(clauses.map((c) => c.clausePath)).toEqual(["front-matter", "§1", "§2"]);
    expect(clauses[0]?.clauseRef).toBe("1:front-matter");
    expect(clauses[2]?.clauseRef).toBe("2:§2");
    expect(clauses[1]?.text).toContain("beginnt am 1. Januar 2027");
    expect(clauses[2]?.heading).toBe("§ 2 Probezeit");
    expect(clauses[2]?.headingPath).toEqual(["§ 2 Probezeit"]);
  });

  it("opens annex scopes and nests decimal numbering beneath them", () => {
    const { blocks, canonical } = mkBlocks([
      { t: "§ 1 Gegenstand", type: "heading" },
      { t: "Dem Mitarbeiter werden virtuelle Optionen gewährt." },
      { t: "Anlage 1 Vestingregelungen", type: "heading" },
      { t: "2. Vesting", type: "heading" },
      { t: "Die Optionen vesten über vier Jahre." },
      { t: "2.1 Cliff", type: "heading" },
      { t: "Das Cliff beträgt zwölf Monate." },
    ]);

    const clauses = segmentClauses(blocks, canonical);
    assertTiling(clauses, canonical);

    expect(clauses.map((c) => c.clausePath)).toEqual([
      "§1",
      "anlage-1",
      "anlage-1/2",
      "anlage-1/2.1",
    ]);
    expect(clauses[3]?.headingPath).toEqual([
      "Anlage 1 Vestingregelungen",
      "2. Vesting",
      "2.1 Cliff",
    ]);
  });

  it("handles inline-numbered term-sheet clauses in long paragraphs", () => {
    const { blocks, canonical } = mkBlocks([
      { t: "Series A Term Sheet", type: "heading" },
      { t: "This term sheet summarizes the principal terms." },
      {
        t: "2.1 Liquidation Preference. In the event of any liquidation, dissolution or winding up, the holders of Series A shall receive one times the original purchase price prior and in preference to any distribution.",
      },
      {
        t: "2.2 Anti-Dilution. The conversion price shall be subject to broad-based weighted average adjustment.",
      },
    ]);

    const clauses = segmentClauses(blocks, canonical);
    assertTiling(clauses, canonical);
    expect(clauses.map((c) => c.clausePath)).toEqual(["front-matter", "2.1", "2.2"]);
    expect(clauses[1]?.heading).toBe("2.1 Liquidation Preference");
  });

  it("suffixes duplicate refs deterministically", () => {
    const { blocks, canonical } = mkBlocks([
      { t: "§ 2 Probezeit", type: "heading" },
      { t: "Erster Teil." },
      { t: "§ 2 Probezeit", type: "heading" },
      { t: "Versehentlich doppelt nummeriert." },
    ]);
    const clauses = segmentClauses(blocks, canonical);
    assertTiling(clauses, canonical);
    expect(clauses.map((c) => c.clausePath)).toEqual(["§2", "§2-2"]);
  });

  it("falls back to heading blocks, then to paragraph windows", () => {
    const headings = mkBlocks([
      { t: "Welcome", type: "heading" },
      { t: "Some unnumbered introduction." },
      { t: "Confidentiality", type: "heading" },
      { t: "Both parties shall keep this confidential." },
    ]);
    const viaHeadings = segmentClauses(headings.blocks, headings.canonical);
    assertTiling(viaHeadings, headings.canonical);
    expect(viaHeadings.map((c) => c.clausePath)).toEqual(["seq-1", "seq-2"]);

    const flat = mkBlocks(
      Array.from({ length: 9 }, (_, i) => ({ t: `Absatz ${i + 1} ohne jede Nummerierung.` })),
    );
    const windows = segmentClauses(flat.blocks, flat.canonical);
    assertTiling(windows, flat.canonical);
    expect(windows.map((c) => c.clausePath)).toEqual(["seq-1", "seq-2", "seq-3"]);
  });

  it("never opens clauses on list items or table cells", () => {
    const { blocks, canonical } = mkBlocks([
      { t: "§ 5 Vergütung", type: "heading" },
      { t: "3.1 Bonusstaffel siehe Tabelle", type: "table_cell" },
      { t: "2. Rate im Dezember", type: "list_item" },
    ]);
    const clauses = segmentClauses(blocks, canonical);
    assertTiling(clauses, canonical);
    expect(clauses.map((c) => c.clausePath)).toEqual(["§5"]);
  });
});
