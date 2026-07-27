import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
import { type AppDeps } from "../deps.js";
import { runAnalysis } from "../extraction/analysis-service.js";
import { buildPdf } from "../ingestion/parser/__fixtures__/pdf.js";
import { runIngestion } from "../ingestion/pipeline.js";
import { FakeEmbeddings, FakeLlm, PassthroughReranker } from "../providers/index.js";
import { createAnalysisQueue, type AnalysisQueue } from "../queue/analysis.js";
import { createRedis } from "../queue/connection.js";
import { createIngestQueue, type IngestQueue } from "../queue/ingest.js";
import { LocalBlobStore } from "../storage/local.js";

const OFFER = buildPdf([
  [
    { text: "Arbeitsvertrag", size: 18 },
    { text: "1. Probezeit", size: 14 },
    { text: "Die Probezeit betraegt sechs Monate ab Vertragsbeginn.", size: 11 },
    { text: "2. Verguetung", size: 14 },
    { text: "Das Jahresgehalt betraegt neunzigtausend Euro.", size: 11 },
  ],
]);

describe("report + analyze routes (integration)", () => {
  let deps: AppDeps;
  let ingestQueue: IngestQueue;
  let analysisQueue: AnalysisQueue;
  let redis: ReturnType<typeof createRedis>;
  let storageDir: string;
  let app: { request(input: string, init?: RequestInit): Promise<Response> };
  let tenantId: string;

  beforeAll(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "contractix-report-"));
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
    // The analysis functions are driven below the HTTP layer here, so this
    // suite needs the tenant id as well as a session for it.
    tenantId = await createTestTenant(db, "reports");
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

  async function createCase(): Promise<string> {
    const res = await app.request("/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "report test" }),
    });
    return ((await res.json()) as { id: string }).id;
  }

  async function upload(caseId: string, bytes: Uint8Array, filename: string): Promise<string> {
    const form = new FormData();
    form.set("file", new File([bytes], filename, { type: "application/pdf" }));
    const res = await app.request(`/cases/${caseId}/documents`, { method: "POST", body: form });
    return ((await res.json()) as { document: { id: string } }).document.id;
  }

  it("upload → ingest → analyze → report, end to end (keyless)", async () => {
    const caseId = await createCase();
    const documentId = await upload(caseId, OFFER, "offer.pdf");

    // CI runs no worker: drive the exact functions the workers call, inline.
    const ingested = await runIngestion(
      { db, blobStore: deps.blobStore, embeddings: deps.providers.embeddings },
      documentId,
    );
    expect(ingested.status).toBe("ready");

    const analyzeRes = await app.request(`/documents/${documentId}/analyze`, { method: "POST" });
    expect(analyzeRes.status).toBe(202);
    expect(((await analyzeRes.json()) as { analysisStatus: string }).analysisStatus).toBe(
      "analyzing",
    );

    await runAnalysis({ db, llm: new FakeLlm() }, { documentId, tenantId });

    const reportRes = await app.request(`/documents/${documentId}/report`);
    expect(reportRes.status).toBe(200);
    const report = (await reportRes.json()) as {
      document: { type: string | null; analysisStatus: string };
      disclaimer: string;
      extraction: unknown;
      flags: unknown[];
      summary: { flagCounts: { red: number; amber: number; info: number } };
    };
    expect(report.disclaimer).toMatch(/not legal or tax advice/u);
    expect(report.document.type).toBe("other"); // keyless classifier
    expect(report.document.analysisStatus).toBe("analyzed");
    expect(report.extraction).toBeNull(); // 'other' has no extraction family
    expect(report.flags).toEqual([]);
    expect(report.summary.flagCounts).toEqual({ red: 0, amber: 0, info: 0 });

    // analysisStatus is surfaced on the plain document for polling
    const docRes = await app.request(`/documents/${documentId}`);
    expect(((await docRes.json()) as { analysisStatus: string }).analysisStatus).toBe("analyzed");

    // case-level aggregation includes the document's report
    const caseReportRes = await app.request(`/cases/${caseId}/report`);
    expect(caseReportRes.status).toBe(200);
    const caseReport = (await caseReportRes.json()) as {
      documents: unknown[];
      summary: { documentCount: number };
    };
    expect(caseReport.summary.documentCount).toBe(1);
    expect(caseReport.documents).toHaveLength(1);
  });

  it("404s a report for an unknown document", async () => {
    const res = await app.request(`/documents/0197a3b2-1c4d-7e5f-8a9b-0c1d2e3f4a5b/report`);
    expect(res.status).toBe(404);
  });

  it("409s analyze on a document that is not ready", async () => {
    const caseId = await createCase();
    const documentId = await upload(caseId, OFFER, "notready.pdf");
    // Uploaded but never ingested — status is still 'uploaded'.
    const res = await app.request(`/documents/${documentId}/analyze`, { method: "POST" });
    expect(res.status).toBe(409);
  });
});
