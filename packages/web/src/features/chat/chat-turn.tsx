import { CouldNotVerify } from "../../citations/could-not-verify.js";
import { MarkdownView } from "../../citations/markdown-view.js";
import { Spinner } from "../../components/ui/spinner.js";
import { type AskTurn } from "../../stream/ask-reducer.js";
import { hasTrace, type TracedResult } from "./trace-drawer.js";
import { ToolActivityList } from "./tool-activity.js";

/** One question and its answer. */
export function ChatTurn({
  turn,
  onShowTrace,
}: {
  turn: AskTurn;
  onShowTrace: (response: TracedResult) => void;
}) {
  const streaming = turn.status === "streaming" || turn.status === "correcting";
  const traced = turn.result && hasTrace(turn.result) ? turn.result : null;

  return (
    <li className="border-t border-slate-200 pt-5 first:border-0 first:pt-0">
      <p className="font-medium text-slate-900">{turn.question}</p>

      <ToolActivityList activity={turn.activity} />

      {turn.status === "correcting" && (
        <p role="status" className="mt-2 flex items-center gap-2 text-sm text-severity-amber">
          <Spinner className="size-4" />
          Re-checking citations
          {turn.retryReason === null ? "" : ` — ${turn.retryReason}`}
        </p>
      )}

      {turn.status === "error" && turn.error !== null && (
        <p className="mt-3 rounded border border-severity-red-border bg-severity-red-surface px-3 py-2 text-sm text-severity-red">
          {turn.error}
        </p>
      )}

      {turn.answer !== "" && (
        <div className="mt-3">
          <MarkdownView
            markdown={turn.answer}
            citations={turn.result?.citations ?? []}
            // Citations arrive with `done`; until then an unmatched marker
            // means nothing, and flagging it would paint a live answer amber.
            citationsKnown={turn.result !== null}
          />
          {streaming && <Spinner className="mt-2 size-4 text-slate-400" />}
        </div>
      )}

      {turn.result && <CouldNotVerify claims={turn.result.couldNotVerify} />}

      {turn.result && (
        <div className="mt-3 flex flex-wrap items-baseline justify-between gap-3">
          <p className="text-xs text-slate-500">
            {turn.result.grounded ? "Every claim tied to a clause" : "Some claims unverified"}
            {turn.result.corrected ? " · regenerated once" : ""}
          </p>
          {/* Absent rather than broken for a turn an older deploy wrote, whose
              trace no longer parses. The answer and its citations are intact. */}
          {traced && (
            <button
              type="button"
              onClick={() => {
                onShowTrace(traced);
              }}
              className="text-xs text-slate-500 underline underline-offset-2 hover:text-slate-900"
            >
              Show the trace
            </button>
          )}
        </div>
      )}
    </li>
  );
}
