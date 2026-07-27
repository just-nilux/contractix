import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import { type AppEnv, requireTenant, tenantOf } from "../auth/middleware.js";
import { type AppDeps } from "../deps.js";
import { getClause, getClauseContext } from "../retrieval/clause-service.js";

const clauseSchema = z.object({
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

const getClauseRoute = createRoute({
  method: "get",
  path: "/clauses/{id}",
  summary: "Fetch one clause (get_clause tool core)",
  middleware: requireTenant,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: "Clause with structural citation fields",
      content: { "application/json": { schema: clauseSchema } },
    },
    401: { description: "No session, or the session expired" },
    404: { description: "Not found" },
  },
});

const getClauseContextRoute = createRoute({
  method: "get",
  path: "/clauses/{id}/context",
  summary: "Fetch a clause with its neighbors (get_clause_context tool core)",
  middleware: requireTenant,
  request: {
    params: z.object({ id: z.uuid() }),
    query: z.object({ radius: z.coerce.number().int().min(1).max(5).default(1) }),
  },
  responses: {
    200: {
      description: "Clause plus radius neighbors in document order",
      content: {
        "application/json": {
          schema: z.object({
            clause: clauseSchema,
            before: z.array(clauseSchema),
            after: z.array(clauseSchema),
          }),
        },
      },
    },
    401: { description: "No session, or the session expired" },
    404: { description: "Not found" },
  },
});

export function clauseRoutes(deps: AppDeps) {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(getClauseRoute, async (c) => {
    const { id } = c.req.valid("param");
    const tenantId = tenantOf(c);
    const clause = await getClause(deps, { clauseId: id, tenantId });
    if (!clause) return c.body(null, 404);
    return c.json(clause, 200);
  });

  app.openapi(getClauseContextRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { radius } = c.req.valid("query");
    const tenantId = tenantOf(c);
    const ctx = await getClauseContext(deps, { clauseId: id, tenantId, radius });
    if (!ctx) return c.body(null, 404);
    return c.json(ctx, 200);
  });

  return app;
}
