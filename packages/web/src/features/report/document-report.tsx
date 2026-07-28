import { type DocumentReport } from "@contractix/shared/schemas";

import { FlagList } from "./flag-list.js";
import { NegotiationChecklist } from "./negotiation-checklist.js";
import { TermsTable } from "./terms-table.js";

const TYPE_LABELS: Record<string, string> = {
  employment_offer: "Employment offer",
  employment_contract: "Employment contract",
  vsop_esop_agreement: "VSOP / ESOP agreement",
  term_sheet: "Term sheet",
  shareholders_agreement: "Shareholders' agreement",
  side_letter: "Side letter",
  other: "Unclassified",
};

function Count({ label, value, className }: { label: string; value: number; className?: string }) {
  return (
    <span className={`inline-flex items-baseline gap-1.5 ${className ?? ""}`}>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-slate-500">{label}</span>
    </span>
  );
}

export function DocumentReportView({ report }: { report: DocumentReport }) {
  const { document: doc, summary, flags, extraction } = report;
  const documentId = doc.id;

  return (
    <section className="rounded-lg border border-slate-200 p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{doc.filename}</h2>
          <p className="mt-0.5 text-sm text-slate-500">
            {doc.type ? (TYPE_LABELS[doc.type] ?? doc.type) : "Unclassified"}
            {doc.language ? ` · ${doc.language.toUpperCase()}` : ""}
            {doc.pageCount !== null ? ` · ${String(doc.pageCount)} pages` : ""}
          </p>
        </div>
        <div className="flex items-baseline gap-5">
          <Count label="red" value={summary.flagCounts.red} className="text-severity-red" />
          <Count label="amber" value={summary.flagCounts.amber} className="text-severity-amber" />
          <Count label="info" value={summary.flagCounts.info} className="text-severity-info" />
          <Count label="terms found" value={summary.extractedFieldCount} />
          <Count label="not in document" value={summary.notFoundCount} />
        </div>
      </header>

      <div className="mt-6">
        <h3 className="text-sm font-medium tracking-wide text-slate-500 uppercase">
          What to look at
        </h3>
        <div className="mt-3">
          <FlagList
            flags={flags}
            documentId={documentId}
            {...(extraction === null
              ? {
                  emptyNote:
                    "The rules engine checks extracted terms, and this document type has no extraction schema.",
                }
              : {})}
          />
        </div>
      </div>

      <div className="mt-8">
        <h3 className="text-sm font-medium tracking-wide text-slate-500 uppercase">Terms</h3>
        <div className="mt-3">
          {extraction === null ? (
            <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
              No structured extraction applies to this document type. It can still be searched and
              asked about.
            </p>
          ) : (
            <TermsTable extraction={extraction} documentId={documentId} />
          )}
        </div>
      </div>

      {flags.some((f) => f.negotiationHint !== null) && (
        <div className="mt-8">
          <h3 className="text-sm font-medium tracking-wide text-slate-500 uppercase">
            Negotiation checklist
          </h3>
          <div className="mt-3">
            <NegotiationChecklist flags={flags} documentId={documentId} />
          </div>
        </div>
      )}
    </section>
  );
}
