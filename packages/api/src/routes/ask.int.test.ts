import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadModelsConfig, parseClauseId } from "@contractix/shared";

import { createApp } from "../app.js";
import { DEFAULT_RATE_LIMITS, NoopRateLimiter } from "../auth/rate-limit.js";
import { DEFAULT_DEMO_CONFIG } from "../demo/template.js";
import {
  createTestTenant,
  deleteTestTenant,
  sessionCookie,
  signedIn,
  TEST_AUTH,
} from "../auth/testing.js";
import { db, pool } from "../db/client.js";
import { cases, citations, clauses, qaTurns, tenants } from "../db/schema/index.js";
import { type AppDeps } from "../deps.js";
import { buildPdf } from "../ingestion/parser/__fixtures__/pdf.js";
import { runIngestion } from "../ingestion/pipeline.js";
import { FakeEmbeddings, FakeLlm, PassthroughReranker } from "../providers/index.js";
import { type AnalysisQueue, createAnalysisQueue } from "../queue/analysis.js";
import { createRedis } from "../queue/connection.js";
import { createIngestQueue, type IngestQueue } from "../queue/ingest.js";
import { LocalBlobStore } from "../storage/local.js";

const OFFER = buildPdf([
  [
    { text: "Arbeitsvertrag", size: 18 },
    { text: "1. Probezeit", size: 14 },
    { text: "Die Probezeit betraegt sechs Monate ab Vertragsbeginn.", size: 11 },
    { text: "2. Wettbewerbsverbot", size: 14 },
    { text: "Eine Karenzentschaedigung wird nicht gezahlt.", size: 11 },
  ],
]);

interface AskBody {
  turnId: string;
  answer: string;
  disclaimer: string;
  citations: {
    clauseId: string;
    serializedClauseId: string;
    charStart: number;
    charEnd: number;
    verbatimAnchor: string;
  }[];
  couldNotVerify: string[];
  grounded: boolean;
  usage: { inputTokens: number; outputTokens: number; costEur: number; latencyMs: number };
  trace: { turns: number; steps: { tool: string }[]; stopReason: string };
}

describe("ask route (integration)", () => {
  let deps: AppDeps;
  let ingestQueue: IngestQueue;
  let analysisQueue: AnalysisQueue;
  let redis: ReturnType<typeof createRedis>;
  let storageDir: string;
  let app: { request(input: string, init?: RequestInit): Promise<Response> };
  let tenantId: string;

  beforeAll(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "contractix-ask-"));
    redis = createRedis(process.env.REDIS_URL ?? "redis://localhost:6380");
    ingestQueue = createIngestQueue(redis);
    analysisQueue = createAnalysisQueue(redis);
    await ingestQueue.obliterate({ force: true }).catch(() => undefined);
    await analysisQueue.obliterate({ force: true }).catch(() => undefined);
    const blobStore = new LocalBlobStore(storageDir);
    await blobStore.init();
    deps = {
      db,
      blobStore,
      ingestQueue,
      analysisQueue,
      providers: {
        embeddings: new FakeEmbeddings(1024),
        reranker: new PassthroughReranker(),
        llm: new FakeLlm(),
        agentLlm: new FakeLlm(),
      },
      models: loadModelsConfig(),
      maxUploadBytes: 25 * 1024 * 1024,
      auth: TEST_AUTH,
      rateLimiter: new NoopRateLimiter(),
      rateLimits: DEFAULT_RATE_LIMITS,
      demo: DEFAULT_DEMO_CONFIG,
      corsOrigins: [],
    };
    tenantId = await createTestTenant(db, "ask");
    app = signedIn(createApp(deps), await sessionCookie(tenantId));
  });

  afterAll(async () => {
    await deleteTestTenant(db, tenantId);
    await ingestQueue.close();
    await analysisQueue.close();
    await redis.quit();
    await fs.rm(storageDir, { recursive: true, force: true });
    await pool.end();
  });

  /** Upload + ingest inline; CI runs no worker. */
  async function seededCase(): Promise<string> {
    const created = await app.request("/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "ask test" }),
    });
    const caseId = ((await created.json()) as { id: string }).id;

    const form = new FormData();
    form.set("file", new File([OFFER], "offer.pdf", { type: "application/pdf" }));
    const uploaded = await app.request(`/cases/${caseId}/documents`, {
      method: "POST",
      body: form,
    });
    const documentId = ((await uploaded.json()) as { document: { id: string } }).document.id;

    const ingested = await runIngestion(
      { db, blobStore: deps.blobStore, embeddings: deps.providers.embeddings },
      documentId,
    );
    expect(ingested.status).toBe("ready");
    return caseId;
  }

  const ask = (caseId: string, question: string) =>
    app.request(`/cases/${caseId}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ question }),
    });

  it("answers with citations that resolve to real clause spans, and persists the turn", async () => {
    const caseId = await seededCase();
    const res = await ask(caseId, "Wie lang ist die Probezeit?");
    expect(res.status).toBe(200);
    const body = (await res.json()) as AskBody;

    expect(body.disclaimer).toContain("not legal or tax advice");
    expect(body.trace.steps.map((s) => s.tool)).toContain("search_clauses");
    expect(body.citations.length).toBeGreaterThan(0);
    // The keyless path must clear the grounding contract on its own; if it
    // needs the CRAG retry to pass, the fake and the validator have drifted.
    expect(body.grounded).toBe(true);
    expect(body.couldNotVerify).toEqual([]);

    // Every citation must name a real clause AND its stored span must be
    // exactly the frozen text at those offsets (ADR-0005) — this is the
    // invariant that makes the UI highlighter trustworthy.
    for (const citation of body.citations) {
      const [row] = await db
        .select()
        .from(clauses)
        .where(and(eq(clauses.id, citation.clauseId), eq(clauses.tenantId, tenantId)))
        .limit(1);
      expect(row, `citation ${citation.serializedClauseId} names no clause`).toBeDefined();
      expect(citation.charStart).toBe(row!.charStart);
      expect(citation.charEnd).toBe(row!.charEnd);
      expect(citation.verbatimAnchor).toBe(row!.text);
      expect(() => parseClauseId(citation.serializedClauseId)).not.toThrow();
      // The marker the model emitted is the id we can resolve back.
      expect(body.answer).toContain(`[[${citation.serializedClauseId}]]`);
    }

    const [turn] = await db.select().from(qaTurns).where(eq(qaTurns.id, body.turnId)).limit(1);
    expect(turn).toBeDefined();
    expect(turn!.caseId).toBe(caseId);
    expect(turn!.question).toBe("Wie lang ist die Probezeit?");
    expect(turn!.answer).toBe(body.answer);
    expect(turn!.latencyMs).toBeGreaterThanOrEqual(0);

    const stored = await db
      .select()
      .from(citations)
      .where(and(eq(citations.answerId, body.turnId), eq(citations.sourceType, "answer")));
    expect(stored).toHaveLength(body.citations.length);
  });

  it("streams the same answer over SSE", async () => {
    const caseId = await seededCase();
    const res = await app.request(`/cases/${caseId}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Gibt es eine Karenzentschaedigung?" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const raw = await res.text();
    const events = raw
      .split(/\n\n/u)
      .filter((f) => f.trim().length > 0)
      .map((frame) => {
        const event = /^event:\s*(.+)$/mu.exec(frame)?.[1]?.trim() ?? "message";
        const data = /^data:\s*(.+)$/mu.exec(frame)?.[1] ?? "{}";
        return { event, data: JSON.parse(data) as Record<string, unknown> };
      });

    const kinds = events.map((e) => e.event);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("token");
    expect(kinds.at(-1)).toBe("done");

    const done = events.at(-1)!.data as unknown as AskBody;
    const streamed = events
      .filter((e) => e.event === "token")
      .map((e) => e.data.text as string)
      .join("");
    expect(streamed).toBe(done.answer);
    expect(done.turnId).toBeDefined();
  });

  it("404s a case in another tenant rather than answering it", async () => {
    const [other] = await db
      .insert(tenants)
      .values({ name: `ask-other-${Date.now()}`, kind: "user" })
      .returning();
    const [foreign] = await db
      .insert(cases)
      .values({ tenantId: other!.id, title: "not yours" })
      .returning();

    const res = await ask(foreign!.id, "Wie lang ist die Probezeit?");
    expect(res.status).toBe(404);

    const leaked = await db.select().from(qaTurns).where(eq(qaTurns.caseId, foreign!.id));
    expect(leaked).toHaveLength(0);
  });

  it("rejects an empty question before running the loop", async () => {
    const caseId = await seededCase();
    const res = await ask(caseId, "");
    expect(res.status).toBe(400);
  });
});
