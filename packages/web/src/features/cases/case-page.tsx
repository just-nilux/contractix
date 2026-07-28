import { useQuery } from "@tanstack/react-query";
import { Navigate, useParams } from "react-router";

import { getCase } from "../../api/endpoints.js";
import { queryKeys } from "../../api/queries.js";
import { Spinner } from "../../components/ui/spinner.js";
import { DocumentList } from "./document-list.js";

/**
 * Refetch while anything is still moving. This is the fallback path the
 * streamed version keeps for when the event stream is unavailable, so it is
 * written to be correct on its own: the interval stops as soon as every
 * document is terminal, and every render is derived from persisted state.
 */
const POLL_MS = 2_000;

export function CasePage() {
  const { caseId } = useParams();

  const { data, isPending, error } = useQuery({
    queryKey: queryKeys.case(caseId ?? ""),
    queryFn: ({ signal }) => getCase(caseId ?? "", { signal }),
    enabled: caseId !== undefined,
    refetchInterval: (query) => {
      const docs = query.state.data?.documents ?? [];
      const settled =
        docs.length > 0 &&
        docs.every((d) => d.status === "failed" || d.analysisStatus !== "pending");
      return settled ? false : POLL_MS;
    },
  });

  if (caseId === undefined) return <Navigate to="/" replace />;

  if (isPending) {
    return (
      <p role="status" className="flex items-center gap-2 py-16 text-slate-500">
        <Spinner /> Loading the case…
      </p>
    );
  }

  // SessionError already threw to the route boundary; anything reaching here is
  // a case this session cannot see, which the API reports as 404 rather than
  // leaking that it exists.
  if (error || !data) {
    return (
      <div className="py-16 text-center">
        <h1 className="text-2xl font-semibold text-slate-900">Case not found</h1>
        <p className="mt-3 text-slate-600">
          It may have been deleted, or it belongs to a different session.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{data.title}</h1>
      {/* Deliberately not `retentionDays`: that field is the Phase-4 per-case
          setting and is not what governs an anonymous session. The tenant's
          `exp` is 24 h and the retention job purges on the same number
          (ADR-0011), so 24 h is the promise actually being kept. */}
      <p className="mt-1 text-sm text-slate-500">
        {data.documents.length} {data.documents.length === 1 ? "document" : "documents"} · deleted
        automatically when this session ends, within 24 hours
      </p>

      <div className="mt-8">
        <DocumentList documents={data.documents} />
      </div>
    </div>
  );
}
