import { lazy, Suspense } from "react";

import { useCitations } from "../../citations/citation-context.js";
import { Button } from "../../components/ui/button.js";
import { Spinner } from "../../components/ui/spinner.js";

/**
 * pdfjs-dist is by far the heaviest thing in the bundle, and a visitor who
 * never clicks a citation should not download it. Lazily loaded, so it arrives
 * with the first click rather than with the landing page.
 */
const DocumentViewer = lazy(() =>
  import("./document-viewer.js").then((m) => ({ default: m.DocumentViewer })),
);

/**
 * A drawer over the report rather than a separate page: PRD §9 has the citation
 * "expand to clause with highlighted PDF span", and navigating away would cost
 * the reader their place in a list of flags they are working through.
 */
export function ViewerDrawer() {
  const { target, close } = useCitations();
  if (!target) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close the document viewer"
        onClick={close}
        className="absolute inset-0 bg-slate-900/30"
      />

      <aside
        aria-label="Cited clause"
        className="relative flex h-full w-full max-w-2xl flex-col overflow-y-auto border-l border-slate-200 bg-slate-50 shadow-xl"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-slate-50/95 px-5 py-3 backdrop-blur">
          <h2 className="text-sm font-medium text-slate-900">Cited clause</h2>
          <Button variant="ghost" onClick={close}>
            Close
          </Button>
        </div>

        <div className="p-5">
          <Suspense
            fallback={
              <p role="status" className="flex items-center gap-2 py-8 text-sm text-slate-500">
                <Spinner /> Loading the viewer…
              </p>
            }
          >
            <DocumentViewer />
          </Suspense>
        </div>
      </aside>
    </div>
  );
}
