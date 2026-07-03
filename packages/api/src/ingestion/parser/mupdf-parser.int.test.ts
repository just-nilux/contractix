import { canonicalText } from "@contractix/shared";
import { describe, expect, it } from "vitest";

import { buildPdf } from "./__fixtures__/pdf.js";
import { MupdfParser } from "./mupdf-parser.js";

const parser = new MupdfParser();

describe("MupdfParser", () => {
  it("supports only pdf", () => {
    expect(parser.supports("application/pdf")).toBe(true);
    expect(parser.supports("text/plain")).toBe(false);
  });

  it("emits typed blocks with frozen offsets across pages", async () => {
    const pdf = buildPdf([
      [
        { text: "Arbeitsvertrag", size: 18 },
        { text: "1 Beginn des Arbeitsverhaeltnisses", size: 14 },
        { text: "Das Arbeitsverhaeltnis beginnt am 1. Januar 2027.", size: 11 },
        { text: "Seite 1 von 2", size: 8, y: 24 },
      ],
      [
        { text: "2 Probezeit", size: 14 },
        { text: "Die Probezeit betraegt sechs Monate.", size: 11 },
        { text: "Seite 2 von 2", size: 8, y: 24 },
      ],
    ]);

    const parsed = await parser.parse(pdf);

    expect(parsed.pageCount).toBe(2);
    expect(parsed.report.coverage).toBe(1);
    expect(parsed.report.pages).toEqual([
      { page: 1, status: "ok", chars: expect.any(Number) as number },
      { page: 2, status: "ok", chars: expect.any(Number) as number },
    ]);

    // Footers are excluded before offsets freeze.
    expect(parsed.blocks.some((b) => b.text.includes("Seite"))).toBe(false);

    // Heading detection by font-size delta.
    const headings = parsed.blocks.filter((b) => b.type === "heading").map((b) => b.text);
    expect(headings).toContain("Arbeitsvertrag");
    expect(headings).toContain("1 Beginn des Arbeitsverhaeltnisses");
    expect(headings).toContain("2 Probezeit");

    // Page attribution survives.
    const probezeit = parsed.blocks.find((b) => b.text.startsWith("Die Probezeit"));
    expect(probezeit?.page).toBe(2);
    expect(probezeit?.type).toBe("paragraph");

    // THE invariant (ADR-0005): every block is an exact slice of canonical text.
    const canonical = canonicalText(parsed.blocks);
    for (const block of parsed.blocks) {
      expect(canonical.slice(block.charStart, block.charEnd)).toBe(block.text);
    }
    expect(parsed.blocks.every((b) => b.bbox !== null)).toBe(true);
  });

  it("rejects unparseable bytes", async () => {
    await expect(parser.parse(new TextEncoder().encode("not a pdf at all"))).rejects.toThrow();
  });
});
