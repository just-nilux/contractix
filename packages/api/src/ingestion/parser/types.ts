import { type ParsedDocument } from "@contractix/shared";

/**
 * The parsing seam (ADR-0003). mupdf (AGPL) and mammoth live behind this
 * interface; the Phase-4 OCR path plugs in here as well. Nothing outside
 * ingestion/parser/ may import a concrete parser library.
 */
export interface Parser {
  /** Stable identifier recorded in the parse report. */
  readonly id: string;
  supports(mimeType: string): boolean;
  parse(bytes: Uint8Array): Promise<ParsedDocument>;
}

export const PDF_MIME = "application/pdf";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
