/**
 * One error class per failure the UI renders differently.
 *
 * The point of the hierarchy is that call sites never inspect status codes: a
 * screen catches `RateLimitError` to show a countdown, and `SessionError` is
 * deliberately *not* caught anywhere near the call - it propagates to the shell,
 * which decides between the landing page and the expired-session screen, so
 * ADR-0011's rule lives in exactly one place.
 */
import { type ZodError } from "zod";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export type SessionErrorKind = "no_session" | "session_expired";

/**
 * 401. `no_session` is the *expected* answer on a first visit - only
 * `POST /cases` and `POST /demo/adopt` mint - so it is not an error condition
 * so much as "you have not started yet". `session_expired` means the 24 h
 * anonymous tenant was purged and its documents are genuinely gone.
 */
export class SessionError extends ApiError {
  readonly kind: SessionErrorKind;

  constructor(kind: SessionErrorKind, message: string) {
    super(message, 401);
    this.name = "SessionError";
    this.kind = kind;
  }
}

/** 429. Fields are nullable because a header-only fallback knows less. */
export class RateLimitError extends ApiError {
  readonly scope: "ip" | "tenant" | null;
  readonly limit: number | null;
  readonly windowSeconds: number | null;
  readonly retryAfterSeconds: number;

  constructor(detail: {
    scope: "ip" | "tenant" | null;
    limit: number | null;
    windowSeconds: number | null;
    retryAfterSeconds: number;
    message: string;
  }) {
    super(detail.message, 429);
    this.name = "RateLimitError";
    this.scope = detail.scope;
    this.limit = detail.limit;
    this.windowSeconds = detail.windowSeconds;
    this.retryAfterSeconds = detail.retryAfterSeconds;
  }
}

/** 404. Also what a cross-tenant read returns - existence is never leaked. */
export class NotFoundError extends ApiError {
  constructor(path: string) {
    super(`Not found: ${path}`, 404);
    this.name = "NotFoundError";
  }
}

/** 409. The 10-document case ceiling, or analyze on a document that is not ready. */
export class ConflictError extends ApiError {
  constructor(path: string) {
    super(`Conflict: ${path}`, 409);
    this.name = "ConflictError";
  }
}

/** 413. The 25 MB upload ceiling (FR-1.1). */
export class PayloadTooLargeError extends ApiError {
  constructor(path: string) {
    super(`Too large: ${path}`, 413);
    this.name = "PayloadTooLargeError";
  }
}

/** 415. Not a PDF or a DOCX. */
export class UnsupportedMediaError extends ApiError {
  constructor(path: string) {
    super(`Unsupported media type: ${path}`, 415);
    this.name = "UnsupportedMediaError";
  }
}

/** 503. The demo corpus is not seeded on this deployment. */
export class UnavailableError extends ApiError {
  constructor(path: string) {
    super(`Unavailable: ${path}`, 503);
    this.name = "UnavailableError";
  }
}

/**
 * The response was 2xx but did not match the schema the API publishes for it.
 *
 * Worth its own class: parsing every response against the server's own Zod
 * objects only pays off if a mismatch is *loud*. Without this the UI would
 * render a blank card and the cause would be invisible.
 */
export class ResponseShapeError extends ApiError {
  readonly issues: string[];

  constructor(path: string, error: ZodError) {
    super(`Response from ${path} did not match its published schema`, 200);
    this.name = "ResponseShapeError";
    this.issues = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  }
}

/** Anything else, including the raw-Zod 400 a malformed request produces. */
export class HttpError extends ApiError {
  constructor(status: number, message: string) {
    super(message, status);
    this.name = "HttpError";
  }
}
