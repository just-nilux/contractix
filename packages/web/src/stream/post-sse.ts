import { type z } from "zod";

import { apiUrl, toApiError } from "../api/client.js";
import { HttpError } from "../api/errors.js";
import { readSse } from "./read-sse.js";
import { type SseFrame } from "./sse.js";

/**
 * `POST` + Server-Sent Events, for `ask` and `narrative`.
 *
 * `EventSource` cannot do this - it only issues GETs and cannot set a request
 * body - so these two streams go through `fetch` and the hand-rolled framing.
 *
 * A non-2xx goes through the same status mapper as every other request, so a
 * caller catches the same typed errors here as anywhere else. That matters most
 * for 429: `ask` allows five per minute, so hitting the burst ceiling is
 * ordinary, and it should surface as a countdown rather than a dead stream.
 */
export async function* postSse(
  path: string,
  options: { body?: unknown; signal?: AbortSignal } = {},
): AsyncGenerator<SseFrame> {
  const hasBody = options.body !== undefined;

  const res = await fetch(apiUrl(path), {
    method: "POST",
    credentials: "same-origin",
    headers: {
      accept: "text/event-stream",
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!res.ok) throw await toApiError(res, path);
  if (!res.body) throw new HttpError(res.status, "The stream arrived with no body");

  yield* readSse(res.body, options.signal);
}

/**
 * Parses one frame against a stream-event union.
 *
 * The wire is not uniform: `token`, `retry` and `restart` carry their own
 * `type` field, while `done` and `error` carry bare bodies because the route
 * serializes the response object itself. Injecting the SSE event name as the
 * discriminator makes one union cover every frame - a no-op for the frames that
 * already carry it.
 *
 * Returns null rather than throwing for anything unrecognised, so a heartbeat,
 * a comment, or an event variant added by a newer server is ignored instead of
 * killing a stream that is otherwise working.
 */
export function parseStreamFrame<T extends z.ZodType>(
  schema: T,
  frame: SseFrame,
): z.output<T> | null {
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;

  const parsed = schema.safeParse({ ...payload, type: frame.event });
  return parsed.success ? parsed.data : null;
}
