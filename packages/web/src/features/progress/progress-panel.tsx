import { type CaseWithDocuments, derivePhase, type Progress } from "@contractix/shared/schemas";

import { PhaseChip } from "../cases/phase-chip.js";

type DocumentSummary = CaseWithDocuments["documents"][number];

interface Row {
  id: string;
  filename: string;
  phase: ReturnType<typeof derivePhase>;
  language: string | null;
  pageCount: number | null;
  pageFailures: number[];
}

/**
 * Merges the live stream with the case read.
 *
 * The stream carries the moving parts - phase and per-page parse failures - but
 * not `language` or `pageCount`, which are written once at the end of parsing.
 * Rather than have the stream carry fields it does not own, each source
 * supplies what it knows and the rows are joined on document id.
 */
function rows(documents: readonly DocumentSummary[], progress: Progress | null): Row[] {
  return documents.map((doc) => {
    const live = progress?.documents.find((d) => d.documentId === doc.id);
    return {
      id: doc.id,
      filename: doc.filename,
      phase: live ? live.phase : derivePhase(doc),
      language: doc.language,
      pageCount: doc.pageCount,
      pageFailures: live?.pageFailures ?? [],
    };
  });
}

export function ProgressPanel({
  documents,
  progress,
  degraded,
}: {
  documents: readonly DocumentSummary[];
  progress: Progress | null;
  degraded: boolean;
}) {
  if (documents.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
        This case has no documents yet.
      </p>
    );
  }

  return (
    <div>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {rows(documents, progress).map((row) => (
          <li key={row.id} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate font-medium text-slate-900">{row.filename}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                {row.language ? row.language.toUpperCase() : "language pending"}
                {row.pageCount !== null
                  ? ` · ${String(row.pageCount)} ${row.pageCount === 1 ? "page" : "pages"}`
                  : ""}
              </p>
              {/* PRD §9 wants parse failure surfaced per page rather than as a
                  whole-document error: the rest of the document is still usable. */}
              {row.pageFailures.length > 0 && (
                <p className="mt-1 text-xs text-severity-amber">
                  {row.pageFailures.length === 1 ? "Page" : "Pages"} {row.pageFailures.join(", ")}{" "}
                  could not be read
                </p>
              )}
            </div>
            <PhaseChip phase={row.phase} />
          </li>
        ))}
      </ul>

      {degraded && (
        <p className="mt-2 text-xs text-slate-500">
          The live connection dropped; this page is checking for updates instead.
        </p>
      )}
    </div>
  );
}
