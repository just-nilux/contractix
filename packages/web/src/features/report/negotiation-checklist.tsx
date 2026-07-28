import { type ReportFlag } from "@contractix/shared/schemas";

import { CitationList } from "./citation-chip.js";

const SEVERITY_DOT: Record<ReportFlag["severity"], string> = {
  red: "bg-severity-red",
  amber: "bg-severity-amber",
  info: "bg-severity-info",
};

/**
 * PRD §9's negotiation checklist: every flag that came with something to ask
 * for, in the severity order the rules engine already decided.
 *
 * Derived from the flags rather than generated: a checklist the model wrote
 * could recommend something no rule actually found, and every line here is
 * traceable to a rule id and a clause.
 */
export function NegotiationChecklist({
  flags,
  documentId,
}: {
  flags: readonly ReportFlag[];
  documentId: string;
}) {
  const actionable = flags.filter((f) => f.negotiationHint !== null);
  if (actionable.length === 0) return null;

  return (
    <ol className="space-y-3">
      {actionable.map((flag) => (
        <li key={flag.ruleId} className="flex gap-3">
          <span
            aria-hidden="true"
            className={`mt-1.5 size-2 shrink-0 rounded-full ${SEVERITY_DOT[flag.severity]}`}
          />
          <div className="min-w-0">
            <p className="text-sm text-slate-900">{flag.negotiationHint}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <code className="text-xs text-slate-400">{flag.ruleId}</code>
              <CitationList citations={flag.citations} documentId={documentId} />
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
