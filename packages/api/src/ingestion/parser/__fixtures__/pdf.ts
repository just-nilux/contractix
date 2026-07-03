/**
 * Deterministic minimal-PDF builder for parser tests (ASCII text only - the
 * corpus generator produces real documents; this exists so unit-level parser
 * tests need no committed binaries). Emits a structurally valid PDF with a
 * correct xref table so mupdf does not need repair mode.
 */

export interface FixtureLine {
  text: string;
  /** font size in points; parser heading heuristics key off this */
  size: number;
  /** explicit baseline y in PDF user space (origin bottom-left); default: auto-descend from 720 */
  y?: number;
}

function escapePdfString(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

export function buildPdf(pages: FixtureLine[][]): Uint8Array {
  const objects: string[] = [];
  const pageObjIds: number[] = [];

  // object ids: 1 catalog, 2 pages root, 3 font, then (page, content) pairs
  const fontId = 3;
  let nextId = 4;

  const pageEntries: { pageId: number; contentId: number; content: string }[] = [];
  for (const lines of pages) {
    const pageId = nextId++;
    const contentId = nextId++;
    pageObjIds.push(pageId);

    let autoY = 720;
    let prevSize: number | null = null;
    const ops: string[] = [];
    for (const line of lines) {
      // Real layouts give headings vertical breathing room; without it,
      // mupdf's block detection (correctly) merges adjacent lines into one
      // paragraph block.
      if (line.y === undefined && prevSize !== null && prevSize !== line.size) {
        autoY -= 14;
      }
      const y = line.y ?? autoY;
      ops.push(`BT /F1 ${line.size} Tf 72 ${y} Td (${escapePdfString(line.text)}) Tj ET`);
      autoY = y - Math.round(line.size * 1.6);
      prevSize = line.size;
    }
    pageEntries.push({ pageId, contentId, content: ops.join("\n") });
  }

  objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${pageObjIds
    .map((id) => `${id} 0 R`)
    .join(" ")}] /Count ${pages.length} >>\nendobj\n`;
  objects[fontId] = `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`;

  for (const { pageId, contentId, content } of pageEntries) {
    objects[pageId] =
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`;
    objects[contentId] =
      `${contentId} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`;
  }

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < nextId; id++) {
    offsets[id] = body.length;
    body += objects[id] ?? "";
  }

  const xrefStart = body.length;
  let xref = `xref\n0 ${nextId}\n0000000000 65535 f \n`;
  for (let id = 1; id < nextId; id++) {
    xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${nextId} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return new TextEncoder().encode(body + xref + trailer);
}
