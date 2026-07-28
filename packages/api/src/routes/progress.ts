/**
 * Streamed analysis progress (PRD §9: "streamed progress (parse → extract →
 * benchmark → report)").
 *
 * Backed by a short DB poll rather than Redis pub/sub from the worker. Pub/sub
 * events are ephemeral: a client that connects a second late, or reconnects,
 * sees nothing - so a DB snapshot on connect is needed either way, which makes
 * pub/sub *snapshot + delta*, and the delta only buys sub-second latency on a
 * pipeline whose stages take seconds to minutes. Polling persisted state means
 * reconnection is correct for free and there is no cross-process contract to
 * keep in sync. The Phase-4 upgrade, if it is ever worth it, touches this file
 * and nothing else.
 *
 * Phases come from the two status columns the worker already writes, so this
 * adds no column and no write:
 *   status=processing         → parse
 *   analysisStatus=analyzing  → extract → benchmark
 *   analysisStatus=analyzed   → report ready
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { streamSSE } from "hono/streaming";

import { type AnalysisPhase, derivePhase, progressSchema } from "@contractix/shared";

import { type AppEnv, requireTenant, tenantOf } from "../auth/middleware.js";
import { cases, documents } from "../db/schema/index.js";
import { type AppDeps } from "../deps.js";

const POLL_MS = 750;
const HEARTBEAT_MS = 15_000;
/** A browser tab left open overnight should not hold a connection forever. */
const MAX_STREAM_MS = 5 * 60_000;

interface DocRow {
  id: string;
  filename: string;
  status: string;
  analysisStatus: string;
  parseReport: { pages?: { page: number; status: string }[] } | null;
}

const TERMINAL: readonly AnalysisPhase[] = ["ready", "failed"];

function snapshot(caseId: string, rows: DocRow[]) {
  const docs = rows.map((row) => ({
    documentId: row.id,
    filename: row.filename,
    phase: derivePhase(row),
    status: row.status,
    analysisStatus: row.analysisStatus,
    pageFailures: (row.parseReport?.pages ?? [])
      .filter((p) => p.status === "error")
      .map((p) => p.page),
  }));

  return {
    caseId,
    documents: docs,
    // `analyzed` only arrives once someone asks for analysis, so a case whose
    // documents are merely ingested is not "done" - the client decides when to
    // stop by watching phases, and the flag is a convenience for the common path.
    done: docs.length > 0 && docs.every((d) => TERMINAL.includes(d.phase)),
  };
}

const progressRoute = createRoute({
  method: "get",
  path: "/cases/{id}/events",
  summary: "Streamed analysis progress for a case (SSE)",
  description:
    "Emits a `progress` event whenever any document's phase changes, a comment heartbeat " +
    "every 15 s, and a terminal `done` once every document is ready or failed. Every event " +
    "is derived from persisted state, so reconnecting is always correct. Closes after 5 min.",
  middleware: requireTenant,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description:
        "SSE stream of progress snapshots; each `progress`/`done` event carries this body",
      content: { "text/event-stream": { schema: progressSchema } },
    },
    401: { description: "No session, or the session expired" },
    404: { description: "Not found" },
  },
});

export function progressRoutes(deps: AppDeps) {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(progressRoute, async (c) => {
    const { id: caseId } = c.req.valid("param");
    const tenantId = tenantOf(c);

    const owned = await deps.db
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.id, caseId), eq(cases.tenantId, tenantId)))
      .limit(1);
    if (!owned[0]) return c.body(null, 404);

    const load = () =>
      deps.db
        .select({
          id: documents.id,
          filename: documents.filename,
          status: documents.status,
          analysisStatus: documents.analysisStatus,
          parseReport: documents.parseReport,
        })
        .from(documents)
        .where(and(eq(documents.caseId, caseId), eq(documents.tenantId, tenantId)))
        .orderBy(documents.createdAt);

    return streamSSE(c, async (stream) => {
      const startedAt = Date.now();
      let lastSent = "";
      let lastBeatAt = startedAt;

      // The first event is always sent, however long the client took to
      // connect - that is what makes a reconnect indistinguishable from a
      // first connect.
      for (;;) {
        const body = snapshot(caseId, await load());
        const serialized = JSON.stringify(body);

        if (serialized !== lastSent) {
          await stream.writeSSE({ event: "progress", data: serialized });
          lastSent = serialized;
          lastBeatAt = Date.now();
        }

        if (body.done) {
          await stream.writeSSE({ event: "done", data: serialized });
          return;
        }

        if (Date.now() - startedAt > MAX_STREAM_MS) {
          await stream.writeSSE({ event: "timeout", data: serialized });
          return;
        }

        // Keeps proxies and load balancers from reaping an idle connection.
        if (Date.now() - lastBeatAt > HEARTBEAT_MS) {
          await stream.writeSSE({ data: "", event: "heartbeat" });
          lastBeatAt = Date.now();
        }

        await stream.sleep(POLL_MS);
        if (stream.aborted || stream.closed) return;
      }
    });
  });

  return app;
}
