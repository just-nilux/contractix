import mammoth from "mammoth";
import { parse as parseHtml, type HTMLElement, NodeType } from "node-html-parser";

import { type Block, type BlockType, type ParsedDocument } from "@contractix/shared";

import { normalizeText } from "./normalize.js";
import { DOCX_MIME, type Parser } from "./types.js";

const TAG_TYPES: Record<string, BlockType> = {
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  p: "paragraph",
  li: "list_item",
  td: "table_cell",
  th: "table_cell",
};

/**
 * DOCX path (ADR-0003): mammoth maps Word styles to semantic HTML, which we
 * flatten into canonical blocks. DOCX has no intrinsic pagination or geometry,
 * so page = 1 and bbox = null for every block - refs stay honest, and the
 * Phase-3 UI highlights DOCX as HTML spans instead of PDF page rects.
 *
 * Known limitation (accepted for v1): Word auto-numbering lives in
 * numbering.xml and is invisible to mammoth. Documents relying on it degrade
 * to fallback segmentation; the authored corpus uses literal numbering text.
 */
export class MammothDocxParser implements Parser {
  readonly id = "mammoth";

  supports(mimeType: string): boolean {
    return mimeType === DOCX_MIME;
  }

  async parse(bytes: Uint8Array): Promise<ParsedDocument> {
    const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });

    const texts: { type: BlockType; text: string }[] = [];
    const visit = (el: HTMLElement): void => {
      for (const child of el.childNodes) {
        if (child.nodeType !== NodeType.ELEMENT_NODE) continue;
        const elem = child as HTMLElement;
        const mapped = TAG_TYPES[elem.rawTagName?.toLowerCase() ?? ""];
        if (mapped && !["ul", "ol", "table", "tr"].includes(elem.rawTagName)) {
          const text = normalizeText(elem.structuredText);
          if (text.length > 0) texts.push({ type: mapped, text });
        } else {
          visit(elem); // containers: ul/ol/table/tr and anything unknown
        }
      }
    };
    visit(parseHtml(html));

    if (texts.length === 0) {
      throw new Error("docx contained no extractable text");
    }

    const blocks: Block[] = [];
    let cursor = 0;
    for (const t of texts) {
      blocks.push({
        page: 1,
        bbox: null,
        type: t.type,
        text: t.text,
        charStart: cursor,
        charEnd: cursor + t.text.length,
      });
      cursor += t.text.length + 1;
    }

    const chars = blocks.reduce((n, b) => n + b.text.length, 0);
    return {
      blocks,
      pageCount: 1,
      report: {
        parser: this.id,
        coverage: 1,
        pages: [{ page: 1, status: "ok", chars }],
      },
    };
  }
}
