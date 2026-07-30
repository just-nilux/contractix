import { type DocumentReport, type ReportField } from "@contractix/shared/schemas";

import { inSchemaOrder } from "../../lib/extraction-order.js";
import { labelFor } from "../../lib/field-labels.js";
import { formatValue } from "../../lib/format-value.js";
import { CitationList } from "./citation-chip.js";

const CONFIDENCE_STYLE: Record<ReportField["confidence"], string> = {
  high: "text-slate-500",
  medium: "text-severity-amber",
  low: "text-severity-red",
};

function ValueCell({ field }: { field: ReportField }) {
  if (field.status === "not_found") {
    // FR-3: a term the document does not contain is a first-class answer, not a
    // blank. A blank cell reads as "we didn't look".
    return (
      <span
        title="The document does not contain this term. Reported, never inferred."
        className="text-slate-400 italic"
      >
        not found in document
      </span>
    );
  }

  if (field.status === "extraction_failed") {
    return (
      <span
        title="The model could not produce a valid value for this field, even after a repair pass."
        className="text-severity-amber"
      >
        could not be extracted
      </span>
    );
  }

  return <span className="text-slate-900">{formatValue(field.value, field.unit)}</span>;
}

export function TermsTable({
  extraction,
  documentId,
}: {
  extraction: NonNullable<DocumentReport["extraction"]>;
  documentId: string;
}) {
  const fields = inSchemaOrder(extraction.fields, extraction.schemaVer);

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs tracking-wide text-slate-500 uppercase">
            <th scope="col" className="py-2 pr-4 font-medium">
              Term
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Value
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Confidence
            </th>
            <th scope="col" className="py-2 font-medium">
              Source
            </th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => (
            <tr key={field.fieldPath} className="border-b border-slate-100 align-top">
              <th scope="row" className="py-2 pr-4 text-left font-normal text-slate-600">
                {labelFor(field.fieldPath)}
              </th>
              <td className="py-2 pr-4">
                <ValueCell field={field} />
              </td>
              <td className={`py-2 pr-4 text-xs ${CONFIDENCE_STYLE[field.confidence]}`}>
                {field.status === "extracted" ? field.confidence : "—"}
              </td>
              <td className="py-2">
                <CitationList citations={field.citations} documentId={documentId} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
