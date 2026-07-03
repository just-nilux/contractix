/**
 * Regenerates corpus/dist from corpus/templates.
 *
 * dist/ artifacts are COMMITTED and are the source of truth for tests, eval,
 * and demo seeding: PDF bytes are not stable across Chromium versions, and
 * committing them keeps Playwright out of every CI job. Run this only to
 * *edit* the corpus, then commit the regenerated dist/ + manifest.json.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { Document, HeadingLevel, Packer, Paragraph } from "docx";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "..");
const TEMPLATES = path.join(ROOT, "corpus", "templates");
const DIST = path.join(ROOT, "corpus", "dist");

interface CorpusDoc {
  file: string;
  language: "de" | "en";
  /** documents.type backfill for demo seeding (classifier lands in Phase 2) */
  type: string;
  footer: string;
}

const PDF_DOCS: CorpusDoc[] = [
  {
    file: "offer_de_senior_eng",
    language: "de",
    type: "employment_offer",
    footer: "Seite",
  },
  { file: "offer_en_startup", language: "en", type: "employment_offer", footer: "Page" },
  { file: "vsop_de", language: "de", type: "vsop_esop_agreement", footer: "Seite" },
  { file: "term_sheet_en", language: "en", type: "term_sheet", footer: "Page" },
];

function footerTemplate(label: string): string {
  return (
    `<div style="width:100%;text-align:center;font-size:8px;color:#555;">` +
    `${label} <span class="pageNumber"></span> / <span class="totalPages"></span></div>`
  );
}

/**
 * The DOCX corpus document uses LITERAL "Ziffer N" heading text (no Word
 * auto-numbering): numbering.xml is invisible to mammoth (ADR-0003), and
 * literal numbering is common in German legal templates anyway.
 */
function ziffer(n: number, title: string): Paragraph {
  return new Paragraph({ text: `Ziffer ${n} ${title}`, heading: HeadingLevel.HEADING_2 });
}

function para(text: string): Paragraph {
  return new Paragraph({ text });
}

async function buildArbeitsvertrag(): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: "Arbeitsvertrag", heading: HeadingLevel.HEADING_1 }),
          para(
            "zwischen der Beispiel Logistik GmbH, Hafenstraße 4, 20457 Hamburg, und Herrn Max Mustermann, Elbchaussee 210, 22605 Hamburg. Synthetisches Demonstrationsdokument ohne reale Personen.",
          ),
          ziffer(1, "Vertragsgegenstand und Beginn"),
          para(
            "Herr Mustermann wird ab dem 1. November 2026 als Speditionskaufmann eingestellt. Das Arbeitsverhältnis ist auf 24 Monate befristet; die Befristung erfolgt ohne Sachgrund gemäß § 14 Absatz 2 TzBfG.",
          ),
          ziffer(2, "Arbeitszeit und Vergütung"),
          para(
            "Die regelmäßige wöchentliche Arbeitszeit beträgt 40 Stunden. Die monatliche Bruttovergütung beträgt 4.200 Euro. Überstunden werden mit einem Zuschlag von 25 Prozent vergütet oder in Freizeit ausgeglichen.",
          ),
          ziffer(3, "Probezeit"),
          para(
            "Die ersten drei Monate gelten als Probezeit. Während der Probezeit kann das Arbeitsverhältnis beiderseits mit einer Frist von zwei Wochen gekündigt werden.",
          ),
          ziffer(4, "Urlaub"),
          para(
            "Der Urlaubsanspruch beträgt 24 Arbeitstage im Kalenderjahr. Urlaub ist rechtzeitig mit der Disposition abzustimmen.",
          ),
          ziffer(5, "Verschwiegenheit"),
          para(
            "Über Geschäfts- und Betriebsgeheimnisse sowie Kundendaten ist auch nach dem Ausscheiden Stillschweigen zu bewahren.",
          ),
          ziffer(6, "Kündigung"),
          para(
            "Nach der Probezeit gilt beiderseits eine Kündigungsfrist von vier Wochen zum Fünfzehnten oder zum Ende eines Kalendermonats. Die ordentliche Kündigung während der Befristung ist zulässig. Jede Kündigung bedarf der Schriftform.",
          ),
          ziffer(7, "Nebentätigkeit"),
          para(
            "Nebentätigkeiten sind der Gesellschaft vor Aufnahme schriftlich anzuzeigen und dürfen betriebliche Interessen nicht beeinträchtigen.",
          ),
          ziffer(8, "Schlussbestimmungen"),
          para(
            "Änderungen und Ergänzungen bedürfen der Schriftform. Es gilt deutsches Recht. Sollten einzelne Bestimmungen unwirksam sein, bleibt der Vertrag im Übrigen unberührt.",
          ),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}

async function main(): Promise<void> {
  await fs.mkdir(DIST, { recursive: true });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const doc of PDF_DOCS) {
      const src = path.join(TEMPLATES, `${doc.file}.html`);
      await page.goto(`file://${src}`, { waitUntil: "networkidle" });
      await page.pdf({
        path: path.join(DIST, `${doc.file}.pdf`),
        format: "A4",
        margin: { top: "24mm", bottom: "20mm", left: "22mm", right: "20mm" },
        displayHeaderFooter: true,
        headerTemplate: "<span></span>",
        footerTemplate: footerTemplate(doc.footer),
        printBackground: false,
      });
      console.log(`rendered ${doc.file}.pdf`);
    }
  } finally {
    await browser.close();
  }

  await fs.writeFile(path.join(DIST, "arbeitsvertrag_de.docx"), await buildArbeitsvertrag());
  console.log("rendered arbeitsvertrag_de.docx");

  const documents = [
    ...PDF_DOCS.map((d) => ({
      file: `${d.file}.pdf`,
      language: d.language,
      type: d.type,
    })),
    { file: "arbeitsvertrag_de.docx", language: "de" as const, type: "employment_contract" },
  ];

  const manifest = {
    note: "All documents are synthetic, authored for this repository. No real person, company, or agreement is represented.",
    documents: await Promise.all(
      documents.map(async (d) => ({ ...d, sha256: await sha256(path.join(DIST, d.file)) })),
    ),
  };
  await fs.writeFile(
    path.join(ROOT, "corpus", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(`manifest written (${manifest.documents.length} documents)`);
}

await main();
