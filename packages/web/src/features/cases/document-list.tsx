import { type CaseWithDocuments, derivePhase } from "@contractix/shared/schemas";

import { PhaseChip } from "./phase-chip.js";

/**
 * Per-document status. `derivePhase` is imported from the shared schemas rather
 * than reimplemented, so this agrees with what the progress stream will send
 * for the same rows.
 */
export function DocumentList({ documents }: { documents: CaseWithDocuments["documents"] }) {
  if (documents.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
        This case has no documents yet.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
      {documents.map((doc) => {
        const phase = derivePhase(doc);
        return (
          <li key={doc.id} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate font-medium text-slate-900">{doc.filename}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                {doc.language ? doc.language.toUpperCase() : "language pending"}
                {doc.pageCount !== null
                  ? ` · ${String(doc.pageCount)} ${doc.pageCount === 1 ? "page" : "pages"}`
                  : ""}
              </p>
            </div>
            <PhaseChip phase={phase} />
          </li>
        );
      })}
    </ul>
  );
}
