/**
 * One typed function per API route. No React here - these are plain async
 * functions so the streaming hooks and the Query hooks can share them, and so
 * a test can call one without a renderer.
 *
 * Each names the schema the API publishes for that route; that pairing is the
 * whole contract.
 */
import {
  analyzeAcceptedSchema,
  caseAnalyzeAcceptedSchema,
  caseListSchema,
  caseReportSchema,
  caseSchema,
  caseWithDocumentsSchema,
  clauseContextSchema,
  clauseSchema,
  demoAdoptSchema,
  demoCatalogSchema,
  documentLayoutSchema,
  documentReportSchema,
  documentSchema,
  narrativeSchema,
  searchResponseSchema,
} from "@contractix/shared/schemas";

import { apiUrl, request, requestVoid, type SendOptions } from "./client.js";

type Opts = Pick<SendOptions, "signal">;

const sig = (o: Opts | undefined) => (o?.signal ? { signal: o.signal } : {});

// --- demo ---------------------------------------------------------------------

/** Public: the one endpoint that answers without a session. */
export function getDemoCatalog(opts?: Opts) {
  return request("/demo", { schema: demoCatalogSchema, ...sig(opts) });
}

/** Mints a session and clones the corpus into it (ADR-0011). Idempotent. */
export function adoptDemo(opts?: Opts) {
  return request("/demo/adopt", { schema: demoAdoptSchema, method: "POST", ...sig(opts) });
}

// --- cases --------------------------------------------------------------------

/** Mints a session when there is none. */
export function createCase(title: string, opts?: Opts) {
  return request("/cases", { schema: caseSchema, method: "POST", body: { title }, ...sig(opts) });
}

export function listCases(opts?: Opts) {
  return request("/cases", { schema: caseListSchema, ...sig(opts) });
}

export function getCase(caseId: string, opts?: Opts) {
  return request(`/cases/${caseId}`, { schema: caseWithDocumentsSchema, ...sig(opts) });
}

/** Hard delete: files, clauses, embeddings, extractions, flags, Q&A turns. */
export function deleteCase(caseId: string, opts?: Opts) {
  return requestVoid(`/cases/${caseId}`, { method: "DELETE", ...sig(opts) });
}

// --- documents ----------------------------------------------------------------

export function getDocument(documentId: string, opts?: Opts) {
  return request(`/documents/${documentId}`, { schema: documentSchema, ...sig(opts) });
}

/**
 * Page sizes and block rectangles against the same frozen char offsets every
 * citation uses. `geometry: false` means DOCX or a missing sidecar - a shape the
 * viewer handles, not an error.
 */
export function getDocumentLayout(documentId: string, opts?: Opts) {
  return request(`/documents/${documentId}/layout`, { schema: documentLayoutSchema, ...sig(opts) });
}

/** Not fetched here - handed to the PDF viewer, which streams it itself. */
export function documentFileUrl(documentId: string): string {
  return apiUrl(`/documents/${documentId}/file`);
}

// --- reports ------------------------------------------------------------------

export function getDocumentReport(documentId: string, opts?: Opts) {
  return request(`/documents/${documentId}/report`, { schema: documentReportSchema, ...sig(opts) });
}

export function getCaseReport(caseId: string, opts?: Opts) {
  return request(`/cases/${caseId}/report`, { schema: caseReportSchema, ...sig(opts) });
}

/** 202. Only `ready` documents are enqueued, so `enqueued` may legitimately be 0. */
export function analyzeCase(caseId: string, opts?: Opts) {
  return request(`/cases/${caseId}/analyze`, {
    schema: caseAnalyzeAcceptedSchema,
    method: "POST",
    ...sig(opts),
  });
}

export function analyzeDocument(documentId: string, opts?: Opts) {
  return request(`/documents/${documentId}/analyze`, {
    schema: analyzeAcceptedSchema,
    method: "POST",
    ...sig(opts),
  });
}

// --- clauses and search -------------------------------------------------------

/**
 * Needed by the viewer for more than display: a flag citation carries
 * `charStart: null`, so the clause's own frozen offsets are what the whole-clause
 * highlight resolves against.
 */
export function getClause(clauseId: string, opts?: Opts) {
  return request(`/clauses/${clauseId}`, { schema: clauseSchema, ...sig(opts) });
}

export function getClauseContext(clauseId: string, radius = 1, opts?: Opts) {
  return request(`/clauses/${clauseId}/context?radius=${String(radius)}`, {
    schema: clauseContextSchema,
    ...sig(opts),
  });
}

export function searchCase(
  caseId: string,
  query: string,
  params: { documentId?: string; topK?: number } = {},
  opts?: Opts,
) {
  const search = new URLSearchParams({ q: query });
  if (params.documentId) search.set("doc_id", params.documentId);
  if (params.topK !== undefined) search.set("top_k", String(params.topK));
  return request(`/cases/${caseId}/search?${search.toString()}`, {
    schema: searchResponseSchema,
    ...sig(opts),
  });
}

// --- narrative ----------------------------------------------------------------

/**
 * The cheap read half of the documented GET-then-POST-on-404 pattern; 404 means
 * no narrative has been generated yet, which is a state, not a failure.
 */
export function getNarrative(caseId: string, documentId?: string, opts?: Opts) {
  const qs = documentId ? `?document_id=${documentId}` : "";
  return request(`/cases/${caseId}/narrative${qs}`, { schema: narrativeSchema, ...sig(opts) });
}
