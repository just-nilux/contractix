import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, gte, lte } from "drizzle-orm";

import { serializeClauseId } from "@contractix/shared";

import { clauses } from "../db/schema/index.js";
import { ensureDevTenant } from "../db/tenancy.js";
import { type AppDeps } from "../deps.js";

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

type ClauseRow = typeof clauses.$inferSelect;

function toClauseJson(row: ClauseRow) {
  return {
    id: row.id,
    documentId: row.documentId,
    clauseRef: row.clauseRef,
    serializedClauseId: serializeClauseId(row.documentId, row.clauseRef),
    clausePath: row.clausePath,
    heading: row.heading,
    headingPath: row.headingPath,
    page: row.page,
    charStart: row.charStart,
    charEnd: row.charEnd,
    seq: row.seq,
    text: row.text,
  };
}

const getClause = createRoute({
  method: "get",
  path: "/clauses/{id}",
  summary: "Fetch one clause (get_clause tool core)",
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: "Clause with structural citation fields",
      content: { "application/json": { schema: clauseSchema } },
    },
    404: { description: "Not found" },
  },
});

const getClauseContext = createRoute({
  method: "get",
  path: "/clauses/{id}/context",
  summary: "Fetch a clause with its neighbors (get_clause_context tool core)",
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
    404: { description: "Not found" },
  },
});

export function clauseRoutes(deps: AppDeps) {
  const app = new OpenAPIHono();

  const loadClause = async (id: string, tenantId: string) => {
    const rows = await deps.db
      .select()
      .from(clauses)
      .where(and(eq(clauses.id, id), eq(clauses.tenantId, tenantId)))
      .limit(1);
    return rows[0];
  };

  app.openapi(getClause, async (c) => {
    const { id } = c.req.valid("param");
    const tenantId = await ensureDevTenant(deps.db);
    const row = await loadClause(id, tenantId);
    if (!row) return c.body(null, 404);
    return c.json(toClauseJson(row), 200);
  });

  app.openapi(getClauseContext, async (c) => {
    const { id } = c.req.valid("param");
    const { radius } = c.req.valid("query");
    const tenantId = await ensureDevTenant(deps.db);
    const row = await loadClause(id, tenantId);
    if (!row) return c.body(null, 404);

    const neighbors = await deps.db
      .select()
      .from(clauses)
      .where(
        and(
          eq(clauses.documentId, row.documentId),
          eq(clauses.tenantId, tenantId),
          gte(clauses.seq, row.seq - radius),
          lte(clauses.seq, row.seq + radius),
        ),
      )
      .orderBy(clauses.seq);

    return c.json(
      {
        clause: toClauseJson(row),
        before: neighbors.filter((n) => n.seq < row.seq).map(toClauseJson),
        after: neighbors.filter((n) => n.seq > row.seq).map(toClauseJson),
      },
      200,
    );
  });

  return app;
}
