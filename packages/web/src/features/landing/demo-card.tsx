import { useNavigate } from "react-router";

import { RateLimitError, UnavailableError } from "../../api/errors.js";
import { useAdoptDemo, useDemoCatalog } from "../../api/queries.js";
import { RateLimitedNotice } from "../../components/states/rate-limited.js";
import { Button } from "../../components/ui/button.js";
import { Card, CardTitle } from "../../components/ui/card.js";
import { Spinner } from "../../components/ui/spinner.js";

const TYPE_LABELS: Record<string, string> = {
  employment_offer: "Employment offer",
  employment_contract: "Employment contract",
  vsop_esop_agreement: "VSOP / ESOP",
  term_sheet: "Term sheet",
  shareholders_agreement: "Shareholders' agreement",
  side_letter: "Side letter",
  other: "Other",
};

/**
 * FR-6.4's "try without upload". `GET /demo` is the one endpoint that answers
 * without a session, so this card renders before the visitor has one; adopting
 * mints the session and clones the corpus into it (ADR-0011 - cloned, not
 * shared, so the tenant guard stays a single equality check).
 */
export function DemoCard() {
  const navigate = useNavigate();
  // A 401 is impossible here, but the landing page must never throw for one.
  const catalog = useDemoCatalog();
  const adopt = useAdoptDemo();

  const unavailable = catalog.data?.available === false || adopt.error instanceof UnavailableError;

  return (
    <Card>
      <CardTitle>Try it on the demo corpus</CardTitle>
      <p className="mt-2 text-sm text-slate-600">
        Synthetic German and English documents with the traps deliberately left in. Nothing to
        upload.
      </p>

      {catalog.isPending && (
        <p className="mt-4 flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading the corpus…
        </p>
      )}

      {unavailable ? (
        <p className="mt-4 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          The demo corpus is not seeded on this deployment.
          {import.meta.env.DEV && (
            <span className="mt-1 block font-mono text-xs text-slate-500">pnpm seed:demo</span>
          )}
        </p>
      ) : (
        catalog.data && (
          <ul className="mt-4 divide-y divide-slate-100 border-y border-slate-100">
            {catalog.data.documents.map((doc) => (
              <li key={doc.filename} className="flex items-baseline justify-between gap-4 py-2">
                <span className="truncate text-sm text-slate-800">{doc.filename}</span>
                <span className="shrink-0 text-xs text-slate-500">
                  {doc.type ? (TYPE_LABELS[doc.type] ?? doc.type) : "unclassified"}
                  {doc.language ? ` · ${doc.language.toUpperCase()}` : ""}
                  {doc.pageCount !== null ? ` · ${String(doc.pageCount)}p` : ""}
                </span>
              </li>
            ))}
          </ul>
        )
      )}

      {adopt.error instanceof RateLimitError && (
        <div className="mt-4">
          <RateLimitedNotice error={adopt.error} action="Starting a demo session" />
        </div>
      )}

      <Button
        className="mt-5 w-full"
        disabled={unavailable || adopt.isPending || catalog.isPending}
        onClick={() => {
          adopt.mutate(undefined, {
            onSuccess: (result) => void navigate(`/cases/${result.caseId}`),
          });
        }}
      >
        {adopt.isPending && <Spinner />}
        {adopt.isPending ? "Preparing your copy…" : "Try the demo corpus"}
      </Button>
    </Card>
  );
}
