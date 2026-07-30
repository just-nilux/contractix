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

/**
 * What a `[[...]]` marker in generated prose can resolve to.
 *
 * Structural rather than nominal on purpose: `NarrativeCitation` and
 * `AnswerCitation` are different published shapes, but a marker resolves the
 * same way against either, and the renderer should not care which it was given.
 *
 * `verbatimAnchor` is optional because `NarrativeCitation` has no such property
 * at all - under `exactOptionalPropertyTypes` a required `string | null` would
 * make it non-assignable.
 */
export interface MarkerCitation {
  clauseId: string;
  serializedClauseId: string;
  documentId: string;
  page: number;
  charStart: number;
  charEnd: number;
  verbatimAnchor?: string | null;
}

export function toCitationTarget(citation: MarkerCitation): CitationTarget {
  return {
    documentId: citation.documentId,
    clauseId: citation.clauseId,
    page: citation.page,
    charStart: citation.charStart,
    charEnd: citation.charEnd,
    verbatimAnchor: citation.verbatimAnchor ?? null,
  };
}
