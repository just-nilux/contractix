import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadModelsConfig } from "@contractix/shared";

import { createApp } from "../app.js";
import { createTestTenant, deleteTestTenant, sessionCookie, signedIn, TEST_AUTH } from "../auth/testing.js";
import { db, pool } from "../db/client.js";
import { cases, documents } from "../db/schema/index.js";
import { type AppDeps } from "../deps.js";
import { buildPdf } from "../ingestion/parser/__fixtures__/pdf.js";
import { runIngestion } from "../ingestion/pipeline.js";
import { FakeEmbeddings, FakeLlm, PassthroughReranker } from "../providers/index.js";
import { createAnalysisQueue } from "../queue/analysis.js";
import { createRedis } from "../queue/connection.js";
import { createIngestQueue } from "../queue/ingest.js";
import { LocalBlobStore } from "../storage/local.js";

const OFFER = buildPdf([
  [
    { text: "Arbeitsvertrag", size: 18 },
    { text: "1. Probezeit", size: 14 },
    { text: "Die Probezeit betraegt sechs Monate ab Vertragsbeginn.", size: 11 },
    { text: "2. Urlaub", size: 14 },
    { text: "Es besteht Anspruch auf dreissig Tage Urlaub.", size: 11 },
  ],
]);

describe("search and clause routes", () => {
  let storageDir: string;
  let caseId: string;
  let app: { request(input: string, init?: RequestInit): Promise<Response> };
  let tenantId: string;
  let redis: ReturnType<typeof createRedis>;

  beforeAll(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "contractix-routes-"));
    const blobStore = new LocalBlobStore(storageDir);
    await blobStore.init();
    redis = createRedis(process.env.REDIS_URL ?? "redis://localhost:6380");

    const embeddings = new FakeEmbeddings(1024);
    tenantId = await createTestTenant(db, "route-search");
    const c = await db
      .insert(cases)
      .values({ tenantId, title: "route search" })
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
    await runIngestion({ db, blobStore, embeddings }, d[0]!.id);

    const deps: AppDeps = {
      db,
      blobStore,
      ingestQueue: createIngestQueue(redis),
      analysisQueue: createAnalysisQueue(redis),
      providers: {
        embeddings,
        reranker: new PassthroughReranker(),
        llm: new FakeLlm(),
        agentLlm: new FakeLlm(),
      },
      models: loadModelsConfig(),
      maxUploadBytes: 25 * 1024 * 1024,
      auth: TEST_AUTH,
    };
    app = signedIn(createApp(deps), await sessionCookie(tenantId));
  });

  afterAll(async () => {
    await deleteTestTenant(db, tenantId);
    await fs.rm(storageDir, { recursive: true, force: true });
    await redis.quit();
    await pool.end();
  });

  it("GET /cases/:id/search returns cited clauses", async () => {
    const res = await app.request(
      `/cases/${caseId}/search?q=${encodeURIComponent("Probezeit")}&top_k=3`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      query: string;
      results: {
        clauseRef: string;
        serializedClauseId: string;
        page: number;
        charStart: number;
        charEnd: number;
        snippet: string;
      }[];
    };
    expect(body.results.length).toBeGreaterThan(0);
    const top = body.results[0]!;
    expect(top.clauseRef).toBe("1:1");
    expect(top.serializedClauseId).toMatch(/^[0-9a-f-]{36}:1:1$/);
    expect(top.charEnd).toBeGreaterThan(top.charStart);
  });

  it("GET /clauses/:id and /context resolve structural citations", async () => {
    const search = await app.request(`/cases/${caseId}/search?q=Urlaub`);
    const body = (await search.json()) as { results: { clauseId: string }[] };
    const clauseId = body.results[0]!.clauseId;

    const clauseRes = await app.request(`/clauses/${clauseId}`);
    expect(clauseRes.status).toBe(200);
    const clause = (await clauseRes.json()) as { text: string; clausePath: string };
    expect(clause.clausePath).toBe("2");
    expect(clause.text).toContain("dreissig Tage Urlaub");

    const ctxRes = await app.request(`/clauses/${clauseId}/context?radius=1`);
    expect(ctxRes.status).toBe(200);
    const ctx = (await ctxRes.json()) as {
      clause: { clausePath: string };
      before: { clausePath: string }[];
      after: { clausePath: string }[];
    };
    expect(ctx.clause.clausePath).toBe("2");
    expect(ctx.before.at(-1)?.clausePath).toBe("1");
    expect(ctx.after).toEqual([]);
  });

  it("404s foreign or unknown ids", async () => {
    const unknown = "0197a3b2-1c4d-7e5f-8a9b-0c1d2e3f4a5b";
    expect((await app.request(`/cases/${unknown}/search?q=x`)).status).toBe(404);
    expect((await app.request(`/clauses/${unknown}`)).status).toBe(404);
  });
});
