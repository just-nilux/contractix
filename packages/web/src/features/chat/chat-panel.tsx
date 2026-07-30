import { ASK_QUESTION_MAX_CHARS, DISCLAIMER } from "@contractix/shared/schemas";
import { type FormEvent, useId, useState } from "react";

import { RateLimitedNotice } from "../../components/states/rate-limited.js";
import { Button } from "../../components/ui/button.js";
import { useAskStream } from "../../stream/use-ask-stream.js";
import { ChatTurn } from "./chat-turn.js";
import { TraceDrawer, type TracedResult } from "./trace-drawer.js";

/**
 * German and English, because the demo corpus is both and the first thing a
 * visitor learns from these is that the questions may be in either.
 */
const EXAMPLES = [
  "Wie lang ist die Probezeit?",
  "What happens to my equity if I am a bad leaver?",
  "Ist das nachvertragliche Wettbewerbsverbot wirksam?",
];

/**
 * FR-5.1's agentic Q&A, as PRD §9's "ask a question" panel.
 *
 * Available as soon as documents are ingested rather than only once analysis
 * has run: the agent's retrieval tools work over clauses, and FR-1.2 makes Q&A
 * the *only* analysis surface for a document classified `other` - which is
 * every document when the deployment has no model key.
 */
export function ChatPanel({ caseId }: { caseId: string }) {
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const [traceFor, setTraceFor] = useState<TracedResult | null>(null);
  const stream = useAskStream(caseId);

  const submit = (question: string) => {
    const trimmed = question.trim();
    if (trimmed === "" || stream.running) return;
    stream.ask(trimmed);
    setDraft("");
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(draft);
  };

  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold tracking-tight text-slate-900">Ask a question</h2>
      <p className="mt-1 text-sm text-slate-500">
        Answers are assembled from your documents, and every factual sentence carries a citation you
        can click through to the clause it came from.
      </p>

      {stream.turns.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-slate-300 px-4 py-6">
          <p className="text-sm text-slate-500">Nothing asked yet. For example:</p>
          <ul className="mt-3 space-y-2">
            {EXAMPLES.map((q) => (
              <li key={q}>
                <button
                  type="button"
                  onClick={() => {
                    submit(q);
                  }}
                  className="rounded border border-slate-300 bg-slate-50 px-2.5 py-1 text-left text-sm text-slate-700 hover:border-slate-400 hover:bg-slate-100"
                >
                  {q}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ul className="mt-4 space-y-5 rounded-lg border border-slate-200 p-6">
          {stream.turns.map((turn) => (
            <ChatTurn key={turn.id} turn={turn} onShowTrace={setTraceFor} />
          ))}
        </ul>
      )}

      {/* Local state, not a provider: a trace belongs to one turn on one page,
          unlike a citation target, which four surfaces can open. */}
      {traceFor && (
        <TraceDrawer
          response={traceFor}
          onClose={() => {
            setTraceFor(null);
          }}
        />
      )}

      {stream.rateLimit && (
        <div className="mt-4">
          <RateLimitedNotice error={stream.rateLimit} action="Asking a question" />
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-4">
        <label htmlFor={inputId} className="sr-only">
          Your question
        </label>
        <textarea
          id={inputId}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line. Not while composing: an
            // IME commit is an Enter too, and sending mid-word would be worse
            // for exactly the German input this is built for.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit(draft);
            }
          }}
          rows={2}
          maxLength={ASK_QUESTION_MAX_CHARS}
          placeholder="Was gilt bei einer Kündigung in der Probezeit?"
          className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-xs text-slate-500">{DISCLAIMER}</p>
          {stream.running ? (
            <Button variant="secondary" onClick={stream.stop}>
              Stop
            </Button>
          ) : (
            <Button type="submit" disabled={draft.trim().length === 0}>
              Ask
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}
