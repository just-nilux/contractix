/**
 * The narrative report endpoints (FR-5.3).
 *
 * Generated on demand rather than chained onto the analysis worker: not every
 * visitor scrolls to it, a frontier call per upload is real money, and putting
 * it in the queue would block ingestion behind the slowest provider.
 *
 * So the web does GET-then-POST-on-404: show the stored one instantly if there
 * is one, otherwise stream a fresh one.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { streamSSE } from "hono/streaming";

import { costEur } from "@contractix/shared";

import { latestNarrative, saveNarrativeTurn } from "../agent/qa-store.js";
import { type NarrativeEvent, writeNarrativeReport } from "../agent/report-writer.js";
import { type AppEnv, requireTenant, tenantOf } from "../auth/middleware.js";
import { rateLimit, RATE_LIMITED_RESPONSE } from "../auth/rate-limit.js";
import { cases } from "../db/schema/index.js";
import { type AppDeps } from "../deps.js";
import { logger } from "../logger.js";

/** FR-7.6 — a narrative says what it is, like every other surface. */
const DISCLAIMER =
  "Informational analysis, not legal or tax advice. Statutory references are pointers, not determinations.";

const narrativeCitationSchema = z.object({
  clauseId: z.uuid(),
  documentId: z.uuid(),
  charStart: z.number().int(),
  charEnd: z.number().int(),
});

const narrativeSchema = z.object({
  turnId: z.uuid(),
  markdown: z.string(),
  disclaimer: z.string(),
  citations: z.array(narrativeCitationSchema),
  couldNotVerify: z.array(z.string()),
  grounded: z.boolean(),
  corrected: z.boolean(),
  promptVersion: z.string(),
  createdAt: z.iso.datetime(),
  trace: z.unknown(),
});

const getNarrative = createRoute({
  method: "get",
  path: "/cases/{id}/narrative",
  summary: "The latest narrative report for a case, if one exists",
  middleware: requireTenant,
  request: {
    params: z.object({ id: z.uuid() }),
    query: z.object({ document_id: z.uuid().optional() }),
  },
  responses: {
    200: {
      description: "Stored narrative",
      content: { "application/json": { schema: narrativeSchema } },
    },
    401: { description: "No session, or the session expired" },
    404: { description: "Case not found, or no narrative generated yet" },
  },
});

const postNarrative = (deps: AppDeps) =>
  createRoute({
    method: "post",
    path: "/cases/{id}/narrative",
    summary: "Generate a narrative report (SSE stream)",
    description:
      "Streams Server-Sent Events by default; send `Accept: application/json` for one " +
      "buffered response with the same body as the terminal `done` event.\n\n" +
      "Events: `token` `{text}` — markdown delta; `retry` `{reason}` — the grounding " +
      "validator rejected the draft; `restart` — discard what you have, the corrected text " +
      "follows; `done` — the full body below; `error` `{message}`.\n\n" +
      "**Always replace your buffer with `done.markdown`.** When a correction fires, the " +
      "tokens streamed before `restart` came from the rejected draft.",
    middleware: [rateLimit(deps, "narrative"), requireTenant] as const,
    request: {
      params: z.object({ id: z.uuid() }),
      query: z.object({ document_id: z.uuid().optional() }),
    },
    responses: {
      200: {
        description: "Narrative (SSE stream, or JSON when Accept: application/json)",
        content: { "application/json": { schema: narrativeSchema } },
      },
      401: { description: "No session, or the session expired" },
      404: { description: "Case not found" },
      ...RATE_LIMITED_RESPONSE,
    },
  });

export function narrativeRoutes(deps: AppDeps) {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(getNarrative, async (c) => {
    const { id: caseId } = c.req.valid("param");
    const { document_id: documentId } = c.req.valid("query");
    const tenantId = tenantOf(c);

    const stored = await latestNarrative(
      { db: deps.db },
      { caseId, tenantId, ...(documentId ? { documentId } : {}) },
    );
    if (!stored) return c.body(null, 404);

    return c.json(
      {
        turnId: stored.turnId,
        markdown: stored.markdown,
        disclaimer: DISCLAIMER,
        citations: stored.citations,
        couldNotVerify: stored.couldNotVerify,
        grounded: stored.grounded,
        corrected: stored.corrected,
        promptVersion: stored.promptVersion,
        createdAt: stored.createdAt.toISOString(),
        trace: stored.trace,
      },
      200,
    );
  });

  app.openapi(postNarrative(deps), async (c) => {
    const { id: caseId } = c.req.valid("param");
    const { document_id: documentId } = c.req.valid("query");
    const tenantId = tenantOf(c);

    const owned = await deps.db
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.id, caseId), eq(cases.tenantId, tenantId)))
      .limit(1);
    if (!owned[0]) return c.body(null, 404);

    const wantsJson = c.req.header("accept")?.includes("application/json") ?? false;

    const run = async (onEvent?: (event: NarrativeEvent) => void) => {
      const result = await writeNarrativeReport(
        { db: deps.db, agentLlm: deps.providers.agentLlm },
        {
          caseId,
          tenantId,
          ...(documentId ? { documentId } : {}),
          ...(onEvent ? { onEvent } : {}),
        },
      );

      const eur = costEur(deps.models.llm, "model", result.usage);
      const turn = await saveNarrativeTurn(
        { db: deps.db },
        {
          tenantId,
          caseId,
          ...(documentId ? { documentId } : {}),
          result,
          costEur: eur,
        },
      );

      logger.info(
        {
          caseId,
          turnId: turn.id,
          grounded: result.grounded,
          corrected: result.corrected,
          stubbed: result.trace.stubbed,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costEur: eur,
          latencyMs: result.latencyMs,
        },
        "narrative report written",
      );

      return {
        turnId: turn.id,
        markdown: result.markdown,
        disclaimer: DISCLAIMER,
        citations: result.citations.map((x) => ({
          clauseId: x.clauseId,
          documentId: x.documentId,
          charStart: x.charStart,
          charEnd: x.charEnd,
        })),
        couldNotVerify: result.couldNotVerify,
        grounded: result.grounded,
        corrected: result.corrected,
        promptVersion: result.promptVersion,
        createdAt: turn.createdAt.toISOString(),
        trace: result.trace,
      };
    };

    if (wantsJson) return c.json(await run(), 200);

    return streamSSE(c, async (stream) => {
      // Serialize writes: the writer emits synchronously, and concurrent
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
        logger.error({ err, caseId }, "narrative report failed");
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
