import { type LayoutPage } from "@contractix/shared/schemas";
import { useEffect, useMemo, useState } from "react";
import { Document, Page } from "react-pdf";

import { documentFileUrl } from "../../api/endpoints.js";
import { useClause, useDocumentLayout } from "../../api/queries.js";
import { useCitations } from "../../citations/citation-context.js";
import { geometryIsTrustworthy, pageScale } from "../../citations/geometry.js";
import { resolveHighlights } from "../../citations/resolve.js";
import { Spinner } from "../../components/ui/spinner.js";
import { ClauseTextPanel } from "./clause-text-panel.js";
import { HighlightOverlay } from "./highlight-overlay.js";
import "./pdfjs-worker.js";

/** Both built-in layers are off, so no react-pdf CSS is needed at all. */
const PAGE_PROPS = { renderTextLayer: false, renderAnnotationLayer: false } as const;

function Loading({ label }: { label: string }) {
  return (
    <p role="status" className="flex items-center gap-2 py-8 text-sm text-slate-500">
      <Spinner /> {label}
    </p>
  );
}

export function DocumentViewer() {
  const { target } = useCitations();
  const documentId = target?.documentId ?? "";

  const layout = useDocumentLayout(documentId);
  // Always loaded: it is the exact rendering shown beside the page, and for a
  // flag citation - which carries no sub-span - it also supplies the offsets.
  const clause = useClause(target?.clauseId ?? null);

  const [containerWidth, setContainerWidth] = useState(0);
  const [trusted, setTrusted] = useState(true);
  // State, not a ref: the container is rendered behind a loading branch, so a
  // `useRef` + mount-only effect would observe null and never look again, and
  // the overlay would silently never get a scale.
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  // The overlay must line up with what was rendered, so the width comes from the
  // element rather than from a nominal scale.
  useEffect(() => {
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) setContainerWidth(width);
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [container]);

  // Memoized: an inline object literal re-creates the document on every render,
  // which refetches the file and produces a storm of cancelled render tasks.
  const file = useMemo(
    () => (documentId === "" ? null : { url: documentFileUrl(documentId) }),
    [documentId],
  );
  const options = useMemo(() => ({}), []);

  const plan = useMemo(() => {
    if (!target || !layout.data) return null;
    return resolveHighlights(target, layout.data, clause.data ?? undefined);
  }, [target, layout.data, clause.data]);

  if (!target) return null;
  if (layout.isPending) return <Loading label="Loading the document…" />;
  if (!layout.data) return <p className="py-8 text-sm text-slate-500">That document is gone.</p>;

  const span = plan?.span ?? null;

  const textPanel = clause.data ? (
    <ClauseTextPanel
      clause={clause.data}
      span={span}
      {...(plan?.approximate === true
        ? { note: "The highlight below is approximate; this text is the exact citation." }
        : {})}
    />
  ) : (
    <Loading label="Loading the clause…" />
  );

  // Every path that cannot draw a trustworthy rectangle falls back to the exact
  // clause text rather than to nothing, or worse, to a rectangle in the wrong place.
  const reason = !layout.data.geometry
    ? layout.data.mimeType.includes("wordprocessingml")
      ? "This is a DOCX, which has no page geometry, so the citation is shown as clause text."
      : "This document was stored without page geometry, so the citation is shown as clause text."
    : plan?.status === "no-geometry-for-span"
      ? "The page holding this clause could not be read, so the citation is shown as clause text."
      : !trusted
        ? "The stored page size disagrees with the rendered one, so the highlight is not drawn."
        : null;

  if (reason !== null) {
    return (
      <div className="space-y-4">
        <p className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          {reason}
        </p>
        {textPanel}
      </div>
    );
  }

  const pageNumber = plan?.primaryPage ?? target.page;
  const layoutPage: LayoutPage | undefined = layout.data.pages.find((p) => p.page === pageNumber);
  const rects = plan?.pages.find((p) => p.page === pageNumber)?.rects ?? [];

  // Mirror what react-pdf will do: with no `width` prop it renders the page at
  // its natural point size, so the scale is 1 rather than unknown. Treating a
  // zero-width container as "no scale" would drop the highlight silently in
  // exactly the cases where it is hardest to notice.
  const renderedWidth = containerWidth > 0 ? containerWidth : (layoutPage?.width ?? 0);
  const scale = layoutPage ? pageScale(renderedWidth, layoutPage) : 0;

  return (
    <div className="space-y-4">
      {textPanel}

      <div ref={setContainer} className="w-full">
        {file && (
          <Document
            file={file}
            options={options}
            loading={<Loading label="Rendering the page…" />}
            error={
              <p className="py-8 text-sm text-slate-500">
                The file could not be rendered. The clause text above is unaffected.
              </p>
            }
            className="relative"
          >
            <div className="relative inline-block">
              {/* Rendered only once the container has a width, so the page is
                  rasterised once at its final size instead of twice. */}
              <Page
                pageNumber={pageNumber}
                {...(containerWidth > 0 ? { width: containerWidth } : {})}
                {...PAGE_PROPS}
                onLoadSuccess={(page) => {
                  // The one checked assumption: mupdf's page box and pdf.js's
                  // viewport should describe the same rectangle.
                  if (layoutPage) {
                    setTrusted(geometryIsTrustworthy(page.getViewport({ scale: 1 }), layoutPage));
                  }
                }}
              />
              <HighlightOverlay rects={rects} scale={scale} />
            </div>
          </Document>
        )}
      </div>
    </div>
  );
}
