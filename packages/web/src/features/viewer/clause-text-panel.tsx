import { type Clause } from "@contractix/shared/schemas";

/**
 * The exact rendering, and the reason the rectangles are allowed to be
 * approximate.
 *
 * `clause.text` is the frozen canonical text and the span offsets are absolute
 * into the same string, so the cited part is a plain `.slice()` at frozen
 * offsets - pixel-exact by construction, and the one operation ADR-0005 permits
 * downstream of the parser. No searching, no matching, no normalisation.
 *
 * Always available, which is what makes this the fallback for DOCX, for a page
 * that failed to parse, and for a document whose geometry cannot be trusted.
 */
export function ClauseTextPanel({
  clause,
  span,
  note,
}: {
  clause: Clause;
  span: { start: number; end: number } | null;
  note?: string;
}) {
  const start = span ? Math.max(0, span.start - clause.charStart) : 0;
  const end = span ? Math.min(clause.text.length, span.end - clause.charStart) : 0;
  const highlightable = span !== null && end > start;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-slate-900">
          {clause.heading ?? `Clause ${clause.clausePath}`}
        </h3>
        <span className="text-xs text-slate-500">
          {clause.clauseRef} · page {clause.page}
        </span>
      </div>

      {note !== undefined && <p className="mt-2 text-xs text-slate-500">{note}</p>}

      <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap text-slate-800">
        {highlightable ? (
          <>
            {clause.text.slice(0, start)}
            <mark className="rounded bg-citation/40 px-0.5">{clause.text.slice(start, end)}</mark>
            {clause.text.slice(end)}
          </>
        ) : (
          clause.text
        )}
      </p>
    </div>
  );
}
