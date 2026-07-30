import { type ReportCitation } from "@contractix/shared/schemas";

import { useCitations } from "../../citations/citation-context.js";

/**
 * A citation, rendered as its clause reference rather than as a footnote
 * number: "§ 11, p2" is checkable against the document in the reader's hand,
 * whereas "[3]" only points back into this page.
 */
export function CitationChip({
  citation,
  documentId,
}: {
  citation: ReportCitation;
  documentId: string;
}) {
  const { open } = useCitations();

  const label = citation.heading ?? citation.clauseRef;

  return (
    <button
      type="button"
      title={citation.verbatimAnchor ?? `Clause ${citation.clauseRef}`}
      onClick={() => {
        open({
          documentId,
          clauseId: citation.clauseId,
          page: citation.page,
          charStart: citation.charStart,
          charEnd: citation.charEnd,
          verbatimAnchor: citation.verbatimAnchor,
        });
      }}
      className="inline-flex max-w-full items-baseline gap-1 rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-xs text-slate-700 hover:border-slate-400 hover:bg-slate-100"
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 text-slate-400">p{citation.page}</span>
    </button>
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
