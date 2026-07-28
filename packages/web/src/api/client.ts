/**
 * The only `fetch` in the app.
 *
 * Every response is parsed with the Zod object the API passed to `createRoute`,
 * imported from `@contractix/shared/schemas`. There is no generated client in
 * between to drift out of date, and a contract change surfaces as a
 * `ResponseShapeError` naming the offending field rather than as a blank page.
 */
import { rateLimitErrorSchema, sessionErrorSchema } from "@contractix/shared/schemas";
import { type z } from "zod";

import {
  type ApiError,
  ConflictError,
  HttpError,
  NotFoundError,
  PayloadTooLargeError,
  RateLimitError,
  ResponseShapeError,
  SessionError,
  UnavailableError,
  UnsupportedMediaError,
} from "./errors.js";

/**
 * The API mounts every router at `/`; this prefix exists only so the Vite dev
 * proxy is unambiguous, and it strips it on the way out.
 */
const BASE = "/api";

export interface SendOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  accept?: string;
}

export interface RequestOptions<T extends z.ZodType> extends SendOptions {
  schema: T;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Maps a non-2xx response onto the class the UI knows how to render. */
export async function toApiError(res: Response, path: string): Promise<ApiError> {
  switch (res.status) {
    case 401: {
      const parsed = sessionErrorSchema.safeParse(await readJson(res));
      return parsed.success
        ? new SessionError(parsed.data.error, parsed.data.message)
        : new SessionError("no_session", "You do not have a session yet.");
    }
    case 429: {
      const parsed = rateLimitErrorSchema.safeParse(await readJson(res));
      if (parsed.success) {
        return new RateLimitError({
          scope: parsed.data.scope,
          limit: parsed.data.limit,
          windowSeconds: parsed.data.windowSeconds,
          retryAfterSeconds: parsed.data.retryAfterSeconds,
          message: parsed.data.message,
        });
      }
      // Same-origin, so `Retry-After` is readable without CORS exposeHeaders.
      const header = Number(res.headers.get("retry-after"));
      return new RateLimitError({
        scope: null,
        limit: null,
        windowSeconds: null,
        retryAfterSeconds: Number.isFinite(header) && header > 0 ? header : 60,
        message: "Too many requests in this window. This is a free anonymous demo.",
      });
    }
    // These are all `c.body(null, status)` on the API. Reading the body would
    // only ever produce a parse failure to swallow, so it is never attempted.
    case 404:
      return new NotFoundError(path);
    case 409:
      return new ConflictError(path);
    case 413:
      return new PayloadTooLargeError(path);
    case 415:
      return new UnsupportedMediaError(path);
    case 503:
      return new UnavailableError(path);
    default: {
      const text = await res.text().catch(() => "");
      return new HttpError(res.status, text.slice(0, 300) || `Request failed: ${res.status}`);
    }
  }
}

async function send(path: string, options: SendOptions): Promise<Response> {
  const hasBody = options.body !== undefined;

  // Conditional spreads throughout: `exactOptionalPropertyTypes` rejects an
  // explicit `undefined` for an optional property.
  const init: RequestInit = {
    method: options.method ?? "GET",
    // `same-origin`, not `include`: the dev proxy and Caddy both serve the web
    // and the API from one origin, and `include` would imply a CORS setup this
    // deployment deliberately does not have (CORS_ORIGINS defaults to empty).
    credentials: "same-origin",
    headers: {
      accept: options.accept ?? "application/json",
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw await toApiError(res, path);
  return res;
}

/** A request whose body is parsed against its published schema. */
export async function request<T extends z.ZodType>(
  path: string,
  options: RequestOptions<T>,
): Promise<z.output<T>> {
  const res = await send(path, options);
  const parsed = options.schema.safeParse(await readJson(res));
  if (!parsed.success) throw new ResponseShapeError(path, parsed.error);
  return parsed.data;
}

/** A request with no response body to parse - `DELETE /cases/{id}` returns 204. */
export async function requestVoid(path: string, options: SendOptions = {}): Promise<void> {
  await send(path, options);
}

/** The absolute path a request would hit, for `EventSource` and the PDF viewer. */
export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}
