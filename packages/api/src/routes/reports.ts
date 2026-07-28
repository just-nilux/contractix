import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";

import { type AppEnv, requireTenant, tenantOf } from "../auth/middleware.js";
import { rateLimit, RATE_LIMITED_RESPONSE } from "../auth/rate-limit.js";
import { cases, documents } from "../db/schema/index.js";
import { type AppDeps } from "../deps.js";
import {
  caseReportSchema,
  documentExtractionSchema,
  documentReportSchema,
  getCaseReport,
  getDocumentReport,
} from "../extraction/report-service.js";
import { enqueueAnalysis } from "../queue/analysis.js";

const analyzeAcceptedSchema = z.object({
  documentId: z.uuid(),
  analysisStatus: z.literal("analyzing"),
});
const caseAnalyzeAcceptedSchema = z.object({ caseId: z.uuid(), enqueued: z.number().int() });

const getDocumentReportRoute = createRoute({
  method: "get",
  path: "/documents/{id}/report",
  summary: "Red-flag report for a document (extraction + flags + clause citations)",
  description:
    "Informational analysis, not legal advice. Every field and flag carries citations to the " +
    "exact clause spans they derive from.",
  middleware: requireTenant,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: "Report",
      content: { "application/json": { schema: documentReportSchema } },
    },
    401: { description: "No session, or the session expired" },
    404: { description: "Not found" },
  },
});

/**
 * FR-6.2 names this endpoint. It is the report's extraction slice - same
 * tenant-scoped query, same per-field structural citations - for a client that
 * wants the terms table without the red flags.
 */
const getDocumentExtractionRoute = createRoute({
  method: "get",
  path: "/documents/{id}/extraction",
  summary: "Extracted fields for a document, each with its clause citations",
  middleware: requireTenant,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: "Extraction",
      content: { "application/json": { schema: documentExtractionSchema } },
    },
    401: { description: "No session, or the session expired" },
    404: { description: "Not found" },
  },
});

const analyzeDocumentRoute = (deps: AppDeps) =>
  createRoute({
    method: "post",
    path: "/documents/{id}/analyze",
    summary: "(Re)run analysis for a document",
    description:
      "Enqueues classify → extract → benchmark. Idempotent: a re-run supersedes the prior analysis.",
    middleware: [rateLimit(deps, "analyze"), requireTenant] as const,
    request: { params: z.object({ id: z.uuid() }) },
    responses: {
      202: {
        description: "Analysis enqueued",
        content: { "application/json": { schema: analyzeAcceptedSchema } },
      },
      401: { description: "No session, or the session expired" },
      404: { description: "Not found" },
      409: { description: "Document is not ready (ingestion incomplete or failed)" },
      ...RATE_LIMITED_RESPONSE,
    },
  });

const getCaseReportRoute = createRoute({
  method: "get",
  path: "/cases/{id}/report",
  summary: "Aggregated red-flag report for every document in a case",
  middleware: requireTenant,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: "Case report",
      content: { "application/json": { schema: caseReportSchema } },
    },
    401: { description: "No session, or the session expired" },
    404: { description: "Not found" },
  },
});

const analyzeCaseRoute = (deps: AppDeps) =>
  createRoute({
    method: "post",
    path: "/cases/{id}/analyze",
    summary: "(Re)run analysis for every ready document in a case",
    middleware: [rateLimit(deps, "analyze"), requireTenant] as const,
    request: { params: z.object({ id: z.uuid() }) },
    responses: {
      202: {
        description: "Analysis enqueued for the case's ready documents",
        content: { "application/json": { schema: caseAnalyzeAcceptedSchema } },
      },
      401: { description: "No session, or the session expired" },
      404: { description: "Not found" },
      ...RATE_LIMITED_RESPONSE,
    },
  });

export function reportRoutes(deps: AppDeps) {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(getDocumentReportRoute, async (c) => {
    const { id } = c.req.valid("param");
    const tenantId = tenantOf(c);
    const report = await getDocumentReport({ db: deps.db }, { documentId: id, tenantId });
    if (!report) return c.body(null, 404);
    return c.json(report, 200);
  });

  app.openapi(getDocumentExtractionRoute, async (c) => {
    const { id } = c.req.valid("param");
    const tenantId = tenantOf(c);
    const report = await getDocumentReport({ db: deps.db }, { documentId: id, tenantId });
    if (!report) return c.body(null, 404);
    return c.json(
      { documentId: id, disclaimer: report.disclaimer, extraction: report.extraction },
      200,
    );
  });

  app.openapi(analyzeDocumentRoute(deps), async (c) => {
    const { id } = c.req.valid("param");
    const tenantId = tenantOf(c);
    const rows = await deps.db
      .select({ status: documents.status })
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.tenantId, tenantId)))
      .limit(1);
    const doc = rows[0];
    if (!doc) return c.body(null, 404);
    // Analysis reads clauses the ingest pipeline writes; only `ready` documents have them.
    if (doc.status !== "ready") return c.body(null, 409);

    await enqueueAnalysis(deps.analysisQueue, { documentId: id, tenantId });
    await deps.db
      .update(documents)
      .set({ analysisStatus: "analyzing" })
      .where(and(eq(documents.id, id), eq(documents.tenantId, tenantId)));
    return c.json({ documentId: id, analysisStatus: "analyzing" as const }, 202);
  });

  app.openapi(getCaseReportRoute, async (c) => {
    const { id } = c.req.valid("param");
    const tenantId = tenantOf(c);
    const report = await getCaseReport({ db: deps.db }, { caseId: id, tenantId });
    if (!report) return c.body(null, 404);
    return c.json(report, 200);
  });

  app.openapi(analyzeCaseRoute(deps), async (c) => {
    const { id } = c.req.valid("param");
    const tenantId = tenantOf(c);
    const kase = await deps.db
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.id, id), eq(cases.tenantId, tenantId)))
      .limit(1);
    if (!kase[0]) return c.body(null, 404);

    const ready = await deps.db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.caseId, id),
          eq(documents.tenantId, tenantId),
          eq(documents.status, "ready"),
        ),
      );
    for (const d of ready) {
      await enqueueAnalysis(deps.analysisQueue, { documentId: d.id, tenantId });
      await deps.db
        .update(documents)
        .set({ analysisStatus: "analyzing" })
        .where(and(eq(documents.id, d.id), eq(documents.tenantId, tenantId)));
    }
    return c.json({ caseId: id, enqueued: ready.length }, 202);
  });

  return app;
}
