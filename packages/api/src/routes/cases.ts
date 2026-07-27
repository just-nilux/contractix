import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";

import { type AppEnv, ensureTenant, requireTenant, tenantOf } from "../auth/middleware.js";
import { cases, documents } from "../db/schema/index.js";
import { type AppDeps } from "../deps.js";

const caseSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  retentionDays: z.number().int(),
  createdAt: z.iso.datetime(),
});

const documentSummarySchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  status: z.enum(["uploaded", "processing", "ready", "failed"]),
  analysisStatus: z.enum(["pending", "analyzing", "analyzed", "failed"]),
  language: z.enum(["de", "en", "mixed"]).nullable(),
  pageCount: z.number().int().nullable(),
});

/**
 * The one route that starts a session, along with `POST /demo/adopt` - hence
 * `ensureTenant` rather than `requireTenant`. Keeping minting to those two
 * means a crawler cannot fill the tenants table by hitting anything else.
 */
const createCaseRoute = (deps: AppDeps) =>
  createRoute({
    method: "post",
    path: "/cases",
    summary: "Create a case (a set of documents evaluated together)",
    description:
      "Starts an anonymous session if the request carries none, returned as an HttpOnly " +
      "cookie. The session and everything uploaded under it are deleted after 24 h (FR-7.3).",
    middleware: ensureTenant(deps),
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ title: z.string().min(1).max(200) }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "Case created",
        content: { "application/json": { schema: caseSchema } },
      },
    },
  });

const getCase = createRoute({
  method: "get",
  path: "/cases/{id}",
  summary: "Fetch a case with its documents",
  middleware: requireTenant,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: "Case with document summaries",
      content: {
        "application/json": {
          schema: caseSchema.extend({ documents: z.array(documentSummarySchema) }),
        },
      },
    },
    401: { description: "No session, or the session expired" },
    404: { description: "Not found" },
  },
});

export function caseRoutes(deps: AppDeps) {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(createCaseRoute(deps), async (c) => {
    const { title } = c.req.valid("json");
    const tenantId = tenantOf(c);
    const inserted = await deps.db.insert(cases).values({ tenantId, title }).returning();
    const row = inserted[0];
    if (!row) throw new Error("case insert returned no row");
    return c.json(
      {
        id: row.id,
        title: row.title,
        retentionDays: row.retentionDays,
        createdAt: row.createdAt.toISOString(),
      },
      201,
    );
  });

  app.openapi(getCase, async (c) => {
    const { id } = c.req.valid("param");
    const tenantId = tenantOf(c);
    const found = await deps.db
      .select()
      .from(cases)
      .where(and(eq(cases.id, id), eq(cases.tenantId, tenantId)))
      .limit(1);
    const row = found[0];
    if (!row) return c.body(null, 404);

    const docs = await deps.db
      .select({
        id: documents.id,
        filename: documents.filename,
        status: documents.status,
        analysisStatus: documents.analysisStatus,
        language: documents.language,
        pageCount: documents.pageCount,
      })
      .from(documents)
      .where(and(eq(documents.caseId, id), eq(documents.tenantId, tenantId)));

    return c.json(
      {
        id: row.id,
        title: row.title,
        retentionDays: row.retentionDays,
        createdAt: row.createdAt.toISOString(),
        documents: docs,
      },
      200,
    );
  });

  return app;
}
