import { type Progress, progressSchema } from "@contractix/shared/schemas";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { apiUrl } from "../api/client.js";
import { queryKeys } from "../api/queries.js";

/** The API closes the stream after five minutes; reopening is free and correct. */
const MAX_REOPENS = 3;
/** Consecutive transport errors before giving up on the stream entirely. */
const MAX_ERRORS = 3;

export interface ProgressStream {
  progress: Progress | null;
  /** True once the stream gave up and the page is on the polling fallback. */
  degraded: boolean;
}

function parseSnapshot(raw: string): Progress | null {
  try {
    const parsed = progressSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Live progress over `GET /cases/{id}/events`.
 *
 * `EventSource` rather than fetch-SSE, because this one is a GET and the
 * browser's automatic reconnection is not merely tolerable here but *correct*:
 * every event on this stream is a full snapshot derived from persisted state,
 * so a reconnect is indistinguishable from a first connect.
 *
 * Two failure modes have to be handled or the page lies about what is happening:
 *
 * The stream closes itself after five minutes with a `timeout` event. That is
 * the connection ending, not the work ending, so it is reopened - and only
 * after several reopens does the page fall back to polling.
 *
 * `EventSource` cannot report a 401: it fires an opaque error with no status.
 * So this is only ever opened once a typed `GET /cases/{id}` has already
 * succeeded (the `enabled` flag), which means a session failure has already
 * surfaced properly and a stream error here really is a transport problem.
 */
export function useCaseProgress(caseId: string, enabled: boolean): ProgressStream {
  const client = useQueryClient();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [degraded, setDegraded] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let source: EventSource | null = null;
    let reopens = 0;
    let errors = 0;

    const open = () => {
      if (disposed) return;
      const es = new EventSource(apiUrl(`/cases/${caseId}/events`), { withCredentials: true });
      source = es;

      const snapshot = (event: MessageEvent<string>) => {
        const next = parseSnapshot(event.data);
        if (next) setProgress(next);
        return next;
      };

      es.addEventListener("progress", snapshot);

      es.addEventListener("done", (event: MessageEvent<string>) => {
        snapshot(event);
        es.close();
        // Refresh the fields the stream does not carry - language, page count -
        // and let the report queries refetch now that one exists.
        void client.invalidateQueries({ queryKey: queryKeys.case(caseId) });
      });

      es.addEventListener("timeout", (event: MessageEvent<string>) => {
        snapshot(event);
        es.close();
        if (reopens < MAX_REOPENS) {
          reopens += 1;
          open();
        } else {
          setDegraded(true);
        }
      });

      es.onopen = () => {
        errors = 0;
      };

      es.onerror = () => {
        errors += 1;
        if (errors < MAX_ERRORS) return; // EventSource retries on its own
        es.close();
        setDegraded(true);
      };
    };

    open();

    return () => {
      disposed = true;
      source?.close();
    };
  }, [caseId, enabled, client]);

  return { progress, degraded };
}
