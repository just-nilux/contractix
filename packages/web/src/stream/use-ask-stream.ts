import { agentStreamEventSchema } from "@contractix/shared/schemas";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { getCaseTurns } from "../api/endpoints.js";
import { RateLimitError, SessionError } from "../api/errors.js";
import { queryKeys } from "../api/queries.js";
import {
  type AskAction,
  askReducer,
  type AskState,
  initialAskState,
  replayedTurn,
} from "./ask-reducer.js";
import { parseStreamFrame, postSse } from "./post-sse.js";

export interface AskStream extends AskState {
  /** Non-null when the five-per-minute ceiling was hit, so the UI can count down. */
  rateLimit: RateLimitError | null;
  ask: (question: string) => void;
  stop: () => void;
  running: boolean;
}

/**
 * Streams `POST /cases/{id}/ask` into a transcript.
 *
 * The transcript lives in the query cache rather than in component state, so
 * navigating to the case list and back does not lose the conversation. There is
 * no `GET /cases/{id}/turns` yet - `qa_turns` is persisted for cost accounting
 * and audit, not published - so nothing ever fetches this key and the stream is
 * its only writer. The day that endpoint lands, this becomes a `queryFn` and
 * the panel does not change.
 */
export function useAskStream(caseId: string): AskStream {
  const client = useQueryClient();
  const [running, setRunning] = useState(false);
  const [rateLimit, setRateLimit] = useState<RateLimitError | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const key = queryKeys.turns(caseId);

  const { data: state } = useQuery<AskState>({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const { turns } = await getCaseTurns(caseId, { signal });
      const fetched = turns.map(replayedTurn);

      // Merge rather than replace. The stream writes this same entry, so a
      // question asked while this request was in flight would otherwise vanish
      // from the screen the moment the transcript arrived — and the answer would
      // still be streaming into a turn nobody could see.
      const known = new Set(fetched.map((t) => t.id));
      const local = client.getQueryData<AskState>(key)?.turns ?? [];
      return { turns: [...fetched, ...local.filter((t) => !known.has(t.id))] };
    },
    // Fetched once on mount and never again: `staleTime: Infinity` plus the
    // client's `refetchOnWindowFocus: false` mean the stream stays the only
    // writer after that, so a refetch can never clobber a live answer.
    //
    // Deliberately no `initialData`: seeding it would make the entry
    // permanently fresh and the transcript would never load at all.
    staleTime: Infinity,
    // Without this the transcript is collected five minutes after the panel
    // unmounts, which is exactly the case navigating away and back produces.
    gcTime: Infinity,
    // A 401 still throws to the route boundary; anything else leaves the panel
    // empty rather than replacing the case with an error page.
    throwOnError: (error) => error instanceof SessionError,
  });

  const dispatch = useCallback(
    (action: AskAction) => {
      client.setQueryData<AskState>(key, (prev) => askReducer(prev ?? initialAskState, action));
    },
    // `key` is a fresh array each render; caseId is what actually varies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, caseId],
  );

  // StrictMode mounts, unmounts and remounts every effect in development, and an
  // orphaned request would keep streaming - and billing - with nobody reading.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const stop = useCallback(() => {
    if (!abortRef.current) return;
    abortRef.current.abort();
    abortRef.current = null;
    setRunning(false);
    dispatch({ type: "cancelled" });
  }, [dispatch]);

  const ask = useCallback(
    (question: string) => {
      if (abortRef.current) return;

      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      setRateLimit(null);
      dispatch({ type: "asked", id: crypto.randomUUID(), question });

      void (async () => {
        try {
          for await (const frame of postSse(`/cases/${caseId}/ask`, {
            body: { question },
            signal: controller.signal,
          })) {
            const event = parseStreamFrame(agentStreamEventSchema, frame);
            // Heartbeats and any variant a newer server invents parse to null
            // and are ignored rather than killing a working stream.
            if (event) dispatch(event);
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          if (err instanceof RateLimitError) {
            // The request never reached the agent, so there is no turn to show
            // as failed - the countdown says everything there is to say.
            setRateLimit(err);
            dispatch({ type: "dropped" });
          } else {
            dispatch({
              type: "error",
              message: err instanceof Error ? err.message : "The question could not be answered.",
            });
          }
        } finally {
          // Both guarded by controller identity, not just the ref: Stop clears
          // `abortRef` synchronously, so a second question can start before
          // this task unwinds. An unguarded `setRunning(false)` would then
          // report the *newer* stream as finished — hiding its Stop button and
          // re-enabling Ask on a request still in flight.
          if (abortRef.current === controller) {
            abortRef.current = null;
            setRunning(false);
          }
        }
      })();
    },
    [caseId, dispatch],
  );

  return { ...(state ?? initialAskState), rateLimit, ask, stop, running };
}
