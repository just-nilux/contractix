import { useQuery } from "@tanstack/react-query";

import { getNarrative } from "../../api/endpoints.js";
import { NotFoundError } from "../../api/errors.js";
import { queryKeys } from "../../api/queries.js";
import { CouldNotVerify } from "../../citations/could-not-verify.js";
import { MarkdownView } from "../../citations/markdown-view.js";
import { RateLimitedNotice } from "../../components/states/rate-limited.js";
import { Button } from "../../components/ui/button.js";
import { Spinner } from "../../components/ui/spinner.js";
import { useNarrativeStream } from "../../stream/use-narrative-stream.js";

/**
 * FR-5.3's narrative report.
 *
 * GET first, and on a 404 offer a button rather than firing the POST: 404 means
 * "not generated yet", which is a state, and generation is a metered frontier
 * call capped at ten an hour.
 */
export function NarrativePanel({ caseId }: { caseId: string }) {
  const stored = useQuery({
    queryKey: queryKeys.narrative(caseId),
    queryFn: ({ signal }) => getNarrative(caseId, undefined, { signal }),
    throwOnError: false,
    retry: false,
  });

  const stream = useNarrativeStream(caseId);

  const notGenerated = stored.error instanceof NotFoundError;
  /**
   * Anything else the GET failed with - most usefully a `ResponseShapeError`,
   * which is how ADR-0012 says a server schema change announces itself. Without
   * this branch it announced itself as an empty section with a lone button,
   * which is the opposite of loud.
   */
  const storedError = stored.error !== null && !notGenerated ? stored.error : null;
  const narrative = stream.result ?? stored.data ?? null;
  const markdown = stream.status === "idle" ? (narrative?.markdown ?? "") : stream.markdown;
  const citations = narrative?.citations ?? [];
  const couldNotVerify = narrative?.couldNotVerify ?? [];

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight text-slate-900">Narrative report</h2>
        <div className="flex items-center gap-3">
          {narrative && !stream.running && (
            <span className="text-xs text-slate-500">
              {narrative.grounded ? "Every claim tied to a clause" : "Some claims unverified"}
              {stream.corrected || narrative.corrected ? " · regenerated once" : ""}
            </span>
          )}
          {stream.running ? (
            <Button variant="secondary" onClick={stream.stop}>
              Stop
            </Button>
          ) : (
            <Button variant={narrative ? "secondary" : "primary"} onClick={stream.start}>
              {narrative ? "Write a new one" : "Write the report"}
            </Button>
          )}
        </div>
      </div>

      {stream.rateLimit && (
        <div className="mt-4">
          <RateLimitedNotice error={stream.rateLimit} action="Writing a report" />
        </div>
      )}

      {stored.isPending && !stream.running && (
        <p role="status" className="mt-4 flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Looking for an existing report…
        </p>
      )}

      {notGenerated && stream.status === "idle" && !stream.rateLimit && (
        <p className="mt-4 rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
          No narrative has been written for this case yet. It is generated on request because it
          costs a model call, so nothing is spent on a page nobody scrolls to.
        </p>
      )}

      {stream.status === "correcting" && (
        <p role="status" className="mt-4 flex items-center gap-2 text-sm text-severity-amber">
          <Spinner />
          Re-checking citations
          {stream.retryReason === null ? "" : ` — ${stream.retryReason}`}
        </p>
      )}

      {storedError !== null && stream.status === "idle" && (
        <p className="mt-4 rounded border border-severity-red-border bg-severity-red-surface px-3 py-2 text-sm text-severity-red">
          An existing report could not be loaded: {storedError.message}
        </p>
      )}

      {stream.status === "error" && stream.error !== null && (
        <p className="mt-4 rounded border border-severity-red-border bg-severity-red-surface px-3 py-2 text-sm text-severity-red">
          {stream.error}
        </p>
      )}

      {markdown !== "" && (
        <div className="mt-4 rounded-lg border border-slate-200 p-6">
          <MarkdownView
            markdown={markdown}
            citations={citations}
            citationsKnown={!stream.running && narrative !== null}
          />
          {stream.running && <Spinner className="mt-2 text-slate-400" />}
        </div>
      )}

      {!stream.running && <CouldNotVerify claims={couldNotVerify} />}

      {narrative && !stream.running && (
        <p className="mt-3 text-xs text-slate-500">{narrative.disclaimer}</p>
      )}
    </section>
  );
}
