import { type ReportCitation } from "@contractix/shared/schemas";

import { ClauseLink } from "../../citations/clause-link.js";

/**
 * A citation, rendered as its clause reference rather than as a footnote
 * number: "§ 11, p2" is checkable against the document in the reader's hand,
 * whereas "[3]" only points back into this page.
 *
 * Not folded into `MarkerCitation`: a report citation carries a `clauseRef` and
 * a `heading` that prose citations do not, and its offsets are nullable because
 * a flag cites a whole clause with no sub-span. `ClauseLink` captures what is
 * actually shared - opening the viewer - and leaves the label here.
 */
export function CitationChip({
  citation,
  documentId,
}: {
  citation: ReportCitation;
  documentId: string;
}) {
  const label = citation.heading ?? citation.clauseRef;

  return (
    <ClauseLink
      target={{
        documentId,
        clauseId: citation.clauseId,
        page: citation.page,
        charStart: citation.charStart,
        charEnd: citation.charEnd,
        verbatimAnchor: citation.verbatimAnchor,
      }}
      title={citation.verbatimAnchor ?? `Clause ${citation.clauseRef}`}
      className="inline-flex max-w-full items-baseline gap-1 px-1.5 py-0.5 text-xs"
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 text-slate-400">p{citation.page}</span>
    </ClauseLink>
  );
}

export function CitationList({
  citations,
  documentId,
}: {
  citations: readonly ReportCitation[];
  documentId: string;
}) {
  if (citations.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {citations.map((c) => (
        <CitationChip
          key={`${c.clauseId}:${String(c.charStart)}`}
          citation={c}
          documentId={documentId}
        />
      ))}
    </span>
  );
}
