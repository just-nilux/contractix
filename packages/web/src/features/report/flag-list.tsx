import { type ReportFlag } from "@contractix/shared/schemas";

import { CitationList } from "./citation-chip.js";

const SEVERITY_STYLE: Record<ReportFlag["severity"], string> = {
  red: "border-severity-red-border bg-severity-red-surface",
  amber: "border-severity-amber-border bg-severity-amber-surface",
  info: "border-severity-info-border bg-severity-info-surface",
};

const SEVERITY_BADGE: Record<ReportFlag["severity"], string> = {
  red: "bg-severity-red text-white",
  amber: "bg-severity-amber text-white",
  info: "bg-severity-info text-white",
};

const SEVERITY_LABEL: Record<ReportFlag["severity"], string> = {
  red: "Red flag",
  amber: "Worth negotiating",
  info: "For information",
};

function FlagCard({ flag, documentId }: { flag: ReportFlag; documentId: string }) {
  return (
    <li className={`rounded-lg border p-4 ${SEVERITY_STYLE[flag.severity]}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${SEVERITY_BADGE[flag.severity]}`}
        >
          {SEVERITY_LABEL[flag.severity]}
        </span>
        <code className="text-xs text-slate-500">
          {flag.ruleId}@{flag.ruleVersion}
        </code>
      </div>

      <p className="mt-3 text-sm text-slate-800">{flag.rationale}</p>

      {flag.negotiationHint !== null && (
        <p className="mt-3 text-sm font-medium text-slate-900">Ask for: {flag.negotiationHint}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500">
        {flag.sources.length > 0 && (
          <span>
            {/* Pointers, not determinations — the wording FR-7.6 asks for. */}
            Statutory reference: {flag.sources.join(", ")}
          </span>
        )}
        <CitationList citations={flag.citations} documentId={documentId} />
      </div>
    </li>
  );
}

export function FlagList({
  flags,
  documentId,
  emptyNote,
}: {
  flags: readonly ReportFlag[];
  documentId: string;
  emptyNote?: string;
}) {
  if (flags.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
        No rules fired for this document.
        {emptyNote !== undefined && <span className="mt-1 block">{emptyNote}</span>}
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {/* Already sorted red → amber → info by the report service. Re-sorting here
          would be a second opinion on severity that this file has no business
          having. */}
      {flags.map((flag) => (
        <FlagCard key={`${flag.ruleId}@${flag.ruleVersion}`} flag={flag} documentId={documentId} />
      ))}
    </ul>
  );
}
