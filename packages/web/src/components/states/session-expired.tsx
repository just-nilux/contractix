import { Link } from "react-router";

/**
 * ADR-0011: an anonymous tenant's `exp` is the same 24 h the retention job
 * enforces, so an expired session does not mean "log in again" - the documents
 * and everything derived from them have been deleted. Saying so plainly is the
 * honest version, and it is also the privacy promise being kept.
 */
export function SessionExpired() {
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-2xl font-semibold text-slate-900">Your demo session has ended</h1>
      <p className="mt-3 text-slate-600">
        Anonymous sessions last 24 hours. Yours has expired, and the documents you uploaded — along
        with their text, embeddings and analysis — have been permanently deleted.
      </p>
      <p className="mt-2 text-sm text-slate-500">
        That deletion is the point, not a limitation: nothing containing your salary outlives the
        session.
      </p>
      <Link
        to="/"
        className="mt-6 inline-block rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        Start a new session
      </Link>
    </div>
  );
}
