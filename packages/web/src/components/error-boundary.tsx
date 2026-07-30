import { isRouteErrorResponse, Link, useRouteError } from "react-router";

import { SessionError } from "../api/errors.js";
import { SessionExpired } from "./states/session-expired.js";

/**
 * The route-level fallback, and the single place ADR-0011's session rule is
 * implemented.
 *
 * Queries are configured to throw `SessionError` rather than return it, so it
 * lands here from anywhere instead of being re-handled per screen: an expired
 * session gets its own explanation, and a missing one sends the visitor back to
 * the only two routes that mint a session. Everything else is genuinely
 * unexpected and says so rather than guessing at a cause.
 */
export function RouteErrorBoundary() {
  const error = useRouteError();

  if (error instanceof SessionError) {
    if (error.kind === "session_expired") return <SessionExpired />;
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <h1 className="text-2xl font-semibold text-slate-900">You do not have a session yet</h1>
        <p className="mt-3 text-slate-600">
          Start with the demo corpus or upload a document, and one is created for you. No signup.
        </p>
        <Link
          to="/"
          className="mt-6 inline-block rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Back to the start
        </Link>
      </div>
    );
  }

  const detail = isRouteErrorResponse(error)
    ? `${String(error.status)} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : null;

  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-2xl font-semibold text-slate-900">Something went wrong</h1>
      <p className="mt-3 text-slate-600">
        This one is on us, not on your document. Nothing you uploaded was changed.
      </p>
      {detail !== null && (
        <p className="mt-4 rounded border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm break-words text-slate-700">
          {detail}
        </p>
      )}
      <Link
        to="/"
        className="mt-6 inline-block rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        Back to the start
      </Link>
    </div>
  );
}
