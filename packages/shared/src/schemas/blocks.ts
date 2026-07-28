import { z } from "zod";

export const blockTypeSchema = z.enum([
  "heading",
  "paragraph",
  "list_item",
  "table_cell",
  "footer",
]);
export type BlockType = z.infer<typeof blockTypeSchema>;

/** Page-space rectangle in PDF points; null for formats without geometry (DOCX). */
export const bboxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});
export type BBox = z.infer<typeof bboxSchema>;

/**
 * Canonical layout block (PRD FR-1.3).
 *
 * `charStart`/`charEnd` are absolute offsets into the document's canonical
 * text (`blocks.map((b) => b.text).join("\n")`). They are frozen exactly once
 * at parse time - every normalization happens BEFORE offsets are assigned,
 * and every downstream stage (clauses, chunks, citations) only ever slices.
 * This is what makes citations structural rather than quote-matched.
 */
export const blockSchema = z.object({
  page: z.number().int().positive(),
  bbox: bboxSchema.nullable(),
  type: blockTypeSchema,
  text: z.string(),
  charStart: z.number().int().nonnegative(),
  charEnd: z.number().int().nonnegative(),
});
export type Block = z.infer<typeof blockSchema>;

export const pageReportSchema = z.object({
  page: z.number().int().positive(),
  status: z.enum(["ok", "empty", "error"]),
  chars: z.number().int().nonnegative(),
  error: z.string().optional(),
  /**
   * Page box in PDF points. Absent for formats without geometry (DOCX) and for
   * documents parsed before this was recorded. The viewer needs it to scale a
   * block bbox to rendered pixels, and reporting it beats having the client
   * infer it from whatever pdf.js happens to return.
   */
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});
export type PageReport = z.infer<typeof pageReportSchema>;

/** Per-document parse outcome persisted on `documents.parse_report` (PRD FR-1.5). */
export const parseReportSchema = z.object({
  parser: z.string(),
  coverage: z.number().min(0).max(1),
  pages: z.array(pageReportSchema),
  /** business-level failure reason (low coverage, no clauses, pipeline error) */
  error: z.string().optional(),
});
export type ParseReport = z.infer<typeof parseReportSchema>;

export const parsedDocumentSchema = z.object({
  blocks: z.array(blockSchema),
  pageCount: z.number().int().positive(),
  report: parseReportSchema,
});
export type ParsedDocument = z.infer<typeof parsedDocumentSchema>;

/** The canonical text every offset in a document refers to. */
export function canonicalText(blocks: readonly Pick<Block, "text">[]): string {
  return blocks.map((b) => b.text).join("\n");
}
