import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadModelsConfig } from "@contractix/shared";

import { createApp } from "../app.js";
import { DEFAULT_RATE_LIMITS, NoopRateLimiter } from "../auth/rate-limit.js";
import { cookieFrom, deleteTestTenant, TEST_AUTH } from "../auth/testing.js";
import { db, pool } from "../db/client.js";
import {
  cases,
  chunks,
  citations,
  clauses,
  documents,
  extractions,
  flags,
  tenants,
} from "../db/schema/index.js";
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

// A hermetic template of its own, so the suite is independent of whether
// `pnpm seed:demo` has been run against this database.
const DEMO = { tenantName: `demo-test-${Date.now()}`, caseTitle: "Demo Corpus Fixture" };

describe("demo adoption", () => {
  let app: ReturnType<typeof createApp>;
  let redis: ReturnType<typeof createRedis>;
  let storageDir: string;
  let templateTenantId: string;
  let templateCaseId: string;
  let templateDocumentId: string;
  const adoptedTenants: string[] = [];

  beforeAll(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "contractix-demo-"));
    redis = createRedis(process.env.REDIS_URL ?? "redis://localhost:6380");
    const blobStore = new LocalBlobStore(storageDir);
    await blobStore.init();
    const embeddings = new FakeEmbeddings(1024);

    // Stand in for `pnpm seed:demo`: a `demo`-kind tenant holding the corpus.
    const t = await db
      .insert(tenants)
      .values({ name: DEMO.tenantName, kind: "demo" })
      .returning({ id: tenants.id });
    templateTenantId = t[0]!.id;

    const c = await db
      .insert(cases)
      .values({ tenantId: templateTenantId, title: DEMO.caseTitle })
      .returning({ id: cases.id });
    templateCaseId = c[0]!.id;

    const stored = await blobStore.put(OFFER, ".pdf");
    const d = await db
      .insert(documents)
      .values({
        caseId: templateCaseId,
        tenantId: templateTenantId,
        sha256: stored.sha256,
        filename: "offer_de.pdf",
        mimeType: "application/pdf",
        byteSize: OFFER.byteLength,
        type: "employment_offer",
      })
      .returning({ id: documents.id });
    templateDocumentId = d[0]!.id;
    await runIngestion({ db, blobStore, embeddings }, templateDocumentId);

    // A flag with a clause_ids array, so the uuid[] remap is exercised.
    const clauseRows = await db
      .select({ id: clauses.id })
      .from(clauses)
      .where(eq(clauses.documentId, templateDocumentId))
      .orderBy(clauses.seq);
    const extraction = await db
      .insert(extractions)
      .values({
        documentId: templateDocumentId,
        tenantId: templateTenantId,
        caseId: templateCaseId,
        schemaVer: "employment@1",
        fieldPath: "probation.months",
        value: 6,
        confidence: "high",
        status: "extracted",
      })
      .returning({ id: extractions.id });
    await db.insert(citations).values({
      tenantId: templateTenantId,
      documentId: templateDocumentId,
      sourceType: "extraction",
      extractionId: extraction[0]!.id,
      clauseId: clauseRows[1]!.id,
      charStart: 0,
      charEnd: 10,
      verbatimAnchor: "Die Probeze",
    });
    await db.insert(flags).values({
      documentId: templateDocumentId,
      tenantId: templateTenantId,
      caseId: templateCaseId,
      ruleId: "DE-PROBEZEIT-MAX",
      ruleVersion: "1",
      severity: "red",
      clauseIds: [clauseRows[1]!.id, clauseRows[0]!.id],
      rationale: "test",
      sources: ["§622 BGB"],
    });

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
      demo: DEMO,
      corsOrigins: [],
    };
    app = createApp(deps);
  });

  afterAll(async () => {
    for (const id of adoptedTenants) await deleteTestTenant(db, id);
    await deleteTestTenant(db, templateTenantId);
    await fs.rm(storageDir, { recursive: true, force: true });
    await redis.quit();
    await pool.end();
  });

  async function adopt(cookie?: string) {
    const res = await app.request("/demo/adopt", {
      method: "POST",
      ...(cookie ? { headers: { cookie } } : {}),
    });
    const body = (await res.json()) as { caseId: string; documentCount: number };
    return { res, body };
  }

  it("serves a metadata-only catalogue without a session", async () => {
    const res = await app.request("/demo");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      available: boolean;
      documents: { filename: string; type: string | null }[];
    };
    expect(body.available).toBe(true);
    expect(body.documents.map((d) => d.filename)).toContain("offer_de.pdf");
    // Nothing derived from the documents' contents crosses tenants.
    expect(JSON.stringify(body)).not.toContain("Probezeit");
  });

  it("clones the corpus into a fresh session, rows and vectors alike", async () => {
    const { res, body } = await adopt();
    expect(res.status).toBe(201);
    expect(body.documentCount).toBe(1);

    const owner = await db
      .select({ tenantId: cases.tenantId })
      .from(cases)
      .where(eq(cases.id, body.caseId));
    const tenantId = owner[0]!.tenantId;
    adoptedTenants.push(tenantId);
    expect(tenantId).not.toBe(templateTenantId);

    const countClauses = async (tid: string, docId: string) =>
      (
        await db
          .select({ n: sql<number>`count(*)::int` })
          .from(clauses)
          .where(and(eq(clauses.tenantId, tid), eq(clauses.documentId, docId)))
      )[0]!.n;
    const countChunks = async (tid: string, docId: string) =>
      (
        await db
          .select({ n: sql<number>`count(*)::int` })
          .from(chunks)
          .where(and(eq(chunks.tenantId, tid), eq(chunks.documentId, docId)))
      )[0]!.n;

    const clone = await db
      .select({ id: documents.id, sha256: documents.sha256, filename: documents.filename })
      .from(documents)
      .where(and(eq(documents.caseId, body.caseId), eq(documents.tenantId, tenantId)));
    expect(clone).toHaveLength(1);
    const cloned = clone[0]!;
    expect(cloned.id).not.toBe(templateDocumentId);
    // Blobs are content-addressed, so the clone reuses the file rather than copying it.
    expect(cloned.sha256).toBe(
      (
        await db
          .select({ sha256: documents.sha256 })
          .from(documents)
          .where(eq(documents.id, templateDocumentId))
      )[0]!.sha256,
    );

    expect(await countClauses(tenantId, cloned.id)).toBe(
      await countClauses(templateTenantId, templateDocumentId),
    );
    expect(await countChunks(tenantId, cloned.id)).toBe(
      await countChunks(templateTenantId, templateDocumentId),
    );

    // The embedding is the expensive thing to get wrong: a clone with null or
    // truncated vectors would retrieve nothing and fail silently.
    const [source, copy] = await Promise.all([
      db
        .select({ embedding: chunks.embedding, text: chunks.text })
        .from(chunks)
        .where(eq(chunks.documentId, templateDocumentId))
        .orderBy(chunks.chunkIndex)
        .limit(1),
      db
        .select({ embedding: chunks.embedding, text: chunks.text })
        .from(chunks)
        .where(eq(chunks.documentId, cloned.id))
        .orderBy(chunks.chunkIndex)
        .limit(1),
    ]);
    expect(copy[0]!.text).toBe(source[0]!.text);
    expect(copy[0]!.embedding).toEqual(source[0]!.embedding);
    expect(copy[0]!.embedding).toHaveLength(1024);

    // Flags keep their clause_ids array remapped, in order, into the clone.
    const clonedFlags = await db
      .select({ clauseIds: flags.clauseIds, ruleId: flags.ruleId })
      .from(flags)
      .where(and(eq(flags.documentId, cloned.id), eq(flags.tenantId, tenantId)));
    expect(clonedFlags).toHaveLength(1);
    expect(clonedFlags[0]!.clauseIds).toHaveLength(2);
    const clonedClauseIds = new Set(
      (
        await db.select({ id: clauses.id }).from(clauses).where(eq(clauses.documentId, cloned.id))
      ).map((r) => r.id),
    );
    for (const id of clonedFlags[0]!.clauseIds) expect(clonedClauseIds.has(id)).toBe(true);

    // Extraction citations point at the clone's own clauses and extractions.
    const clonedCitations = await db
      .select({ clauseId: citations.clauseId, extractionId: citations.extractionId })
      .from(citations)
      .where(and(eq(citations.documentId, cloned.id), eq(citations.tenantId, tenantId)));
    expect(clonedCitations).toHaveLength(1);
    expect(clonedClauseIds.has(clonedCitations[0]!.clauseId)).toBe(true);
  });

  it("is idempotent for a session that already adopted", async () => {
    const first = await adopt();
    const cookie = cookieFrom(first.res);
    const owner = await db
      .select({ tenantId: cases.tenantId })
      .from(cases)
      .where(eq(cases.id, first.body.caseId));
    adoptedTenants.push(owner[0]!.tenantId);

    const second = await adopt(cookie);
    expect(second.res.status).toBe(200);
    expect(second.body.caseId).toBe(first.body.caseId);

    const casesForTenant = await db
      .select({ id: cases.id })
      .from(cases)
      .where(eq(cases.tenantId, owner[0]!.tenantId));
    expect(casesForTenant).toHaveLength(1);
  });

  // A double-clicked button issues both requests before either has written,
  // so read-then-write idempotency alone would produce two clones. The partial
  // unique index makes one-per-session structural; the route turns the
  // conflict back into the same 200 a sequential second call gets.
  it("survives two concurrent adopts from one session", async () => {
    const seed = await adopt();
    const cookie = cookieFrom(seed.res);
    const owner = await db
      .select({ tenantId: cases.tenantId })
      .from(cases)
      .where(eq(cases.id, seed.body.caseId));
    const tenantId = owner[0]!.tenantId;
    adoptedTenants.push(tenantId);

    // Clear the first clone so both racers start from nothing.
    await db.delete(cases).where(eq(cases.id, seed.body.caseId));

    const [a, b] = await Promise.all([adopt(cookie), adopt(cookie)]);
    expect([a.res.status, b.res.status].sort()).toEqual([200, 201]);
    expect(a.body.caseId).toBe(b.body.caseId);

    const demoCases = await db
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.tenantId, tenantId), eq(cases.origin, "demo")));
    expect(demoCases).toHaveLength(1);
  });

  it("gives two sessions separate copies, invisible to each other", async () => {
    const mine = await adopt();
    const theirs = await adopt();
    expect(mine.body.caseId).not.toBe(theirs.body.caseId);

    for (const r of [mine, theirs]) {
      const owner = await db
        .select({ tenantId: cases.tenantId })
        .from(cases)
        .where(eq(cases.id, r.body.caseId));
      adoptedTenants.push(owner[0]!.tenantId);
    }

    const mineCookie = cookieFrom(mine.res);
    expect(
      (await app.request(`/cases/${theirs.body.caseId}`, { headers: { cookie: mineCookie } }))
        .status,
    ).toBe(404);
    expect(
      (await app.request(`/cases/${mine.body.caseId}`, { headers: { cookie: mineCookie } })).status,
    ).toBe(200);
  });

  // The template is a template: never served, and never swept by the FR-7.3
  // purge, which targets `anon` tenants.
  it("leaves the template untouched", async () => {
    const docs = await db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.caseId, templateCaseId));
    expect(docs).toHaveLength(1);
    expect(docs[0]!.id).toBe(templateDocumentId);

    const tenant = await db.select().from(tenants).where(eq(tenants.id, templateTenantId));
    expect(tenant[0]!.kind).toBe("demo");
    expect(tenant[0]!.expiresAt).toBeNull();
  });
});
