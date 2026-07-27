import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadModelsConfig } from "@contractix/shared";

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
import { cases, documents } from "../db/schema/index.js";
import { type AppDeps } from "../deps.js";
import { buildPdf } from "../ingestion/parser/__fixtures__/pdf.js";
import { FakeEmbeddings, FakeLlm, PassthroughReranker } from "../providers/index.js";
import { createAnalysisQueue } from "../queue/analysis.js";
import { createRedis } from "../queue/connection.js";
import { createIngestQueue } from "../queue/ingest.js";
import { LocalBlobStore } from "../storage/local.js";

const OFFER = buildPdf([
  [
    { text: "Arbeitsvertrag", size: 18 },
    { text: "Die Probezeit betraegt sechs Monate.", size: 11 },
  ],
]);

interface Snapshot {
  caseId: string;
  documents: { documentId: string; phase: string; pageFailures: number[] }[];
  done: boolean;
}

/** Reads SSE frames until `until` matches or the stream ends. */
async function readEvents(
  res: Response,
  until: (event: string, data: Snapshot) => boolean,
): Promise<{ event: string; data: Snapshot }[]> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: Snapshot }[] = [];
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      const event = /^event:\s*(.*)$/m.exec(frame)?.[1] ?? "message";
      const raw = /^data:\s*(.*)$/m.exec(frame)?.[1] ?? "";
      if (!raw) continue;
      const data = JSON.parse(raw) as Snapshot;
      events.push({ event, data });
      if (until(event, data)) {
        await reader.cancel();
        return events;
      }
    }
  }
  return events;
}

describe("analysis progress stream", () => {
  let app: { request(input: string, init?: RequestInit): Promise<Response> };
  let redis: ReturnType<typeof createRedis>;
  let storageDir: string;
  let tenantId: string;
  let caseId: string;
  let documentId: string;

  beforeAll(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "contractix-progress-"));
    redis = createRedis(process.env.REDIS_URL ?? "redis://localhost:6380");
    const blobStore = new LocalBlobStore(storageDir);
    await blobStore.init();

    tenantId = await createTestTenant(db, "progress");
    const c = await db
      .insert(cases)
      .values({ tenantId, title: "progress" })
      .returning({ id: cases.id });
    caseId = c[0]!.id;

    const stored = await blobStore.put(OFFER, ".pdf");
    const d = await db
      .insert(documents)
      .values({
        caseId,
        tenantId,
        sha256: stored.sha256,
        filename: "offer.pdf",
        mimeType: "application/pdf",
        byteSize: OFFER.byteLength,
      })
      .returning({ id: documents.id });
    documentId = d[0]!.id;

    const deps: AppDeps = {
      db,
      blobStore,
      ingestQueue: createIngestQueue(redis),
      analysisQueue: createAnalysisQueue(redis),
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
    };
    app = signedIn(createApp(deps), await sessionCookie(tenantId));
  });

  afterAll(async () => {
    await deleteTestTenant(db, tenantId);
    await fs.rm(storageDir, { recursive: true, force: true });
    await redis.quit();
    await pool.end();
  });

  const setStatus = (status: "uploaded" | "processing" | "ready" | "failed", analysis?: string) =>
    db
      .update(documents)
      .set({
        status,
        ...(analysis ? { analysisStatus: analysis as "analyzed" } : {}),
      })
      .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)));

  it("streams a first snapshot immediately, then a change, then done", async () => {
    await setStatus("processing", "pending");

    const res = await app.request(`/cases/${caseId}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Advance the pipeline while the stream is open; the poll must notice.
    // Awaited inside the timer on purpose: a drizzle builder is lazy and only
    // runs when it is awaited, so `void setStatus(...)` would build a query
    // and never execute it.
    setTimeout(() => {
      void (async () => {
        await setStatus("ready", "analyzed");
      })();
    }, 200);

    const events = await readEvents(res, (event) => event === "done");

    expect(events[0]!.event).toBe("progress");
    expect(events[0]!.data.documents[0]!.phase).toBe("parsing");

    const last = events.at(-1)!;
    expect(last.event).toBe("done");
    expect(last.data.done).toBe(true);
    expect(last.data.documents[0]!.phase).toBe("ready");
  });

  // Every event is derived from persisted state, so a client that connects
  // after everything finished still gets the full picture rather than silence.
  it("is correct for a client that connects late", async () => {
    await setStatus("ready", "analyzed");

    const res = await app.request(`/cases/${caseId}/events`);
    const events = await readEvents(res, (event) => event === "done");

    expect(events).toHaveLength(2);
    expect(events[0]!.event).toBe("progress");
    expect(events[1]!.event).toBe("done");
    expect(events[1]!.data.documents[0]!.phase).toBe("ready");
  });

  it("reports a failed document as terminal rather than streaming forever", async () => {
    await setStatus("failed", "failed");

    const res = await app.request(`/cases/${caseId}/events`);
    const events = await readEvents(res, (event) => event === "done");

    expect(events.at(-1)!.data.documents[0]!.phase).toBe("failed");
    expect(events.at(-1)!.data.done).toBe(true);
  });

  it("404s another session's case", async () => {
    const otherTenant = await createTestTenant(db, "progress-other");
    const otherApp = signedIn(
      createApp({
        db,
        blobStore: new LocalBlobStore(storageDir),
        ingestQueue: createIngestQueue(redis),
        analysisQueue: createAnalysisQueue(redis),
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
      }),
      await sessionCookie(otherTenant),
    );

    expect((await otherApp.request(`/cases/${caseId}/events`)).status).toBe(404);
    await deleteTestTenant(db, otherTenant);
  });
});
