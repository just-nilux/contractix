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
import {
  cases,
  citations,
  clauses,
  documents,
  extractions,
  flags,
  qaTurns,
} from "../db/schema/index.js";
import { DEFAULT_DEMO_CONFIG } from "../demo/template.js";
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
    { text: "Die Probezeit betraegt acht Monate ab Vertragsbeginn.", size: 11 },
    { text: "2. Urlaub", size: 14 },
    { text: "Es besteht Anspruch auf dreissig Tage Urlaub.", size: 11 },
  ],
]);

interface NarrativeBody {
  turnId: string;
  markdown: string;
  disclaimer: string;
  citations: { clauseId: string; documentId: string }[];
  couldNotVerify: string[];
  grounded: boolean;
  corrected: boolean;
  promptVersion: string;
  trace: { stubbed: boolean; citableClauseIds: string[] };
}

async function readSse(res: Response): Promise<{ event: string; data: unknown }[]> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: unknown }[] = [];
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
      events.push({ event, data: JSON.parse(raw) });
    }
  }
  return events;
}

describe("narrative report route", () => {
  let app: { request(input: string, init?: RequestInit): Promise<Response> };
  let redis: ReturnType<typeof createRedis>;
  let storageDir: string;
  let tenantId: string;
  let caseId: string;
  let documentId: string;
  let citedClauseId: string;

  beforeAll(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "contractix-narrative-"));
    redis = createRedis(process.env.REDIS_URL ?? "redis://localhost:6380");
    const blobStore = new LocalBlobStore(storageDir);
    await blobStore.init();
    const embeddings = new FakeEmbeddings(1024);

    tenantId = await createTestTenant(db, "narrative");
    const c = await db
      .insert(cases)
      .values({ tenantId, title: "Senior Engineer offer" })
      .returning({ id: cases.id });
    caseId = c[0]!.id;

    const stored = await blobStore.put(OFFER, ".pdf");
    const d = await db
      .insert(documents)
      .values({
        caseId,
        tenantId,
        sha256: stored.sha256,
        filename: "offer_de.pdf",
        mimeType: "application/pdf",
        byteSize: OFFER.byteLength,
        type: "employment_offer",
      })
      .returning({ id: documents.id });
    documentId = d[0]!.id;
    await runIngestion({ db, blobStore, embeddings }, documentId);

    // Keyless extraction finds nothing, so seed one cited term + one flag by
    // hand: the citable set is built from persisted citations, and an empty one
    // is a different code path (the stub).
    const clauseRows = await db
      .select({ id: clauses.id })
      .from(clauses)
      .where(eq(clauses.documentId, documentId))
      .orderBy(clauses.seq);
    citedClauseId = clauseRows[1]!.id;

    const extraction = await db
      .insert(extractions)
      .values({
        documentId,
        tenantId,
        caseId,
        schemaVer: "employment@1",
        fieldPath: "probation.months",
        value: 8,
        unit: "months",
        confidence: "high",
        status: "extracted",
      })
      .returning({ id: extractions.id });
    await db.insert(citations).values({
      tenantId,
      documentId,
      sourceType: "extraction",
      extractionId: extraction[0]!.id,
      clauseId: citedClauseId,
      charStart: 0,
      charEnd: 12,
      verbatimAnchor: "Die Probezeit",
    });
    await db.insert(flags).values({
      documentId,
      tenantId,
      caseId,
      ruleId: "DE-PROBEZEIT-MAX",
      ruleVersion: "1",
      severity: "red",
      clauseIds: [citedClauseId],
      rationale: "Probezeit exceeds the §622 BGB ceiling",
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
      demo: DEFAULT_DEMO_CONFIG,
      corsOrigins: [],
    };
    app = signedIn(createApp(deps), await sessionCookie(tenantId));
  });

  afterAll(async () => {
    await deleteTestTenant(db, tenantId);
    await fs.rm(storageDir, { recursive: true, force: true });
    await redis.quit();
    await pool.end();
  });

  it("404s before anything has been generated", async () => {
    expect((await app.request(`/cases/${caseId}/narrative`)).status).toBe(404);
  });

  it("streams tokens then a terminal done, and persists the turn", async () => {
    const res = await app.request(`/cases/${caseId}/narrative`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await readSse(res);
    expect(events.some((e) => e.event === "token")).toBe(true);

    const done = events.at(-1)!;
    expect(done.event).toBe("done");
    const body = done.data as NarrativeBody;
    expect(body.markdown.length).toBeGreaterThan(0);
    expect(body.promptVersion).toBe("report@1");
    // FR-7.6: every surface says what it is.
    expect(body.disclaimer).toContain("not legal");
    // The citable set came from the persisted citation, not from the model.
    expect(body.trace.stubbed).toBe(false);
    expect(body.trace.citableClauseIds).toContain(citedClauseId);

    const rows = await db
      .select()
      .from(qaTurns)
      .where(and(eq(qaTurns.id, body.turnId), eq(qaTurns.tenantId, tenantId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("report");
    expect(rows[0]!.promptVersion).toBe("report@1");
    expect(rows[0]!.answer).toBe(body.markdown);

    // Citations persist through the same path as a Q&A answer, so the viewer
    // and the trace drawer treat both identically.
    const citationRows = await db
      .select()
      .from(citations)
      .where(and(eq(citations.answerId, body.turnId), eq(citations.tenantId, tenantId)));
    expect(citationRows.length).toBe(body.citations.length);
    for (const row of citationRows) {
      expect(row.sourceType).toBe("answer");
      expect(row.verbatimAnchor.length).toBeGreaterThan(0);
    }
  });

  it("serves the stored narrative afterwards", async () => {
    const res = await app.request(`/cases/${caseId}/narrative`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as NarrativeBody;
    expect(body.markdown.length).toBeGreaterThan(0);
    expect(body.promptVersion).toBe("report@1");
  });

  it("returns the same body buffered when JSON is requested", async () => {
    const res = await app.request(`/cases/${caseId}/narrative`, {
      method: "POST",
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as NarrativeBody;
    expect(body.markdown.length).toBeGreaterThan(0);
    expect(body.trace.stubbed).toBe(false);
  });

  // Keyless mode with nothing analysed: no model call, deterministic markdown.
  it("stubs a case with nothing citable rather than calling a model", async () => {
    const empty = await db
      .insert(cases)
      .values({ tenantId, title: "Nothing analysed" })
      .returning({ id: cases.id });

    const res = await app.request(`/cases/${empty[0]!.id}/narrative`, {
      method: "POST",
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as NarrativeBody;
    expect(body.trace.stubbed).toBe(true);
    expect(body.grounded).toBe(true);
    expect(body.markdown).toContain("## Summary");
  });

  it("404s another session's case on both verbs", async () => {
    const otherTenant = await createTestTenant(db, "narrative-other");
    const cookie = await sessionCookie(otherTenant);

    expect((await app.request(`/cases/${caseId}/narrative`, { headers: { cookie } })).status).toBe(
      404,
    );
    expect(
      (await app.request(`/cases/${caseId}/narrative`, { method: "POST", headers: { cookie } }))
        .status,
    ).toBe(404);

    await deleteTestTenant(db, otherTenant);
  });
});
