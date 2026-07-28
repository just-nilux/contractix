import { isRouteErrorResponse, Link, useRouteError } from "react-router";

/**
 * The route-level fallback. Typed API failures (no session, expired session,
 * rate limited) are rendered by their own screens close to where they happen -
 * this is only for the genuinely unexpected, so it says so plainly rather than
 * guessing at a cause.
 */
export function RouteErrorBoundary() {
  const error = useRouteError();

  const detail = isRouteErrorResponse(error)
    ? `${String(error.status)} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : null;

  return (
    <div className="mx-auto max-w-lg px-6 py-20 text-center">
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
