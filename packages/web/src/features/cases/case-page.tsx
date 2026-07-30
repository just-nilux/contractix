import { useQuery } from "@tanstack/react-query";
import { Navigate, useParams } from "react-router";

import { getCase } from "../../api/endpoints.js";
import { queryKeys, useAnalyzeCase } from "../../api/queries.js";
import { Button } from "../../components/ui/button.js";
import { Spinner } from "../../components/ui/spinner.js";
import { deriveCaseStage, isSettled } from "../../stream/derive-stage.js";
import { useAutoAnalyze } from "../../stream/use-auto-analyze.js";
import { useCaseProgress } from "../../stream/use-progress.js";
import { ChatPanel } from "../chat/chat-panel.js";
import { ProgressPanel } from "../progress/progress-panel.js";
import { NarrativePanel } from "../narrative/narrative-panel.js";
import { CaseReportView } from "../report/case-report.js";
import { CaseSearch } from "../search/case-search.js";

/** Only used once the stream has given up; see `useCaseProgress`. */
const FALLBACK_POLL_MS = 3_000;

export function CasePage() {
  const { caseId = "" } = useParams();

  const { data, isPending, error } = useQuery({
    queryKey: queryKeys.case(caseId),
    queryFn: ({ signal }) => getCase(caseId, { signal }),
    enabled: caseId !== "",
    refetchInterval: (query) => {
      const docs = query.state.data?.documents ?? [];
      return isSettled(deriveCaseStage(docs)) ? false : FALLBACK_POLL_MS;
    },
  });

  // The stream is opened only after a typed read succeeded, so a session
  // failure has already surfaced as itself rather than as an opaque
  // EventSource error.
  const { progress, degraded } = useCaseProgress(caseId, data !== undefined);

  const documents = data?.documents ?? [];
  const stage = deriveCaseStage(progress?.documents ?? documents);
  useAutoAnalyze(caseId, stage);

  const analyze = useAnalyzeCase();

  if (caseId === "") return <Navigate to="/" replace />;

  if (isPending) {
    return (
      <p role="status" className="flex items-center gap-2 py-16 text-slate-500">
        <Spinner /> Loading the case…
      </p>
    );
  }

  if (error || !data) {
    return (
      <div className="py-16 text-center">
        <h1 className="text-2xl font-semibold text-slate-900">Case not found</h1>
        <p className="mt-3 text-slate-600">
          It may have been deleted, or it belongs to a different session.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{data.title}</h1>
          {/* Deliberately not `retentionDays`: that field is the Phase-4
              per-case setting, while an anonymous tenant's `exp` and the
              retention job both run on 24 h (ADR-0011). */}
          <p className="mt-1 text-sm text-slate-500">
            {documents.length} {documents.length === 1 ? "document" : "documents"} · deleted
            automatically when this session ends, within 24 hours
          </p>
        </div>

        {stage === "analyzed" && (
          <Button
            variant="secondary"
            disabled={analyze.isPending}
            onClick={() => {
              analyze.mutate(caseId);
            }}
          >
            {analyze.isPending && <Spinner />}
            Re-run the analysis
          </Button>
        )}
      </div>

      <div className="mt-8">
        <ProgressPanel documents={documents} progress={progress} degraded={degraded} />
      </div>

      {/* Rendered as soon as anything has been analyzed, not only once the whole
          case has: a two-document case should not hide the finished report
          behind the slower document. */}
      <CaseReportView caseId={caseId} enabled={stage === "analyzed" || stage === "analyzing"} />

      {/* The narrative is written over the structured report, so it only makes
          sense once one exists. */}
      {stage === "analyzed" && <NarrativePanel caseId={caseId} />}

      {/* Gated with search rather than with the narrative: the agent's
          retrieval tools work over clauses, which exist before analysis, and
          FR-1.2 makes Q&A the only analysis a document classified `other` ever
          gets. Hiding this behind `analyzed` would hide it exactly where it is
          the only thing on the page. */}
      {stage !== "ingesting" && stage !== "empty" && <ChatPanel caseId={caseId} />}

      {/* Available as soon as the clauses exist, which is before analysis - and
          for a document classified as `other` it is the only citation entry
          point there is. */}
      {stage !== "ingesting" && stage !== "empty" && <CaseSearch caseId={caseId} />}
    </div>
  );
}
