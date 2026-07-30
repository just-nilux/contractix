/**
 * Collapses a case's per-document statuses into the one stage the UI acts on.
 *
 * This exists because `done` on the progress stream is not the same question as
 * "is there anything left to do". The API sets `done` only once every document
 * is terminal *and* analysis has been asked for, so a case that has merely been
 * ingested - which is exactly what `POST /demo/adopt` produces - never emits
 * `done` and runs to the five-minute `timeout` instead. A client that waited on
 * `done` would sit on a spinner for five minutes and then look broken.
 *
 * Derived from the raw `status` / `analysisStatus` pair rather than from
 * `phase`, because `phase` deliberately collapses "uploaded, not yet parsed"
 * and "parsed, awaiting analysis" into the same `queued` - and the difference
 * between those two is precisely what decides whether analysis should start.
 */
export interface StageInput {
  status: string;
  analysisStatus: string;
}

export type CaseStage =
  /** No documents at all. */
  | "empty"
  /** At least one document is still being parsed. */
  | "ingesting"
  /** Every document is parsed and none has ever been analyzed - analysis can start. */
  | "ingested"
  /** Analysis is running on at least one document. */
  | "analyzing"
  /** Nothing is moving and at least one report exists. */
  | "analyzed"
  /** Every document failed to parse; there is nothing to analyze. */
  | "failed";

const SETTLED: readonly CaseStage[] = ["empty", "analyzed", "failed"];

export function deriveCaseStage(documents: readonly StageInput[]): CaseStage {
  if (documents.length === 0) return "empty";

  const ingestSettled = (d: StageInput) => d.status === "ready" || d.status === "failed";
  if (!documents.every(ingestSettled)) return "ingesting";

  // A document that failed to parse has no clauses, so analysis cannot say
  // anything about it; the stage is decided by the ones that survived.
  const usable = documents.filter((d) => d.status === "ready");
  if (usable.length === 0) return "failed";

  if (usable.some((d) => d.analysisStatus === "analyzing")) return "analyzing";
  if (usable.every((d) => d.analysisStatus === "pending")) return "ingested";
  // Anything else - all analyzed, or a mix where some finished and some never
  // started - means a report exists and nothing is running.
  return "analyzed";
}

/** True when no further event can change the picture without a new request. */
export function isSettled(stage: CaseStage): boolean {
  return SETTLED.includes(stage);
}
