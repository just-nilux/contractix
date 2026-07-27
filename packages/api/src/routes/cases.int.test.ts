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
import { cases, clauses, documents } from "../db/schema/index.js";
import { type AppDeps } from "../deps.js";
import { buildPdf } from "../ingestion/parser/__fixtures__/pdf.js";
import { runIngestion } from "../ingestion/pipeline.js";
import { FakeEmbeddings, FakeLlm, PassthroughReranker } from "../providers/index.js";
import { createAnalysisQueue } from "../queue/analysis.js";
import { createRedis } from "../queue/connection.js";
import { createIngestQueue } from "../queue/ingest.js";
import { LocalBlobStore } from "../storage/local.js";

const doc = (n: number) =>
  buildPdf([
    [
      { text: `Vertrag ${n}`, size: 18 },
      { text: "1. Probezeit", size: 14 },
      { text: `Die Probezeit betraegt ${n} Monate ab Vertragsbeginn.`, size: 11 },
    ],
  ]);

describe("case list, delete and document limits", () => {
  let app: { request(input: string, init?: RequestInit): Promise<Response> };
  let deps: AppDeps;
  let redis: ReturnType<typeof createRedis>;
  let storageDir: string;
  let tenantId: string;

  const upload = (caseId: string, bytes: Uint8Array, filename: string) => {
    const form = new FormData();
    form.set("file", new File([bytes], filename, { type: "application/pdf" }));
    return app.request(`/cases/${caseId}/documents`, { method: "POST", body: form });
  };

  async function newCase(title: string): Promise<string> {
    const res = await app.request("/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  beforeAll(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "contractix-cases-"));
    redis = createRedis(process.env.REDIS_URL ?? "redis://localhost:6380");
    const blobStore = new LocalBlobStore(storageDir);
    await blobStore.init();

    deps = {
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
    tenantId = await createTestTenant(db, "cases");
    app = signedIn(createApp(deps), await sessionCookie(tenantId));
  });

  afterAll(async () => {
    await deleteTestTenant(db, tenantId);
    await fs.rm(storageDir, { recursive: true, force: true });
    await redis.quit();
    await pool.end();
  });

  it("lists this session's cases newest first, with document counts", async () => {
    const first = await newCase("older");
    const second = await newCase("newer");
    await upload(first, doc(1), "one.pdf");

    const res = await app.request("/cases");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cases: { id: string; title: string; documentCount: number }[];
    };

    expect(body.cases.map((k) => k.id)).toEqual([second, first]);
    expect(body.cases.find((k) => k.id === first)!.documentCount).toBe(1);
    expect(body.cases.find((k) => k.id === second)!.documentCount).toBe(0);
  });

  it("does not list another session's cases", async () => {
    const otherTenant = await createTestTenant(db, "cases-other");
    const otherApp = signedIn(createApp(deps), await sessionCookie(otherTenant));
    await otherApp.request("/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "theirs" }),
    });

    const mine = (await (await app.request("/cases")).json()) as { cases: { title: string }[] };
    expect(mine.cases.map((k) => k.title)).not.toContain("theirs");

    await deleteTestTenant(db, otherTenant);
  });

  // FR-7.3 hard delete: rows, derived rows, and the blob.
  it("deletes a case, everything derived from it, and its blob", async () => {
    const caseId = await newCase("to delete");
    const uploaded = await upload(caseId, doc(2), "two.pdf");
    const { document } = (await uploaded.json()) as {
      document: { id: string; sha256: string };
    };
    await runIngestion(
      { db, blobStore: deps.blobStore, embeddings: deps.providers.embeddings },
      document.id,
    );

    const clausesBefore = await db
      .select({ id: clauses.id })
      .from(clauses)
      .where(eq(clauses.documentId, document.id));
    expect(clausesBefore.length).toBeGreaterThan(0);
    expect(await deps.blobStore.exists(document.sha256, ".pdf")).toBe(true);

    const res = await app.request(`/cases/${caseId}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    expect(await db.select().from(cases).where(eq(cases.id, caseId))).toHaveLength(0);
    expect(await db.select().from(documents).where(eq(documents.id, document.id))).toHaveLength(0);
    expect(await db.select().from(clauses).where(eq(clauses.documentId, document.id))).toHaveLength(
      0,
    );
    expect(await deps.blobStore.exists(document.sha256, ".pdf")).toBe(false);
  });

  // Blobs are content-addressed and shared, so a delete must not pull the bytes
  // out from under a document in another case that still points at them.
  it("keeps a blob that another case still references", async () => {
    const keep = await newCase("keeps the blob");
    const drop = await newCase("gets deleted");
    const bytes = doc(3);

    const kept = (await (await upload(keep, bytes, "shared.pdf")).json()) as {
      document: { sha256: string };
    };
    await upload(drop, bytes, "shared.pdf");

    expect((await app.request(`/cases/${drop}`, { method: "DELETE" })).status).toBe(204);
    expect(await deps.blobStore.exists(kept.document.sha256, ".pdf")).toBe(true);
  });

  it("404s deleting another session's case", async () => {
    const otherTenant = await createTestTenant(db, "cases-del-other");
    const otherApp = signedIn(createApp(deps), await sessionCookie(otherTenant));
    const theirs = await otherApp.request("/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "theirs" }),
    });
    const theirCase = ((await theirs.json()) as { id: string }).id;

    expect((await app.request(`/cases/${theirCase}`, { method: "DELETE" })).status).toBe(404);
    expect(await db.select().from(cases).where(eq(cases.id, theirCase))).toHaveLength(1);

    await deleteTestTenant(db, otherTenant);
  });

  // FR-1.1 caps a case at 10 documents.
  it("409s the eleventh document, but never a re-upload of an existing one", async () => {
    const caseId = await newCase("full");
    for (let i = 0; i < 10; i++) {
      expect((await upload(caseId, doc(100 + i), `doc-${i}.pdf`)).status).toBe(201);
    }

    // Identical bytes dedupe to 200 even at the cap - the check is after dedupe.
    expect((await upload(caseId, doc(100), "doc-0-again.pdf")).status).toBe(200);
    expect((await upload(caseId, doc(999), "eleventh.pdf")).status).toBe(409);

    const rows = await db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.caseId, caseId), eq(documents.tenantId, tenantId)));
    expect(rows).toHaveLength(10);
  });

  it("serves the extraction slice of the report", async () => {
    const caseId = await newCase("extraction");
    const uploaded = await upload(caseId, doc(4), "four.pdf");
    const { document } = (await uploaded.json()) as { document: { id: string } };

    const res = await app.request(`/documents/${document.id}/extraction`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documentId: string; disclaimer: string };
    expect(body.documentId).toBe(document.id);
    // FR-7.6: an extraction says what it is, like every other surface.
    expect(body.disclaimer).toContain("not legal");

    const foreign = await app.request("/documents/0197a3b2-1c4d-7e5f-8a9b-0c1d2e3f4a5b/extraction");
    expect(foreign.status).toBe(404);
  });
});
