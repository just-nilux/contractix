import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AskResponse, loadModelsConfig, parseClauseId } from "@contractix/shared";

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
import {
  FakeEmbeddings,
  FakeLlm,
  type LlmConverseOptions,
  type LlmConverseResult,
  PassthroughReranker,
} from "../providers/index.js";
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

/**
 * The published response type rather than a local restatement of it. This file
 * used to declare its own narrower copy, which meant the assertions below could
 * keep passing while the shape the route actually promises drifted away.
 */
type AskBody = AskResponse;

/**
 * `FakeLlm` plus a record of what it was last asked. The conversation history
 * is loaded server-side and never appears in a request or a response, so the
 * messages the provider was handed are the only place it is observable.
 */
class RecordingLlm extends FakeLlm {
  readonly seen: LlmConverseOptions[] = [];

  /** Call between requests: assertions are about the *first* turn of one request. */
  reset(): void {
    this.seen.length = 0;
  }

  /** What the loop opened the request with, before any tool result was appended. */
  get openingMessages(): LlmConverseOptions["messages"] {
    return this.seen[0]?.messages ?? [];
  }

  override converse(opts: LlmConverseOptions): Promise<LlmConverseResult> {
    // Snapshot: the loop mutates one array in place as it appends tool results.
    this.seen.push({ ...opts, messages: structuredClone(opts.messages) });
    return super.converse(opts);
  }
}

describe("ask route (integration)", () => {
  let deps: AppDeps;
  let llm: RecordingLlm;
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
        agentLlm: (llm = new RecordingLlm()),
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

  /**
   * The follow-up is the whole point: "und die Kündigungsfrist?" means nothing
   * without the question before it. History is read from `qa_turns` rather than
   * sent by the client, so this is the only place the wiring is observable.
   */
  it("carries the earlier exchange into a follow-up question", async () => {
    const caseId = await seededCase();
    await ask(caseId, "Wie lang ist die Probezeit?");

    llm.reset();
    const res = await ask(caseId, "Und die Kündigungsfrist?");
    expect(res.status).toBe(200);
    const body = (await res.json()) as AskBody;

    // Both turns persisted against the same case, in order.
    const turns = await db
      .select({ question: qaTurns.question, answer: qaTurns.answer })
      .from(qaTurns)
      .where(and(eq(qaTurns.caseId, caseId), eq(qaTurns.kind, "ask")))
      .orderBy(qaTurns.createdAt);
    expect(turns.map((t) => t.question)).toEqual([
      "Wie lang ist die Probezeit?",
      "Und die Kündigungsfrist?",
    ]);

    // What the model was actually opened with for the second question.
    const sent = llm.openingMessages;
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(sent[0]?.content[0]).toMatchObject({ text: "Wie lang ist die Probezeit?" });
    expect(sent[2]?.content[0]).toMatchObject({ text: "Und die Kündigungsfrist?" });

    // The replayed answer keeps its prose and loses its clause ids: they were
    // citable in the previous request, not this one (ADR-0010 point 4).
    const replayed = JSON.stringify(sent.slice(0, 2));
    expect(replayed).not.toContain("[[");
    // ...and the new answer still cites, from this request's own tool output.
    expect(body.citations.length).toBeGreaterThan(0);
    expect(body.grounded).toBe(true);
  });

  it("does not replay a narrative report as something the reader said", async () => {
    const caseId = await seededCase();
    await db.insert(qaTurns).values({
      tenantId,
      caseId,
      kind: "report",
      question: "narrative",
      answer: "## Summary\n\nA whole report that nobody asked as a question.",
      promptVersion: "report@1",
      traceJson: {
        model: "fake:llm",
        stopReason: "stub",
        citableClauseIds: [],
        promptVersion: "report@1",
        corrections: [],
        inputFields: 0,
        inputFlags: 0,
        stubbed: true,
      },
      grounded: true,
      corrected: false,
      inputTokens: 0,
      outputTokens: 0,
      costEur: "0",
      latencyMs: 1,
    });

    llm.reset();
    await ask(caseId, "Wie lang ist die Probezeit?");

    const sent = llm.openingMessages;
    expect(sent.map((m) => m.role)).toEqual(["user"]);
    expect(JSON.stringify(sent)).not.toContain("A whole report");
  });
});
