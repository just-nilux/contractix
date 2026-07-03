import { canonicalText } from "@contractix/shared";
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } from "docx";
import { describe, expect, it } from "vitest";

import { MammothDocxParser } from "./docx-parser.js";

const parser = new MammothDocxParser();

async function fixtureDocx(): Promise<Uint8Array> {
  const doc = new Document({
    numbering: {
      config: [],
    },
    sections: [
      {
        children: [
          new Paragraph({ text: "Arbeitsvertrag", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: "Ziffer 1 Vertragsgegenstand", heading: HeadingLevel.HEADING_2 }),
          new Paragraph({
            text: "Der Arbeitnehmer wird als Senior Software Engineer eingestellt.",
          }),
          new Paragraph({ text: "Ziffer 2 Verguetung", heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ text: "Die monatliche Verguetung betraegt 8.000 Euro brutto." }),
          new Paragraph({ text: "Firmenwagen", bullet: { level: 0 } }),
          new Table({
            rows: [
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph("Urlaubstage")] }),
                  new TableCell({ children: [new Paragraph("30")] }),
                ],
              }),
            ],
          }),
        ],
      },
    ],
  });
  const buffer = await Packer.toBuffer(doc);
  return new Uint8Array(buffer);
}

describe("MammothDocxParser", () => {
  it("supports only docx", () => {
    expect(
      parser.supports("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ).toBe(true);
    expect(parser.supports("application/pdf")).toBe(false);
  });

  it("maps word styles to typed blocks with frozen offsets", async () => {
    const parsed = await parser.parse(await fixtureDocx());

    expect(parsed.pageCount).toBe(1);
    expect(parsed.report.coverage).toBe(1);

    const byText = new Map(parsed.blocks.map((b) => [b.text, b]));
    expect(byText.get("Arbeitsvertrag")?.type).toBe("heading");
    expect(byText.get("Ziffer 1 Vertragsgegenstand")?.type).toBe("heading");
    expect(byText.get("Firmenwagen")?.type).toBe("list_item");
    expect(byText.get("Urlaubstage")?.type).toBe("table_cell");
    expect(byText.get("30")?.type).toBe("table_cell");

    // DOCX convention: no geometry, single logical page.
    expect(parsed.blocks.every((b) => b.bbox === null && b.page === 1)).toBe(true);

    // Slice-identity invariant.
    const canonical = canonicalText(parsed.blocks);
    for (const block of parsed.blocks) {
      expect(canonical.slice(block.charStart, block.charEnd)).toBe(block.text);
    }
  });

  it("rejects non-docx bytes", async () => {
    await expect(parser.parse(new TextEncoder().encode("nope"))).rejects.toThrow();
  });
});
