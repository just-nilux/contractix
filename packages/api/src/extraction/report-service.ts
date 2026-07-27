import { type DocumentType, type Language, serializeClauseId } from "@contractix/shared";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { type Db } from "../db/client.js";
import { cases, citations, clauses, documents, extractions, flags } from "../db/schema/index.js";

/** FR-7.6 — every report says what it is (and is not). */
const DISCLAIMER =
  "Informational analysis, not legal or tax advice. Statutory references are pointers, not determinations.";

const SEVERITY_ORDER = { red: 0, amber: 1, info: 2 } as const;
type Severity = keyof typeof SEVERITY_ORDER;

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

export const reportFieldSchema = z.object({
  fieldPath: z.string(),
  value: z.unknown(),
  unit: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  status: z.enum(["extracted", "not_found", "extraction_failed"]),
  citations: z.array(reportCitationSchema),
});

export const reportFlagSchema = z.object({
  ruleId: z.string(),
  ruleVersion: z.string(),
  severity: z.enum(["red", "amber", "info"]),
  rationale: z.string(),
  negotiationHint: z.string().nullable(),
  sources: z.array(z.string()),
  citations: z.array(reportCitationSchema),
});

const flagCountsSchema = z.object({
  red: z.number().int(),
  amber: z.number().int(),
  info: z.number().int(),
});

/** FR-6.2's `GET /documents/:id/extraction` - the report's extraction slice. */
export const documentExtractionSchema = z.object({
  documentId: z.uuid(),
  disclaimer: z.string(),
  extraction: z.object({ schemaVer: z.string(), fields: z.array(reportFieldSchema) }).nullable(),
});

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

export interface ReportDocRow {
  id: string;
  caseId: string;
  filename: string;
  type: DocumentType | null;
  language: Language | null;
  status: string;
  analysisStatus: string;
  pageCount: number | null;
}

export interface ReportExtractionRow {
  id: string;
  schemaVer: string;
  fieldPath: string;
  value: unknown;
  unit: string | null;
  confidence: "high" | "medium" | "low";
  status: "extracted" | "not_found" | "extraction_failed";
}

export interface ReportCitationRow {
  extractionId: string | null;
  clauseId: string;
  charStart: number;
  charEnd: number;
  verbatimAnchor: string;
}

export interface ReportFlagRow {
  ruleId: string;
  ruleVersion: string;
  severity: Severity;
  clauseIds: string[];
  rationale: string;
  negotiationHint: string | null;
  sources: string[] | null;
}

export interface ReportClauseInfo {
  clauseRef: string;
  page: number;
  heading: string | null;
}

export interface ComposeReportInput {
  document: ReportDocRow;
  extractionRows: ReportExtractionRow[];
  citationRows: ReportCitationRow[];
  flagRows: ReportFlagRow[];
  clauseById: Map<string, ReportClauseInfo>;
}

/**
 * Assemble a document's red-flag report from already-persisted rows — pure, no
 * DB. Citations are the structural spans written at extraction time (ADR-0005/
 * 0007): the resolver is never re-run and text is never re-quote-matched here.
 * Flags cite whole clauses (no char span). Flags sort red -> amber -> info.
 */
export function composeDocumentReport(input: ComposeReportInput): DocumentReport {
  const { document, extractionRows, citationRows, flagRows, clauseById } = input;

  const citationsByExtraction = new Map<string, ReportCitationRow[]>();
  for (const c of citationRows) {
    if (!c.extractionId) continue;
    const arr = citationsByExtraction.get(c.extractionId) ?? [];
    arr.push(c);
    citationsByExtraction.set(c.extractionId, arr);
  }

  const cite = (
    clauseId: string,
    charStart: number | null,
    charEnd: number | null,
    verbatimAnchor: string | null,
  ) => {
    const info = clauseById.get(clauseId);
    return {
      clauseId,
      serializedClauseId: info ? serializeClauseId(document.id, info.clauseRef) : clauseId,
      clauseRef: info?.clauseRef ?? "",
      page: info?.page ?? 0,
      heading: info?.heading ?? null,
      charStart,
      charEnd,
      verbatimAnchor,
    };
  };

  const fields = extractionRows.map((r) => ({
    fieldPath: r.fieldPath,
    value: r.value ?? null,
    unit: r.unit,
    confidence: r.confidence,
    status: r.status,
    citations: (citationsByExtraction.get(r.id) ?? []).map((c) =>
      cite(c.clauseId, c.charStart, c.charEnd, c.verbatimAnchor),
    ),
  }));

  const flagsOut = [...flagRows]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .map((f) => ({
      ruleId: f.ruleId,
      ruleVersion: f.ruleVersion,
      severity: f.severity,
      rationale: f.rationale,
      negotiationHint: f.negotiationHint,
      sources: f.sources ?? [],
      citations: f.clauseIds.map((id) => cite(id, null, null, null)),
    }));

  const flagCounts = { red: 0, amber: 0, info: 0 };
  for (const f of flagRows) flagCounts[f.severity] += 1;

  return {
    document: {
      id: document.id,
      caseId: document.caseId,
      filename: document.filename,
      type: document.type,
      language: document.language,
      status: document.status,
      analysisStatus: document.analysisStatus,
      pageCount: document.pageCount,
    },
    disclaimer: DISCLAIMER,
    extraction: extractionRows.length ? { schemaVer: extractionRows[0]!.schemaVer, fields } : null,
    flags: flagsOut,
    summary: {
      flagCounts,
      extractedFieldCount: extractionRows.filter((r) => r.status === "extracted").length,
      notFoundCount: extractionRows.filter((r) => r.status === "not_found").length,
    },
  };
}

export interface ReportDeps {
  db: Db;
}

export interface DocumentReportParams {
  documentId: string;
  tenantId: string;
}

/**
 * Read one document's report, tenant-scoped (FR-7.4). Loads the document,
 * extractions, extraction citations, and flags, resolves the clauses those cite,
 * and composes. Returns null when the document is not in the tenant (route 404).
 */
export async function getDocumentReport(
  deps: ReportDeps,
  params: DocumentReportParams,
): Promise<DocumentReport | null> {
  const { tenantId } = params;

  const docRows = await deps.db
    .select({
      id: documents.id,
      caseId: documents.caseId,
      filename: documents.filename,
      type: documents.type,
      language: documents.language,
      status: documents.status,
      analysisStatus: documents.analysisStatus,
      pageCount: documents.pageCount,
    })
    .from(documents)
    .where(and(eq(documents.id, params.documentId), eq(documents.tenantId, tenantId)))
    .limit(1);
  const document = docRows[0];
  if (!document) return null;

  const extractionRows = await deps.db
    .select({
      id: extractions.id,
      schemaVer: extractions.schemaVer,
      fieldPath: extractions.fieldPath,
      value: extractions.value,
      unit: extractions.unit,
      confidence: extractions.confidence,
      status: extractions.status,
    })
    .from(extractions)
    .where(and(eq(extractions.documentId, document.id), eq(extractions.tenantId, tenantId)));

  const citationRows = await deps.db
    .select({
      extractionId: citations.extractionId,
      clauseId: citations.clauseId,
      charStart: citations.charStart,
      charEnd: citations.charEnd,
      verbatimAnchor: citations.verbatimAnchor,
    })
    .from(citations)
    .where(
      and(
        eq(citations.documentId, document.id),
        eq(citations.tenantId, tenantId),
        eq(citations.sourceType, "extraction"),
      ),
    );

  const flagRows = await deps.db
    .select({
      ruleId: flags.ruleId,
      ruleVersion: flags.ruleVersion,
      severity: flags.severity,
      clauseIds: flags.clauseIds,
      rationale: flags.rationale,
      negotiationHint: flags.negotiationHint,
      sources: flags.sources,
    })
    .from(flags)
    .where(and(eq(flags.documentId, document.id), eq(flags.tenantId, tenantId)));

  const clauseIds = new Set<string>();
  for (const c of citationRows) clauseIds.add(c.clauseId);
  for (const f of flagRows) for (const id of f.clauseIds) clauseIds.add(id);

  const clauseById = new Map<string, ReportClauseInfo>();
  if (clauseIds.size > 0) {
    const clauseRows = await deps.db
      .select({
        id: clauses.id,
        clauseRef: clauses.clauseRef,
        page: clauses.page,
        heading: clauses.heading,
      })
      .from(clauses)
      .where(and(eq(clauses.tenantId, tenantId), inArray(clauses.id, [...clauseIds])));
    for (const cl of clauseRows) {
      clauseById.set(cl.id, { clauseRef: cl.clauseRef, page: cl.page, heading: cl.heading });
    }
  }

  return composeDocumentReport({ document, extractionRows, citationRows, flagRows, clauseById });
}

export interface CaseReportParams {
  caseId: string;
  tenantId: string;
}

/** Aggregate every document's report in a case, with a case-level severity rollup (FR-6.2). */
export async function getCaseReport(
  deps: ReportDeps,
  params: CaseReportParams,
): Promise<CaseReport | null> {
  const { tenantId } = params;

  const caseRows = await deps.db
    .select({ id: cases.id, title: cases.title })
    .from(cases)
    .where(and(eq(cases.id, params.caseId), eq(cases.tenantId, tenantId)))
    .limit(1);
  const kase = caseRows[0];
  if (!kase) return null;

  const docRows = await deps.db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.caseId, kase.id), eq(documents.tenantId, tenantId)));

  const reports: DocumentReport[] = [];
  for (const d of docRows) {
    const report = await getDocumentReport(deps, { documentId: d.id, tenantId });
    if (report) reports.push(report);
  }

  const flagCounts = { red: 0, amber: 0, info: 0 };
  for (const r of reports) {
    flagCounts.red += r.summary.flagCounts.red;
    flagCounts.amber += r.summary.flagCounts.amber;
    flagCounts.info += r.summary.flagCounts.info;
  }

  return {
    case: { id: kase.id, title: kase.title },
    disclaimer: DISCLAIMER,
    documents: reports,
    summary: { documentCount: reports.length, flagCounts },
  };
}
