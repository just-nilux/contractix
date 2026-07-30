/**
 * HTTP response shapes, shared between the API that declares them and the web
 * app that consumes them (PRD §8: "Zod as single source of truth for API,
 * tools, extraction schemas", taken literally).
 *
 * The API passes these to `createRoute`, so they *are* the OpenAPI contract;
 * the web `.parse()`s responses with the same objects, which gives the client
 * runtime validation against the exact schema the server published, with no
 * generated artefact in between to drift out of date.
 *
 * Everything reachable from this directory must stay browser-safe - an eslint
 * rule bans `node:*` imports here, because the package root pulls `node:fs` via
 * the models loader and the web cannot import that.
 */
import { z } from "zod";

import { agentTraceSchema, narrativeTraceSchema } from "./trace.js";

/**
 * FR-7.6 - every surface that emits analysis says what it is. Lives here rather
 * than in each route because the web renders the same sentence in its first-run
 * gate, and a disclaimer that drifts between the modal and the report is worse
 * than no disclaimer at all.
 */
export const DISCLAIMER =
  "Informational analysis, not legal or tax advice. Statutory references are pointers, not determinations.";

// --- citations, fields, flags -------------------------------------------------

export const reportCitationSchema = z.object({
  clauseId: z.uuid(),
  /** The canonical "{documentId}:{page}:{path}" id (ADR-0005). */
  serializedClauseId: z.string(),
  clauseRef: z.string(),
  page: z.number().int(),
  heading: z.string().nullable(),
  /** Present for extraction citations (the resolved span); null for whole-clause flag citations. */
  charStart: z.number().int().nullable(),
  charEnd: z.number().int().nullable(),
  verbatimAnchor: z.string().nullable(),
});
export type ReportCitation = z.infer<typeof reportCitationSchema>;

export const reportFieldSchema = z.object({
  fieldPath: z.string(),
  value: z.unknown(),
  unit: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  /** `not_found` is a first-class value, never an inference (FR-3, PRD §9). */
  status: z.enum(["extracted", "not_found", "extraction_failed"]),
  citations: z.array(reportCitationSchema),
});
export type ReportField = z.infer<typeof reportFieldSchema>;

export const reportFlagSchema = z.object({
  ruleId: z.string(),
  ruleVersion: z.string(),
  severity: z.enum(["red", "amber", "info"]),
  rationale: z.string(),
  negotiationHint: z.string().nullable(),
  sources: z.array(z.string()),
  citations: z.array(reportCitationSchema),
});
export type ReportFlag = z.infer<typeof reportFlagSchema>;

export const flagCountsSchema = z.object({
  red: z.number().int(),
  amber: z.number().int(),
  info: z.number().int(),
});

// --- reports ------------------------------------------------------------------

/** FR-6.2's `GET /documents/:id/extraction` - the report's extraction slice. */
export const documentExtractionSchema = z.object({
  documentId: z.uuid(),
  disclaimer: z.string(),
  extraction: z.object({ schemaVer: z.string(), fields: z.array(reportFieldSchema) }).nullable(),
});
export type DocumentExtraction = z.infer<typeof documentExtractionSchema>;

export const documentReportSchema = z.object({
  document: z.object({
    id: z.uuid(),
    caseId: z.uuid(),
    filename: z.string(),
    type: z.string().nullable(),
    language: z.string().nullable(),
    status: z.string(),
    analysisStatus: z.string(),
    pageCount: z.number().int().nullable(),
  }),
  disclaimer: z.string(),
  /** null when the classified type has no extraction family (Q&A-only, FR-1.2). */
  extraction: z.object({ schemaVer: z.string(), fields: z.array(reportFieldSchema) }).nullable(),
  flags: z.array(reportFlagSchema),
  summary: z.object({
    flagCounts: flagCountsSchema,
    extractedFieldCount: z.number().int(),
    notFoundCount: z.number().int(),
  }),
});
export type DocumentReport = z.infer<typeof documentReportSchema>;

export const caseReportSchema = z.object({
  case: z.object({ id: z.uuid(), title: z.string() }),
  disclaimer: z.string(),
  documents: z.array(documentReportSchema),
  summary: z.object({ documentCount: z.number().int(), flagCounts: flagCountsSchema }),
});
export type CaseReport = z.infer<typeof caseReportSchema>;

// --- cases and documents ------------------------------------------------------

export const caseSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  retentionDays: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type Case = z.infer<typeof caseSchema>;

export const documentStatusSchema = z.enum(["uploaded", "processing", "ready", "failed"]);
export const analysisStatusSchema = z.enum(["pending", "analyzing", "analyzed", "failed"]);

export const documentSummarySchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  status: documentStatusSchema,
  analysisStatus: analysisStatusSchema,
  language: z.enum(["de", "en", "mixed"]).nullable(),
  pageCount: z.number().int().nullable(),
});
export type DocumentSummary = z.infer<typeof documentSummarySchema>;

export const caseWithDocumentsSchema = caseSchema.extend({
  documents: z.array(documentSummarySchema),
});
export type CaseWithDocuments = z.infer<typeof caseWithDocumentsSchema>;

export const caseListSchema = z.object({
  cases: z.array(caseSchema.extend({ documentCount: z.number().int() })),
});
export type CaseList = z.infer<typeof caseListSchema>;

export const documentSchema = z.object({
  id: z.uuid(),
  caseId: z.uuid(),
  filename: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int(),
  sha256: z.string(),
  status: documentStatusSchema,
  analysisStatus: analysisStatusSchema,
  language: z.enum(["de", "en", "mixed"]).nullable(),
  pageCount: z.number().int().nullable(),
  parseReport: z.unknown().nullable(),
});
export type ApiDocument = z.infer<typeof documentSchema>;

/**
 * `POST /cases/:id/documents`. The route splits this by status - 201 for stored
 * bytes, 200 for a content-hash hit (FR-1.5) - but a client that only wants to
 * know which document it now holds parses one shape for both.
 */
export const documentUploadSchema = z.object({
  document: documentSchema,
  deduplicated: z.boolean(),
});
export type DocumentUpload = z.infer<typeof documentUploadSchema>;

export const analyzeAcceptedSchema = z.object({
  documentId: z.uuid(),
  analysisStatus: z.literal("analyzing"),
});

export const caseAnalyzeAcceptedSchema = z.object({
  caseId: z.uuid(),
  /** Only `ready` documents are enqueued, so a case with none is 202 with 0. */
  enqueued: z.number().int(),
});
export type CaseAnalyzeAccepted = z.infer<typeof caseAnalyzeAcceptedSchema>;

// --- clauses ------------------------------------------------------------------

/**
 * A clause with its structural citation fields. `charStart`/`charEnd` are
 * absolute canonical offsets frozen at parse time (ADR-0005): the viewer
 * resolves them to a page rectangle, and the clause-text panel slices `text` at
 * them. Neither ever transforms the text - slicing is the only permitted
 * operation downstream of the parser.
 */
export const clauseSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  clauseRef: z.string(),
  serializedClauseId: z.string(),
  clausePath: z.string(),
  heading: z.string().nullable(),
  headingPath: z.array(z.string()),
  page: z.number().int(),
  charStart: z.number().int(),
  charEnd: z.number().int(),
  seq: z.number().int(),
  text: z.string(),
});
export type Clause = z.infer<typeof clauseSchema>;

export const clauseContextSchema = z.object({
  clause: clauseSchema,
  before: z.array(clauseSchema),
  after: z.array(clauseSchema),
});
export type ClauseContext = z.infer<typeof clauseContextSchema>;

// --- search -------------------------------------------------------------------

export const searchResultSchema = z.object({
  clauseId: z.uuid(),
  chunkId: z.uuid(),
  documentId: z.uuid(),
  clauseRef: z.string(),
  serializedClauseId: z.string(),
  clausePath: z.string(),
  heading: z.string().nullable(),
  headingPath: z.array(z.string()),
  page: z.number().int(),
  charStart: z.number().int(),
  charEnd: z.number().int(),
  snippet: z.string(),
  scores: z.object({ fused: z.number(), rerank: z.number().nullable() }),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = z.object({
  query: z.string(),
  results: z.array(searchResultSchema),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

// --- viewer geometry ----------------------------------------------------------

/**
 * Block rectangles in PDF points against the same frozen character offsets
 * every citation uses, so the viewer resolves a clause span to a rectangle
 * client-side with no round trip. `geometry: false` means DOCX or a missing
 * sidecar - take the clause-text viewer instead.
 */
export const documentLayoutSchema = z.object({
  documentId: z.uuid(),
  mimeType: z.string(),
  pageCount: z.number().int().nullable(),
  geometry: z.boolean(),
  pages: z.array(
    z.object({
      page: z.number().int().positive(),
      width: z.number().positive(),
      height: z.number().positive(),
    }),
  ),
  blocks: z.array(
    z.object({
      page: z.number().int().positive(),
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
      charStart: z.number().int().nonnegative(),
      charEnd: z.number().int().nonnegative(),
    }),
  ),
});
export type DocumentLayout = z.infer<typeof documentLayoutSchema>;
export type LayoutBlock = DocumentLayout["blocks"][number];
export type LayoutPage = DocumentLayout["pages"][number];

// --- progress -----------------------------------------------------------------

export const analysisPhaseSchema = z.enum(["queued", "parsing", "analyzing", "ready", "failed"]);
export type AnalysisPhase = z.infer<typeof analysisPhaseSchema>;

/**
 * Collapses the two independent status columns into the one phase a reader
 * cares about.
 *
 * Lives here because both sides need it and they must agree: the progress
 * stream sends `phase` precomputed, but `GET /cases/{id}` returns only the raw
 * columns, so the client derives the same value when it polls. Two copies of
 * this would drift into a UI that disagrees with its own event stream.
 *
 * Note the last line: a document that finished ingesting but has not been
 * analyzed reads as `queued`, not `ready` - `analyzed` only ever arrives after
 * someone asks for analysis.
 */
export function derivePhase(doc: {
  status: string;
  analysisStatus: string;
}): z.infer<typeof analysisPhaseSchema> {
  if (doc.status === "failed" || doc.analysisStatus === "failed") return "failed";
  if (doc.status === "uploaded") return "queued";
  if (doc.status === "processing") return "parsing";
  if (doc.analysisStatus === "analyzed") return "ready";
  if (doc.analysisStatus === "analyzing") return "analyzing";
  return "queued";
}

export const documentProgressSchema = z.object({
  documentId: z.uuid(),
  filename: z.string(),
  phase: analysisPhaseSchema,
  status: z.string(),
  analysisStatus: z.string(),
  /** Per-page parse outcomes; PRD §9 wants parse failure surfaced per page. */
  pageFailures: z.array(z.number().int()),
});

export const progressSchema = z.object({
  caseId: z.uuid(),
  documents: z.array(documentProgressSchema),
  done: z.boolean(),
});
export type Progress = z.infer<typeof progressSchema>;

// --- demo ---------------------------------------------------------------------

export const demoCatalogSchema = z.object({
  available: z.boolean(),
  documents: z.array(
    z.object({
      filename: z.string(),
      type: z.string().nullable(),
      language: z.string().nullable(),
      pageCount: z.number().int().nullable(),
    }),
  ),
});
export type DemoCatalog = z.infer<typeof demoCatalogSchema>;

export const demoAdoptSchema = z.object({
  caseId: z.uuid(),
  documentCount: z.number().int(),
});

// --- Q&A ----------------------------------------------------------------------

/**
 * The ceiling on a question, shared so the composer can stop at exactly the
 * length the route rejects. Kept here rather than in the route file because a
 * client that has to guess it will guess wrong and turn a typo into a 400.
 */
export const ASK_QUESTION_MAX_CHARS = 2_000;

export const askRequestSchema = z.object({
  question: z.string().min(1).max(ASK_QUESTION_MAX_CHARS),
});

export const answerCitationSchema = z.object({
  clauseId: z.uuid(),
  serializedClauseId: z.string(),
  documentId: z.uuid(),
  page: z.number().int(),
  charStart: z.number().int(),
  charEnd: z.number().int(),
  verbatimAnchor: z.string(),
});
export type AnswerCitation = z.infer<typeof answerCitationSchema>;

export const usageSchema = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costEur: z.number(),
  latencyMs: z.number().int(),
});

export const askResponseSchema = z.object({
  turnId: z.uuid(),
  question: z.string(),
  answer: z.string(),
  disclaimer: z.string(),
  citations: z.array(answerCitationSchema),
  /**
   * Assertions the validator could not tie to a retrieved clause. Surfaced
   * rather than dropped (FR-5.2) - an unverifiable claim the user can see is
   * safer than one silently removed.
   */
  couldNotVerify: z.array(z.string()),
  grounded: z.boolean(),
  corrected: z.boolean(),
  usage: usageSchema,
  trace: agentTraceSchema,
});
export type AskResponse = z.infer<typeof askResponseSchema>;

// --- narrative report (FR-5.3) ------------------------------------------------

export const narrativeCitationSchema = z.object({
  clauseId: z.uuid(),
  /**
   * The `[[...]]` marker the narrative's own prose carries. Present so a client
   * can tie a marker in a sentence to the citation row that justifies it -
   * without it, "every line cited" is a claim the reader cannot follow.
   */
  serializedClauseId: z.string(),
  documentId: z.uuid(),
  page: z.number().int(),
  charStart: z.number().int(),
  charEnd: z.number().int(),
});
export type NarrativeCitation = z.infer<typeof narrativeCitationSchema>;

export const narrativeSchema = z.object({
  turnId: z.uuid(),
  markdown: z.string(),
  disclaimer: z.string(),
  citations: z.array(narrativeCitationSchema),
  /** Same contract as `ask`: surfaced, never silently dropped (FR-5.2). */
  couldNotVerify: z.array(z.string()),
  grounded: z.boolean(),
  corrected: z.boolean(),
  promptVersion: z.string(),
  createdAt: z.iso.datetime(),
  /**
   * Nullable because this one is served from storage: `GET .../narrative`
   * replays a row that an older deploy may have written in an older shape. A
   * legacy row's markdown and citations are still perfectly good, so the trace
   * degrades to `null` rather than taking a working report down with it.
   */
  trace: narrativeTraceSchema.nullable(),
});
export type Narrative = z.infer<typeof narrativeSchema>;

// --- errors -------------------------------------------------------------------

export const sessionErrorSchema = z.object({
  error: z.enum(["no_session", "session_expired"]),
  message: z.string(),
});

export const rateLimitErrorSchema = z.object({
  error: z.literal("rate_limited"),
  scope: z.enum(["ip", "tenant"]),
  limit: z.number().int(),
  windowSeconds: z.number().int(),
  retryAfterSeconds: z.number().int(),
  message: z.string(),
});
