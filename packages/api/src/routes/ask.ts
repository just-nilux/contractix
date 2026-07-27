import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { streamSSE } from "hono/streaming";

import { costEur } from "@contractix/shared";

import { type AgentEvent, askCase } from "../agent/agent-service.js";
import { saveQaTurn } from "../agent/qa-store.js";
import { cases } from "../db/schema/index.js";
import { type AppEnv, requireTenant, tenantOf } from "../auth/middleware.js";
import { type AppDeps } from "../deps.js";
import { logger } from "../logger.js";

/** FR-7.6 — an answer says what it is, like every report does. */
const DISCLAIMER =
  "Informational analysis, not legal or tax advice. Statutory references are pointers, not determinations.";

const askRequestSchema = z.object({
  question: z.string().min(1).max(2_000),
});

const answerCitationSchema = z.object({
  clauseId: z.uuid(),
  serializedClauseId: z.string(),
  documentId: z.uuid(),
  page: z.number().int(),
  charStart: z.number().int(),
  charEnd: z.number().int(),
  verbatimAnchor: z.string(),
});

const askResponseSchema = z.object({
  turnId: z.uuid(),
  question: z.string(),
  answer: z.string(),
  disclaimer: z.string(),
  citations: z.array(answerCitationSchema),
  /**
   * Assertions the validator could not tie to a retrieved clause. Surfaced
   * rather than dropped (FR-5.2) — an unverifiable claim the user can see is
   * safer than one silently removed.
   */
  couldNotVerify: z.array(z.string()),
  grounded: z.boolean(),
  corrected: z.boolean(),
  usage: z.object({
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    costEur: z.number(),
    latencyMs: z.number().int(),
  }),
  trace: z.unknown(),
});

const askRoute = createRoute({
  method: "post",
  path: "/cases/{id}/ask",
  summary: "Ask a question about a case (agentic RAG, cited)",
  description:
    "Runs the agent tool loop over the case's clauses and returns a cited answer.\n\n" +
    "Streams Server-Sent Events by default. Send `Accept: application/json` for a single " +
    "buffered response with the same body as the terminal `done` event.\n\n" +
    "SSE events: `token` `{text}` — answer text delta; `tool_call` `{name,input}`; " +
    "`tool_result` `{name,ok,clauseCount}`; `retry` `{reason}` — the one corrective " +
    "regeneration; `done` — the full response body below; `error` `{message}`.\n\n" +
    "Every factual sentence carries a `[[clause_id]]` marker resolving to a real clause span. " +
    "Informational analysis, not legal advice.",
  middleware: requireTenant,
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { "application/json": { schema: askRequestSchema } } },
  },
  responses: {
    200: {
      description: "Cited answer (SSE stream, or JSON when Accept: application/json)",
      content: { "application/json": { schema: askResponseSchema } },
    },
    401: { description: "No session, or the session expired" },
    404: { description: "Case not found" },
  },
});

export function askRoutes(deps: AppDeps) {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(askRoute, async (c) => {
    const { id: caseId } = c.req.valid("param");
    const { question } = c.req.valid("json");
    const tenantId = tenantOf(c);

    const owned = await deps.db
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.id, caseId), eq(cases.tenantId, tenantId)))
      .limit(1);
    if (!owned[0]) return c.body(null, 404);

    const wantsJson = c.req.header("accept")?.includes("application/json") ?? false;

    const run = async (onEvent?: (event: AgentEvent) => void) => {
      const result = await askCase(
        {
          db: deps.db,
          embeddings: deps.providers.embeddings,
          reranker: deps.providers.reranker,
          agentLlm: deps.providers.agentLlm,
        },
        { caseId, tenantId, question, ...(onEvent ? { onEvent } : {}) },
      );

      const eur = costEur(deps.models.llm, "model", result.usage);
      const turn = await saveQaTurn(deps, {
        tenantId,
        caseId,
        question,
        result,
        costEur: eur,
      });

      logger.info(
        {
          caseId,
          turnId: turn.id,
          grounded: result.grounded,
          corrected: result.corrected,
          turns: result.trace.turns,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costEur: eur,
          latencyMs: result.latencyMs,
        },
        "qa turn answered",
      );

      return {
        turnId: turn.id,
        question,
        answer: result.answer,
        disclaimer: DISCLAIMER,
        citations: result.citations,
        couldNotVerify: result.couldNotVerify,
        grounded: result.grounded,
        corrected: result.corrected,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costEur: eur,
          latencyMs: result.latencyMs,
        },
        trace: result.trace,
      };
    };

    if (wantsJson) return c.json(await run(), 200);

    return streamSSE(c, async (stream) => {
      // Serialize writes: the agent emits synchronously, and concurrent
      // writeSSE calls would interleave frames.
      let chain: Promise<unknown> = Promise.resolve();
      const emit = (event: string, data: unknown) => {
        chain = chain.then(() => stream.writeSSE({ event, data: JSON.stringify(data) }));
      };

      try {
        const body = await run((ev) => {
          emit(ev.type, ev);
        });
        await chain;
        await stream.writeSSE({ event: "done", data: JSON.stringify(body) });
      } catch (err) {
        logger.error({ err, caseId }, "qa turn failed");
        await chain.catch(() => undefined);
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            message: err instanceof Error ? err.message : "internal error",
          }),
        });
      }
    });
  });

  return app;
}
