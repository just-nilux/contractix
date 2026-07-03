import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalText } from "@contractix/shared";

import { countTokens } from "./chunker/tokens.js";
import { detectDocumentLanguage } from "./language.js";
import { DOCX_MIME, parserFor, PDF_MIME } from "./parser/index.js";
import { segmentClauses } from "./segmenter/clause-segmenter.js";

const CORPUS = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../..", // packages/api/src/ingestion -> repo root
  "corpus",
);

async function parseAndSegment(file: string, mime: string) {
  const bytes = await fs.readFile(path.join(CORPUS, "dist", file));
  const parser = parserFor(mime);
  if (!parser) throw new Error(`no parser for ${mime}`);
  const parsed = await parser.parse(new Uint8Array(bytes));
  const canonical = canonicalText(parsed.blocks);
  return { parsed, canonical, clauses: segmentClauses(parsed.blocks, canonical) };
}

/**
 * Round-trip contract: the corpus and the segmenter co-evolve under this
 * test. If an edit to templates or patterns changes the clause map, this
 * fails before the eval's gold refs silently dangle.
 */
describe("corpus round-trip (generate -> parse -> segment)", () => {
  it("manifest matches the committed dist artifacts (drift detection)", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(CORPUS, "manifest.json"), "utf8")) as {
      documents: { file: string; sha256: string; language: string; type: string }[];
    };
    expect(manifest.documents).toHaveLength(5);
    for (const doc of manifest.documents) {
      const bytes = await fs.readFile(path.join(CORPUS, "dist", doc.file));
      expect(createHash("sha256").update(bytes).digest("hex"), doc.file).toBe(doc.sha256);
    }
  });

  it("offer_de_senior_eng.pdf segments on § numbering", async () => {
    const { parsed, canonical, clauses } = await parseAndSegment(
      "offer_de_senior_eng.pdf",
      PDF_MIME,
    );
    expect(parsed.report.coverage).toBe(1);
    expect(detectDocumentLanguage(canonical)).toBe("de");

    const paths = clauses.map((c) => c.clausePath);
    for (let i = 1; i <= 13; i++) expect(paths).toContain(`§${i}`);

    const probezeit = clauses.find((c) => c.clausePath === "§2");
    expect(probezeit?.text).toContain("sechs Monate");
    const karenz = clauses.find((c) => c.clausePath === "§11");
    expect(karenz?.text).toContain("Karenzentschädigung");

    for (const c of clauses) {
      expect(canonical.slice(c.charStart, c.charEnd)).toBe(c.text);
    }
  });

  it("offer_en_startup.pdf segments on decimal numbering", async () => {
    const { clauses } = await parseAndSegment("offer_en_startup.pdf", PDF_MIME);
    const paths = clauses.map((c) => c.clausePath);
    for (let i = 1; i <= 11; i++) expect(paths).toContain(String(i));
    const ip = clauses.find((c) => c.clausePath === "8");
    expect(ip?.text).toContain("No carve-out");
  });

  it("vsop_de.pdf nests annex numbering and carries an oversized clause", async () => {
    const { parsed, clauses } = await parseAndSegment("vsop_de.pdf", PDF_MIME);
    expect(parsed.pageCount).toBeGreaterThanOrEqual(3);

    const paths = clauses.map((c) => c.clausePath);
    expect(paths).toContain("praeambel");
    for (let i = 1; i <= 8; i++) expect(paths).toContain(`§${i}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        "anlage-1",
        "anlage-1/1",
        "anlage-1/2",
        "anlage-1/2.1",
        "anlage-1/2.2",
        "anlage-1/3",
      ]),
    );

    const annexClause = clauses.find((c) => c.clausePath === "anlage-1/2.1");
    expect(annexClause?.headingPath[0]).toContain("Anlage 1");

    // §7 is authored past the 1,200-token budget to exercise the splitter.
    const big = clauses.find((c) => c.clausePath === "§7");
    expect(big).toBeDefined();
    expect(countTokens(big?.text ?? "")).toBeGreaterThan(1_200);
  });

  it("term_sheet_en.pdf segments articles and sections", async () => {
    const { clauses } = await parseAndSegment("term_sheet_en.pdf", PDF_MIME);
    const paths = clauses.map((c) => c.clausePath);
    expect(paths).toEqual(
      expect.arrayContaining(["art-i", "sec-1.3", "art-ii", "sec-2.1", "art-v", "sec-5.3"]),
    );
    const liqPref = clauses.find((c) => c.clausePath === "sec-2.1");
    expect(liqPref?.text).toContain("1.5 times");
    expect(liqPref?.headingPath).toContain("Article II Economic Rights");
  });

  it("arbeitsvertrag_de.docx segments on literal Ziffer numbering", async () => {
    const { clauses } = await parseAndSegment("arbeitsvertrag_de.docx", DOCX_MIME);
    const paths = clauses.map((c) => c.clausePath);
    for (let i = 1; i <= 8; i++) expect(paths).toContain(`ziffer-${i}`);
    expect(clauses.every((c) => c.page === 1)).toBe(true);
    const befristung = clauses.find((c) => c.clausePath === "ziffer-1");
    expect(befristung?.text).toContain("befristet");
  });
});
