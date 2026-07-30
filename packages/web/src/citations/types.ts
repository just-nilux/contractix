/**
 * What the report hands the viewer when a citation is clicked.
 *
 * `charStart`/`charEnd` are nullable because the two kinds of citation carry
 * different precision, and the difference is real rather than incidental: an
 * extraction citation resolved a `verbatim_anchor` to an exact span, while a
 * flag cites a whole clause and has no sub-span at all. The viewer resolves the
 * null case by loading the clause and using *its* frozen offsets.
 */
export interface CitationTarget {
  documentId: string;
  clauseId: string;
  page: number;
  charStart: number | null;
  charEnd: number | null;
  /** Display only - never used to locate anything (ADR-0006/0007). */
  verbatimAnchor: string | null;
}
