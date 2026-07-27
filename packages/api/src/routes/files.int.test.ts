import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadModelsConfig } from "@contractix/shared";

import { createApp } from "../app.js";
import { DEFAULT_RATE_LIMITS, NoopRateLimiter } from "../auth/rate-limit.js";
import {
  createTestTenant,
  deleteTestTenant,
  sessionCookie,
  signedIn,
  TEST_AUTH,
} from "../auth/testing.js";
import { db, pool } from "../db/client.js";
import { cases, clauses, documents } from "../db/schema/index.js";
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

interface Layout {
  geometry: boolean;
  pageCount: number | null;
  pages: { page: number; width: number; height: number }[];
  blocks: {
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
    charStart: number;
    charEnd: number;
  }[];
}

describe("document bytes and layout", () => {
  let app: { request(input: string, init?: RequestInit): Promise<Response> };
  let redis: ReturnType<typeof createRedis>;
  let storageDir: string;
  let tenantId: string;
  let documentId: string;
  let sha256: string;

  beforeAll(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "contractix-files-"));
    redis = createRedis(process.env.REDIS_URL ?? "redis://localhost:6380");
    const blobStore = new LocalBlobStore(storageDir);
    await blobStore.init();
    const embeddings = new FakeEmbeddings(1024);

    tenantId = await createTestTenant(db, "files");
    const c = await db
      .insert(cases)
      .values({ tenantId, title: "files" })
      .returning({ id: cases.id });

    const stored = await blobStore.put(OFFER, ".pdf");
    sha256 = stored.sha256;
    const d = await db
      .insert(documents)
      .values({
        caseId: c[0]!.id,
        tenantId,
        sha256,
        filename: 'Angebot "Senior".pdf',
        mimeType: "application/pdf",
        byteSize: OFFER.byteLength,
      })
      .returning({ id: documents.id });
    documentId = d[0]!.id;
    await runIngestion({ db, blobStore, embeddings }, documentId);

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
      rateLimiter: new NoopRateLimiter(),
      rateLimits: DEFAULT_RATE_LIMITS,
    };
    app = signedIn(createApp(deps), await sessionCookie(tenantId));
  });

  afterAll(async () => {
    await deleteTestTenant(db, tenantId);
    await fs.rm(storageDir, { recursive: true, force: true });
    await redis.quit();
    await pool.end();
  });

  it("serves the original bytes with a content-hash ETag", async () => {
    const res = await app.request(`/documents/${documentId}/file`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("etag")).toBe(`"${sha256}"`);
    expect(res.headers.get("cache-control")).toContain("private");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBe(OFFER.byteLength);
    expect(bytes).toEqual(OFFER);
  });

  it("honours If-None-Match", async () => {
    const res = await app.request(`/documents/${documentId}/file`, {
      headers: { "if-none-match": `"${sha256}"` },
    });
    expect(res.status).toBe(304);
  });

  // A filename reaches a response header, which is the one injection risk here.
  it("neutralises quotes and newlines in the filename", async () => {
    const res = await app.request(`/documents/${documentId}/file`);
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain('filename="Angebot _Senior_.pdf"');
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).not.toContain('"Senior"');
  });

  it("returns block geometry against the frozen offsets", async () => {
    const res = await app.request(`/documents/${documentId}/layout`);
    expect(res.status).toBe(200);
    const layout = (await res.json()) as Layout;

    expect(layout.geometry).toBe(true);
    expect(layout.pages).toHaveLength(1);
    expect(layout.pages[0]!.width).toBeGreaterThan(0);
    expect(layout.blocks.length).toBeGreaterThan(0);
    // Page-box relative, so within the page it describes.
    for (const b of layout.blocks) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(layout.pages[0]!.width + 1);
      expect(b.charEnd).toBeGreaterThan(b.charStart);
    }

    // The point of the whole route: every clause span the citation layer can
    // produce must overlap at least one block, or the viewer has nothing to
    // draw. This is the invariant that keeps the highlighter honest.
    const clauseRows = await db
      .select({ charStart: clauses.charStart, charEnd: clauses.charEnd })
      .from(clauses)
      .where(and(eq(clauses.documentId, documentId), eq(clauses.tenantId, tenantId)));
    expect(clauseRows.length).toBeGreaterThan(0);
    for (const clause of clauseRows) {
      const overlapping = layout.blocks.filter(
        (b) => b.charEnd > clause.charStart && b.charStart < clause.charEnd,
      );
      expect(overlapping.length).toBeGreaterThan(0);
    }
  });

  it("404s another tenant's document on both routes", async () => {
    const otherTenant = await createTestTenant(db, "files-other");
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
      }),
      await sessionCookie(otherTenant),
    );

    expect((await otherApp.request(`/documents/${documentId}/file`)).status).toBe(404);
    expect((await otherApp.request(`/documents/${documentId}/layout`)).status).toBe(404);
    await deleteTestTenant(db, otherTenant);
  });
});
