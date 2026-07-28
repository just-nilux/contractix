/**
 * FR-6.4's "try without upload" path, and PRD §4's "one-click try without
 * signup" career KPI.
 *
 * `GET /demo` is unauthenticated - it is what the landing page shows before
 * anyone has a session. `POST /demo/adopt` mints one if needed and clones the
 * template case into it, so the visitor owns everything they then see.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, eq } from "drizzle-orm";

import { type AppEnv, ensureTenant, tenantOf } from "../auth/middleware.js";
import { rateLimit, RATE_LIMITED_RESPONSE } from "../auth/rate-limit.js";
import { cases, documents } from "../db/schema/index.js";
import { cloneCaseIntoTenant } from "../demo/clone-case.js";
import { demoCatalog, findDemoTemplate } from "../demo/template.js";
import { type AppDeps } from "../deps.js";
import { logger } from "../logger.js";

const ADOPTED_TITLE = "Demo Corpus";

const catalogSchema = z.object({
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

const getCatalog = createRoute({
  method: "get",
  path: "/demo",
  summary: "What the demo corpus contains (no session required)",
  description:
    "Metadata only - filenames, types, languages, page counts. Nothing derived from the " +
    "documents' contents is served across tenants.",
  responses: {
    200: {
      description: "Demo catalogue",
      content: { "application/json": { schema: catalogSchema } },
    },
  },
});

const adoptRoute = (deps: AppDeps) =>
  createRoute({
    method: "post",
    path: "/demo/adopt",
    summary: "Copy the demo corpus into your own session",
    description:
      "Starts a session if the request carries none. Idempotent: a session that has already " +
      "adopted the demo gets its existing case back rather than a second copy. The clone is " +
      "yours - ask questions of it, re-analyze it, upload alongside it, delete it.",
    middleware: [rateLimit(deps, "demoAdopt"), ensureTenant(deps)] as const,
    responses: {
      200: {
        description: "Already adopted; the existing case",
        content: {
          "application/json": {
            schema: z.object({ caseId: z.uuid(), documentCount: z.number().int() }),
          },
        },
      },
      201: {
        description: "Demo corpus cloned into this session",
        content: {
          "application/json": {
            schema: z.object({ caseId: z.uuid(), documentCount: z.number().int() }),
          },
        },
      },
      503: { description: "Demo corpus is not seeded on this deployment" },
      ...RATE_LIMITED_RESPONSE,
    },
  });

/** The session's existing demo clone, if it has one. */
async function adoptedCase(
  deps: AppDeps,
  tenantId: string,
): Promise<{ caseId: string; documentCount: number } | null> {
  const existing = await deps.db
    .select({ id: cases.id })
    .from(cases)
    .where(and(eq(cases.tenantId, tenantId), eq(cases.origin, "demo")))
    .limit(1);
  if (!existing[0]) return null;

  const [{ value: documentCount } = { value: 0 }] = await deps.db
    .select({ value: count() })
    .from(documents)
    .where(and(eq(documents.caseId, existing[0].id), eq(documents.tenantId, tenantId)));
  return { caseId: existing[0].id, documentCount };
}

/**
 * Postgres unique-violation SQLSTATE. Walks `cause` because drizzle wraps the
 * pg error in a DrizzleQueryError, so the code is one level down.
 */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e != null; e = (e as { cause?: unknown }).cause) {
    if (typeof e === "object" && "code" in e && e.code === "23505") return true;
  }
  return false;
}

export function demoRoutes(deps: AppDeps) {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(getCatalog, async (c) => {
    const template = await findDemoTemplate(deps.db, deps.demo);
    if (!template) return c.json({ available: false, documents: [] }, 200);
    return c.json({ available: true, documents: await demoCatalog(deps.db, template) }, 200);
  });

  app.openapi(adoptRoute(deps), async (c) => {
    const tenantId = tenantOf(c);

    const existing = await adoptedCase(deps, tenantId);
    if (existing) return c.json(existing, 200);

    const template = await findDemoTemplate(deps.db, deps.demo);
    if (!template) return c.body(null, 503);

    let result;
    try {
      result = await cloneCaseIntoTenant(deps.db, {
        sourceCaseId: template.caseId,
        sourceTenantId: template.tenantId,
        targetTenantId: tenantId,
        title: ADOPTED_TITLE,
      });
    } catch (err) {
      // `cases_one_demo_per_tenant`: a concurrent adopt from the same session -
      // a double-clicked button - won the race. Its clone is the answer.
      if (!isUniqueViolation(err)) throw err;
      const raced = await adoptedCase(deps, tenantId);
      if (!raced) throw err;
      return c.json(raced, 200);
    }

    logger.info(
      { tenantId, caseId: result.caseId, documents: result.documentCount },
      "demo corpus adopted",
    );
    return c.json(result, 201);
  });

  return app;
}
