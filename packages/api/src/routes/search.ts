import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";

import { searchResponseSchema } from "@contractix/shared";

import { cases } from "../db/schema/index.js";
import { type AppEnv, requireTenant, tenantOf } from "../auth/middleware.js";
import { type AppDeps } from "../deps.js";
import { searchClauses } from "../retrieval/search-service.js";

const searchRoute = createRoute({
  method: "get",
  path: "/cases/{caseId}/search",
  summary: "Hybrid clause search with structural citations",
  description:
    "pgvector HNSW + language-aware full-text + trigram, fused with RRF (k=60), " +
    "reranked to top-k clauses. Every hit carries clause_ref + char offsets (FR-1.4).",
  middleware: requireTenant,
  request: {
    params: z.object({ caseId: z.uuid() }),
    query: z.object({
      q: z.string().min(1).max(500),
      doc_id: z.uuid().optional(),
      top_k: z.coerce.number().int().min(1).max(20).default(8),
    }),
  },
  responses: {
    200: {
      description: "Ranked clause citations",
      content: { "application/json": { schema: searchResponseSchema } },
    },
    401: { description: "No session, or the session expired" },
    404: { description: "Case not found" },
  },
});

export function searchRoutes(deps: AppDeps) {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(searchRoute, async (c) => {
    const { caseId } = c.req.valid("param");
    const { q, doc_id, top_k } = c.req.valid("query");
    const tenantId = tenantOf(c);

    const owningCase = await deps.db
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.id, caseId), eq(cases.tenantId, tenantId)))
      .limit(1);
    if (!owningCase[0]) return c.body(null, 404);

    const results = await searchClauses(
      { db: deps.db, embeddings: deps.providers.embeddings, reranker: deps.providers.reranker },
      { tenantId, caseId, documentId: doc_id, query: q, topK: top_k },
    );
    return c.json({ query: q, results }, 200);
  });

  return app;
}
