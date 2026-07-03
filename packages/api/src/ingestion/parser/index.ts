import { MammothDocxParser } from "./docx-parser.js";
import { MupdfParser } from "./mupdf-parser.js";
import { type Parser } from "./types.js";

const parsers: Parser[] = [new MupdfParser(), new MammothDocxParser()];

export function parserFor(mimeType: string): Parser | null {
  return parsers.find((p) => p.supports(mimeType)) ?? null;
}

export { DOCX_MIME, PDF_MIME, type Parser } from "./types.js";
