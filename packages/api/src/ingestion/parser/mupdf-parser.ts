import * as mupdf from "mupdf";

import { type BBox, type Block, type PageReport, type ParsedDocument } from "@contractix/shared";

import { joinLinesWithDehyphenation, normalizeText } from "./normalize.js";
import { PDF_MIME, type Parser } from "./types.js";

// Shape of mupdf's StructuredText.asJSON() (probed against mupdf 1.28).
interface StLine {
  bbox: { x: number; y: number; w: number; h: number };
  font?: { size?: number; weight?: string };
  text?: string;
}
interface StBlock {
  type: string;
  bbox: { x: number; y: number; w: number; h: number };
  lines?: StLine[];
}

interface RawBlock {
  page: number;
  bbox: BBox;
  lines: StLine[];
  text: string;
  maxFontSize: number;
  bottomRatio: number; // block bottom relative to page height (structured text is top-down)
}

const FOOTER_ZONE = 0.92;
const FOOTER_MAX_CHARS = 120;
const HEADING_SIZE_FACTOR = 1.15;
const HEADING_MAX_CHARS = 200;

/** Weighted mode: the font size carrying the most characters is the body size. */
function bodyFontSize(blocks: readonly RawBlock[]): number {
  const weight = new Map<number, number>();
  for (const b of blocks) {
    for (const line of b.lines) {
      const size = line.font?.size ?? 0;
      if (size > 0) weight.set(size, (weight.get(size) ?? 0) + (line.text?.length ?? 0));
    }
  }
  let best = 11;
  let bestWeight = -1;
  for (const [size, w] of weight) {
    if (w > bestWeight) {
      best = size;
      bestWeight = w;
    }
  }
  return best;
}

function isListItem(text: string): boolean {
  return /^([-–•·]|\((?:[a-z]|[ivx]+)\)|[a-z]\))\s/.test(text);
}

export class MupdfParser implements Parser {
  readonly id = "mupdf";

  supports(mimeType: string): boolean {
    return mimeType === PDF_MIME;
  }

  parse(bytes: Uint8Array): Promise<ParsedDocument> {
    // mupdf throws synchronously on unopenable bytes; keep the Promise contract.
    try {
      return Promise.resolve(this.parseSync(bytes));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private parseSync(bytes: Uint8Array): ParsedDocument {
    const doc = mupdf.Document.openDocument(bytes, PDF_MIME);
    try {
      const pageCount = doc.countPages();
      if (pageCount === 0) throw new Error("pdf has no pages");

      const raw: RawBlock[] = [];
      const pages: PageReport[] = [];

      for (let i = 0; i < pageCount; i++) {
        const pageNo = i + 1;
        try {
          const page = doc.loadPage(i);
          const [x0, y0, x1, y1] = page.getBounds();
          const pageWidth = x1 - x0;
          const pageHeight = y1 - y0;
          const st = JSON.parse(page.toStructuredText("preserve-whitespace").asJSON()) as {
            blocks?: StBlock[];
          };

          let chars = 0;
          for (const block of st.blocks ?? []) {
            if (block.type !== "text" || !block.lines?.length) continue;
            const text = joinLinesWithDehyphenation(
              block.lines.map((l) => normalizeText(l.text ?? "")),
            );
            if (text.length === 0) continue;
            chars += text.length;
            raw.push({
              page: pageNo,
              // Relative to the page box origin, not the PDF user space origin.
              // Identical for a CropBox at (0,0) - which is every document in
              // the corpus - and correct for one that is not, where the viewer
              // renders from the page box and would otherwise be offset.
              bbox: {
                x: block.bbox.x - x0,
                y: block.bbox.y - y0,
                width: block.bbox.w,
                height: block.bbox.h,
              },
              lines: block.lines,
              text,
              maxFontSize: Math.max(...block.lines.map((l) => l.font?.size ?? 0)),
              // Also page-box relative, so footer detection and the bbox agree.
              bottomRatio: pageHeight > 0 ? (block.bbox.y - y0 + block.bbox.h) / pageHeight : 0,
            });
          }
          pages.push({
            page: pageNo,
            status: chars > 0 ? "ok" : "empty",
            chars,
            width: pageWidth,
            height: pageHeight,
          });
        } catch (err) {
          pages.push({
            page: pageNo,
            status: "error",
            chars: 0,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const bodySize = bodyFontSize(raw);
      const blocks: Block[] = [];
      let cursor = 0;

      for (const rb of raw) {
        // Footers (page numbers, running heads at the bottom zone) are dropped
        // BEFORE offsets are frozen: they would otherwise pollute clause text
        // and retrieval. The Block type keeps "footer" for parsers that retain them.
        if (rb.bottomRatio > FOOTER_ZONE && rb.text.length <= FOOTER_MAX_CHARS) continue;

        const isHeading =
          rb.maxFontSize >= bodySize * HEADING_SIZE_FACTOR &&
          rb.text.length <= HEADING_MAX_CHARS &&
          rb.lines.length <= 2;

        const type = isHeading ? "heading" : isListItem(rb.text) ? "list_item" : "paragraph";

        blocks.push({
          page: rb.page,
          bbox: rb.bbox,
          type,
          text: rb.text,
          charStart: cursor,
          charEnd: cursor + rb.text.length,
        });
        cursor += rb.text.length + 1; // the "\n" of canonicalText()
      }

      const okPages = pages.filter((p) => p.status === "ok").length;
      return {
        blocks,
        pageCount,
        report: {
          parser: this.id,
          coverage: pageCount > 0 ? okPages / pageCount : 0,
          pages,
        },
      };
    } finally {
      doc.destroy();
    }
  }
}
