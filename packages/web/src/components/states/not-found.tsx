import { Link } from "react-router";

export function NotFound() {
  return (
    <div className="mx-auto max-w-lg px-6 py-20 text-center">
      <h1 className="text-2xl font-semibold text-slate-900">Nothing here</h1>
      <p className="mt-3 text-slate-600">That address does not match anything in the app.</p>
      <Link
        to="/"
        className="mt-6 inline-block rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        Back to the start
      </Link>
    </div>
  );
}
