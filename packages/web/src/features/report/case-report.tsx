import { useCaseReport } from "../../api/queries.js";
import { Spinner } from "../../components/ui/spinner.js";
import { DocumentReportView } from "./document-report.js";

/**
 * The whole case's report. Rendered inline under the progress panel rather than
 * on its own route, so a case where one document is still analyzing stays
 * readable for the ones that are done.
 */
export function CaseReportView({ caseId, enabled }: { caseId: string; enabled: boolean }) {
  const { data, isPending, error } = useCaseReport(caseId, enabled);

  if (!enabled) return null;

  if (isPending) {
    return (
      <p role="status" className="flex items-center gap-2 py-8 text-slate-500">
        <Spinner /> Assembling the report…
      </p>
    );
  }

  if (error || !data) return null;

  const analyzed = data.documents.filter((d) => d.document.analysisStatus === "analyzed");
  if (analyzed.length === 0) return null;

  return (
    <div className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="text-xl font-semibold tracking-tight text-slate-900">Report</h2>
        <p className="text-sm text-slate-500">
          <span className="font-medium text-severity-red">{data.summary.flagCounts.red} red</span>
          {" · "}
          <span className="text-severity-amber">{data.summary.flagCounts.amber} amber</span>
          {" · "}
          <span className="text-severity-info">{data.summary.flagCounts.info} info</span>
          {" across "}
          {data.summary.documentCount} {data.summary.documentCount === 1 ? "document" : "documents"}
        </p>
      </div>

      {/* The API's own sentence, not a copy of it. */}
      <p className="mt-2 text-xs text-slate-500">{data.disclaimer}</p>

      <div className="mt-6 space-y-6">
        {analyzed.map((report) => (
          <DocumentReportView key={report.document.id} report={report} />
        ))}
      </div>
    </div>
  );
}
