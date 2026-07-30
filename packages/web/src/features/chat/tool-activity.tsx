import { type ToolActivity } from "../../stream/ask-reducer.js";
import { Spinner } from "../../components/ui/spinner.js";

/**
 * Plain-English names for the agent's tools. A reader watching the wait should
 * see what is happening, not the wire protocol - and the tool names themselves
 * are in the trace drawer for anyone who wants them.
 */
const RUNNING: Record<string, string> = {
  search_clauses: "Searching the clauses",
  get_clause: "Reading a clause",
  get_clause_context: "Reading around a clause",
  get_extraction: "Checking the extracted terms",
  run_benchmark: "Running the red-flag rules",
  compare_documents: "Comparing documents",
  math: "Doing the arithmetic",
};

function label(name: string): string {
  return RUNNING[name] ?? `Calling ${name}`;
}

/**
 * What the agent is reaching for, live (FR-5.5).
 *
 * The point is that a fifteen-second wait is legible rather than a spinner: the
 * reader can see retrieval happen, and that the answer is being assembled from
 * their documents rather than invented.
 */
export function ToolActivityList({ activity }: { activity: readonly ToolActivity[] }) {
  if (activity.length === 0) return null;

  return (
    <ul className="mt-2 space-y-1 text-xs text-slate-500">
      {activity.map((a, i) => (
        <li key={`${String(i)}:${a.name}`} className="flex items-center gap-2">
          {a.ok === null ? (
            <Spinner className="size-3 text-slate-400" />
          ) : (
            <span aria-hidden className={a.ok ? "text-slate-400" : "text-severity-red"}>
              {a.ok ? "·" : "×"}
            </span>
          )}
          <span>{label(a.name)}</span>
          {a.ok === true && a.clauseCount !== null && (
            <span className="text-slate-400">
              {a.clauseCount === 0
                ? "— nothing matched"
                : `— ${String(a.clauseCount)} ${a.clauseCount === 1 ? "clause" : "clauses"}`}
            </span>
          )}
          {a.ok === false && <span className="text-severity-red">— failed</span>}
        </li>
      ))}
    </ul>
  );
}
