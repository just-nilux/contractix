import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { listCases } from "../../api/endpoints.js";
import { SessionError } from "../../api/errors.js";
import { queryKeys } from "../../api/queries.js";

/**
 * The only screen where a 401 is the *expected* answer: a first-time visitor
 * has no session, because only `POST /cases` and `POST /demo/adopt` mint one.
 * So this opts out of the global throw-on-session-error and renders nothing
 * rather than treating "you haven't started yet" as a failure.
 */
export function YourCases() {
  const { data, error } = useQuery({
    queryKey: queryKeys.cases,
    queryFn: ({ signal }) => listCases({ signal }),
    throwOnError: false,
    retry: false,
  });

  if (error instanceof SessionError) return null;
  if (!data || data.cases.length === 0) return null;

  return (
    <section className="mt-12">
      <h2 className="text-sm font-medium tracking-wide text-slate-500 uppercase">Your cases</h2>
      <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
        {data.cases.map((c) => (
          <li key={c.id}>
            <Link
              to={`/cases/${c.id}`}
              className="flex items-baseline justify-between gap-4 px-4 py-3 hover:bg-slate-50"
            >
              <span className="truncate font-medium text-slate-900">{c.title}</span>
              <span className="shrink-0 text-sm text-slate-500">
                {c.documentCount} {c.documentCount === 1 ? "document" : "documents"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
