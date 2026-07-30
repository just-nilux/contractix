import { narrativeStreamEventSchema } from "@contractix/shared/schemas";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { RateLimitError } from "../api/errors.js";
import { queryKeys } from "../api/queries.js";
import {
  initialNarrativeState,
  narrativeReducer,
  type NarrativeState,
} from "./narrative-reducer.js";
import { parseStreamFrame, postSse } from "./post-sse.js";

export interface NarrativeStream extends NarrativeState {
  /** Non-null when the 10/hour ceiling was hit, so the UI can count down. */
  rateLimit: RateLimitError | null;
  start: () => void;
  stop: () => void;
  running: boolean;
}

/**
 * Streams `POST /cases/{id}/narrative`.
 *
 * Deliberately never auto-starts. The documented client pattern is
 * GET-then-POST-on-404, and a 404 there means "no narrative generated yet" -
 * which is a state, not a failure. Firing the POST automatically would spend a
 * frontier call, capped at ten an hour, on every visitor who scrolled far
 * enough, so the button stays the trigger.
 */
export function useNarrativeStream(caseId: string, documentId?: string): NarrativeStream {
  const client = useQueryClient();
  const [state, dispatch] = useReducer(narrativeReducer, initialNarrativeState);
  const [running, setRunning] = useState(false);
  const [rateLimit, setRateLimit] = useState<RateLimitError | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // StrictMode mounts, unmounts and remounts every effect in development, and an
  // orphaned generation would keep streaming - and billing - with nobody reading.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  const start = useCallback(() => {
    if (abortRef.current) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setRateLimit(null);

    const query = documentId === undefined ? "" : `?document_id=${documentId}`;

    void (async () => {
      try {
        for await (const frame of postSse(`/cases/${caseId}/narrative${query}`, {
          signal: controller.signal,
        })) {
          const event = parseStreamFrame(narrativeStreamEventSchema, frame);
          // Heartbeats and any variant a newer server invents parse to null and
          // are ignored rather than killing a working stream.
          if (event) dispatch(event);
        }
        // A stored narrative now exists, so the cheap GET path is warm.
        void client.invalidateQueries({ queryKey: queryKeys.narrative(caseId, documentId) });
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof RateLimitError) setRateLimit(err);
        else {
          dispatch({
            type: "error",
            message: err instanceof Error ? err.message : "The report could not be generated.",
          });
        }
      } finally {
        // Guarded by controller identity for the same reason as `ask`: Stop
        // clears `abortRef` synchronously, so a regeneration can start before
        // this task unwinds, and an unguarded `setRunning(false)` would report
        // the newer one as finished while it is still streaming.
        if (abortRef.current === controller) {
          abortRef.current = null;
          setRunning(false);
        }
      }
    })();
  }, [caseId, documentId, client]);

  return { ...state, rateLimit, start, stop, running };
}
