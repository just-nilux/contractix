import { type AnalysisPhase } from "@contractix/shared/schemas";

import { Spinner } from "../../components/ui/spinner.js";

const LABELS: Record<AnalysisPhase, string> = {
  queued: "Queued",
  parsing: "Reading the document",
  analyzing: "Extracting and checking",
  ready: "Ready",
  failed: "Failed",
};

const STYLES: Record<AnalysisPhase, string> = {
  queued: "bg-slate-100 text-slate-600",
  parsing: "bg-severity-info-surface text-severity-info",
  analyzing: "bg-severity-info-surface text-severity-info",
  ready: "bg-emerald-50 text-emerald-700",
  failed: "bg-severity-red-surface text-severity-red",
};

const ACTIVE: readonly AnalysisPhase[] = ["parsing", "analyzing"];

export function PhaseChip({ phase }: { phase: AnalysisPhase }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${STYLES[phase]}`}
    >
      {ACTIVE.includes(phase) && <Spinner className="size-3" />}
      {LABELS[phase]}
    </span>
  );
}
