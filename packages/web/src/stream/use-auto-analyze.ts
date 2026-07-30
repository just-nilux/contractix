import { useEffect, useRef } from "react";

import { useAnalyzeCase } from "../api/queries.js";
import { type CaseStage } from "./derive-stage.js";

const key = (caseId: string) => `ctx.autoanalyze.${caseId}`;

function alreadyRequested(caseId: string): boolean {
  try {
    return sessionStorage.getItem(key(caseId)) !== null;
  } catch {
    return false;
  }
}

function markRequested(caseId: string): void {
  try {
    sessionStorage.setItem(key(caseId), "1");
  } catch {
    // Storage unavailable; the in-memory ref still stops a double-fire this mount.
  }
}

/**
 * Starts analysis once, automatically, as soon as every document is parsed.
 *
 * PRD §9 flow 1 is one motion - "upload → streamed progress → report" - and the
 * demo path lands on a case whose documents are ingested but never analyzed, so
 * without this the visitor sees five documents sitting at "Queued" and has to
 * work out that a button exists.
 *
 * Guarded by `sessionStorage`, not just a ref: React 19 StrictMode mounts,
 * unmounts and remounts every effect in development, which resets a ref but not
 * storage - and `analyze` is capped at 20/h, so a double-fire is a real cost,
 * not a cosmetic one. The ref covers the same tick, storage covers the remount.
 *
 * Returns nothing: the visible result is the stage moving on, and a manual
 * "Run the analysis" button covers every case this does not.
 */
export function useAutoAnalyze(caseId: string, stage: CaseStage): void {
  const analyze = useAnalyzeCase();
  const firedRef = useRef(false);
  const mutate = analyze.mutate;

  useEffect(() => {
    if (stage !== "ingested") return;
    if (firedRef.current || alreadyRequested(caseId)) return;

    firedRef.current = true;
    markRequested(caseId);
    mutate(caseId);
  }, [caseId, stage, mutate]);
}
