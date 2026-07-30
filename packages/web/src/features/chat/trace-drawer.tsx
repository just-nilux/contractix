import { type AgentTrace, type TraceStep } from "@contractix/shared/schemas";

import { ClauseLink } from "../../citations/clause-link.js";
import { Button } from "../../components/ui/button.js";
import { type TurnResult } from "../../stream/ask-reducer.js";

/** A turn whose trace survived — the only kind this drawer can be opened for. */
export type TracedResult = TurnResult & { trace: AgentTrace };

export function hasTrace(result: TurnResult): result is TracedResult {
  return result.trace !== null;
}

function formatEur(value: number): string {
  // Four decimals: a Q&A turn costs well under a cent, and €0.00 would read as
  // free rather than as small.
  return `€${value.toFixed(4)}`;
}

function StepRow({ step }: { step: TraceStep }) {
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-xs text-slate-900">{step.tool}</span>
        <span className="text-xs text-slate-500">
          turn {step.turn} · {step.durationMs} ms
          {step.ok ? "" : " · failed"}
        </span>
      </div>

      {/* Model-authored, echoed as text. Never a markdown or HTML renderer
          here: an uploaded contract can put anything in the arguments the
          model chooses (FR-7.5). React escapes it; keep it that way. */}
      <pre className="mt-2 overflow-x-auto rounded bg-slate-50 px-2 py-1.5 text-[0.7rem] break-words whitespace-pre-wrap text-slate-600">
        {JSON.stringify(step.input)}
      </pre>

      {step.clauses.length > 0 && (
        <div className="mt-2">
          <p className="text-xs text-slate-500">
            Surfaced {step.clauses.length} {step.clauses.length === 1 ? "clause" : "clauses"}:
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {step.clauses.map((c) => (
              <ClauseLink
                key={c.clauseId}
                target={{
                  documentId: c.documentId,
                  clauseId: c.clauseId,
                  page: c.page,
                  charStart: null,
                  charEnd: null,
                  verbatimAnchor: null,
                }}
                title={c.serializedClauseId}
                className="max-w-full truncate rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-[0.7rem] text-slate-700 hover:border-slate-400 hover:bg-slate-100"
              >
                {c.heading ?? c.clauseRef} · p{c.page}
              </ClauseLink>
            ))}
          </div>
        </div>
      )}

      {step.clauses.length === 0 && step.clauseCount === 0 && (
        <p className="mt-2 text-xs text-slate-400">Surfaced no clauses.</p>
      )}
    </li>
  );
}

/**
 * FR-6.1's "show your work" view: the tool calls, the clauses each one
 * surfaced, what the grounding validator rejected, and what the turn cost.
 *
 * Sits at `z-30`, deliberately *under* `ViewerDrawer`'s `z-40`, so clicking a
 * clause here stacks the document on top and closing it returns you to the
 * trace rather than to the page.
 */
export function TraceDrawer({
  response,
  onClose,
}: {
  response: TracedResult;
  onClose: () => void;
}) {
  const { trace, usage } = response;
  const keyless = usage.inputTokens === 0 && usage.outputTokens === 0;

  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <button
        type="button"
        aria-label="Close the trace"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/30"
      />

      <aside
        aria-label="Answer trace"
        className="relative flex h-full w-full max-w-2xl flex-col overflow-y-auto border-l border-slate-200 bg-slate-50 shadow-xl"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-slate-50/95 px-5 py-3 backdrop-blur">
          <h2 className="text-sm font-medium text-slate-900">Answer trace</h2>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="space-y-6 p-5">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <dt className="text-slate-500">Model</dt>
            <dd className="font-mono text-slate-900">{trace.model}</dd>
            <dt className="text-slate-500">Turns</dt>
            <dd className="text-slate-900">{trace.turns}</dd>
            <dt className="text-slate-500">Stopped because</dt>
            <dd className="font-mono text-slate-900">{trace.stopReason}</dd>
            <dt className="text-slate-500">Grounding</dt>
            <dd className="text-slate-900">
              {response.grounded ? "every claim tied to a clause" : "some claims unverified"}
              {response.corrected ? " · regenerated once" : ""}
            </dd>
          </dl>

          <section>
            <h3 className="text-xs font-medium tracking-wide text-slate-500 uppercase">
              Tool calls
            </h3>
            {trace.steps.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">
                The agent answered without calling a tool.
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {trace.steps.map((step, i) => (
                  <StepRow key={`${String(i)}:${step.tool}`} step={step} />
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-slate-500">
              {trace.citableClauseIds.length}{" "}
              {trace.citableClauseIds.length === 1 ? "clause was" : "clauses were"} citable — a
              marker naming anything else is rejected.
            </p>
          </section>

          {/* The most persuasive thing here, and until now it existed only in a
              database column: proof the grounding contract actually bites. */}
          {trace.corrections.length > 0 && (
            <section>
              <h3 className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                What the validator rejected
              </h3>
              {trace.corrections.map((c) => (
                <div
                  key={c.turn}
                  className="mt-2 rounded-lg border border-severity-amber-border bg-severity-amber-surface p-3 text-sm"
                >
                  <p className="text-xs text-severity-amber">Turn {c.turn}</p>
                  {c.uncited.length > 0 && (
                    <>
                      <p className="mt-2 text-xs text-slate-500">Sentences carrying no citation:</p>
                      <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-700">
                        {c.uncited.map((s, i) => (
                          <li key={`${String(i)}:${s}`}>{s}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  {c.unresolvedMarkers.length > 0 && (
                    <>
                      <p className="mt-2 text-xs text-slate-500">
                        Markers naming a clause no tool surfaced:
                      </p>
                      <ul className="mt-1 list-disc space-y-1 pl-5 font-mono text-xs text-slate-700">
                        {c.unresolvedMarkers.map((m, i) => (
                          <li key={`${String(i)}:${m}`}>{m}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              ))}
            </section>
          )}

          <section>
            <h3 className="text-xs font-medium tracking-wide text-slate-500 uppercase">
              Tokens and cost
            </h3>
            {keyless ? (
              // Rendering €0.0000 as a measurement would be the first dishonest
              // number in this codebase.
              <p className="mt-2 text-sm text-slate-500">
                This deployment is running without a model key, so the answer came from the keyless
                stand-in. There are no tokens to count and nothing was spent.
              </p>
            ) : (
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <dt className="text-slate-500">Input tokens</dt>
                <dd className="text-slate-900">{usage.inputTokens.toLocaleString()}</dd>
                <dt className="text-slate-500">Output tokens</dt>
                <dd className="text-slate-900">{usage.outputTokens.toLocaleString()}</dd>
                <dt className="text-slate-500">Cost</dt>
                <dd className="text-slate-900">{formatEur(usage.costEur)}</dd>
                <dt className="text-slate-500">Latency</dt>
                <dd className="text-slate-900">{usage.latencyMs.toLocaleString()} ms</dd>
              </dl>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}
