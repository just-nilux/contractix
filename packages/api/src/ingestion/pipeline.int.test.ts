import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Block, canonicalText } from "@contractix/shared";

import { db, pool } from "../db/client.js";
import {
  cases,
  chunks,
  citations,
  clauses,
  documents,
  extractions,
  flags,
} from "../db/schema/index.js";
import { createTestTenant, deleteTestTenant } from "../auth/testing.js";
import { FakeEmbeddings } from "../providers/index.js";
import { LocalBlobStore } from "../storage/local.js";
import { buildPdf } from "./parser/__fixtures__/pdf.js";
import { runIngestion } from "./pipeline.js";

const OFFER_PDF = buildPdf([
  [
    { text: "Arbeitsvertrag", size: 18 },
    { text: "zwischen der Beispiel Technologie GmbH und Erika Musterfrau", size: 11 },
    { text: "1. Beginn des Arbeitsverhaeltnisses", size: 14 },
    { text: "Das Arbeitsverhaeltnis beginnt am 1. Februar 2027 und ist unbefristet.", size: 11 },
    { text: "2. Probezeit", size: 14 },
    {
      text: "Die ersten sechs Monate gelten als Probezeit. Waehrend der Probezeit kann das Arbeitsverhaeltnis beiderseits mit einer Frist von zwei Wochen gekuendigt werden.",
      size: 11,
    },
  ],
  [
    { text: "3. Verguetung", size: 14 },
    {
      text: "Der Mitarbeiter erhaelt eine jaehrliche Bruttoverguetung von 95.000 Euro, zahlbar in zwoelf gleichen Monatsraten.",
      size: 11,
    },
    { text: "Seite 2 von 2", size: 8, y: 24 },
  ],
]);

describe("ingestion pipeline end-to-end (fake providers)", () => {
  let storageDir: string;
  let blobStore: LocalBlobStore;
  let tenantId: string;
  let caseId: string;
  let documentId: string;
  let sha256: string;
  const embeddings = new FakeEmbeddings(1024);

  beforeAll(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "contractix-pipeline-"));
    blobStore = new LocalBlobStore(storageDir);
    await blobStore.init();

    tenantId = await createTestTenant(db, "pipeline");
    const c = await db
      .insert(cases)
      .values({ tenantId, title: "pipeline e2e" })
      .returning({ id: cases.id });
    caseId = c[0]!.id;

    const stored = await blobStore.put(OFFER_PDF, ".pdf");
    sha256 = stored.sha256;
    const d = await db
      .insert(documents)
      .values({
        caseId,
        tenantId,
        sha256,
        filename: "offer.pdf",
        mimeType: "application/pdf",
        byteSize: OFFER_PDF.byteLength,
      })
      .returning({ id: documents.id });
    documentId = d[0]!.id;
  });

  afterAll(async () => {
    await deleteTestTenant(db, tenantId);
    await fs.rm(storageDir, { recursive: true, force: true });
    await pool.end();
  });

  it("ingests to ready with clauses, embedded chunks, and honest metadata", async () => {
    const stages: string[] = [];
    await runIngestion(
      { db, blobStore, embeddings, onStage: (s) => void stages.push(s) },
      documentId,
    );

    expect(stages).toEqual(["parse", "segment", "chunk", "embed", "persist"]);

    const doc = (await db.select().from(documents).where(eq(documents.id, documentId)))[0];
    expect(doc?.status).toBe("ready");
    expect(doc?.language).toBe("de");
    expect(doc?.pageCount).toBe(2);
    expect(doc?.parseReport?.coverage).toBe(1);

    const clauseRows = await db
      .select()
      .from(clauses)
      .where(eq(clauses.documentId, documentId))
      .orderBy(clauses.seq);
    const refs = clauseRows.map((c) => c.clauseRef);
    expect(refs).toEqual(["1:front-matter", "1:1", "1:2", "2:3"]);
    expect(clauseRows.every((c) => c.tenantId === tenantId)).toBe(true);

    const chunkRows = await db.select().from(chunks).where(eq(chunks.documentId, documentId));
    expect(chunkRows.length).toBeGreaterThanOrEqual(clauseRows.length);
    expect(chunkRows.every((c) => c.embedding?.length === 1024)).toBe(true);
    expect(chunkRows.every((c) => c.embeddingModel === embeddings.id)).toBe(true);
    expect(chunkRows.every((c) => c.tenantId === tenantId && c.caseId === caseId)).toBe(true);

    // Slice invariant against the persisted sidecar (what Phase 3 will render).
    const blocks = await blobStore.readSidecar<Block[]>(sha256, "blocks");
    const canonical = canonicalText(blocks);
    for (const clause of clauseRows) {
      expect(canonical.slice(clause.charStart, clause.charEnd)).toBe(clause.text);
    }
    for (const chunk of chunkRows) {
      expect(canonical.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
  });

  it("re-ingests idempotently: same refs, no duplicate rows", async () => {
    const before = await db.select().from(clauses).where(eq(clauses.documentId, documentId));
    await runIngestion({ db, blobStore, embeddings }, documentId);
    const after = await db.select().from(clauses).where(eq(clauses.documentId, documentId));
    expect(after.length).toBe(before.length);
    expect(new Set(after.map((c) => c.clauseRef))).toEqual(new Set(before.map((c) => c.clauseRef)));
  });

  /**
   * A re-ingest deletes and recreates clauses with fresh ids. Citations cascade
   * with them, but extractions and flags do not, and `flags.clause_ids` is a
   * bare uuid[] with no foreign key — so leaving them behind produced fields
   * with no citations and flags citing clauses that no longer exist. The report
   * renders those as chips that resolve to nothing, which is the "every
   * citation resolves to a real span" guarantee failing silently.
   */
  it("invalidates the analysis derived from the clauses it replaces", async () => {
    const clauseRows = await db.select().from(clauses).where(eq(clauses.documentId, documentId));
    const staleClauseId = clauseRows[0]!.id;

    const extraction = await db
      .insert(extractions)
      .values({
        documentId,
        tenantId,
        caseId,
        schemaVer: "employment@1",
        fieldPath: "probation.months",
        value: 6,
        confidence: "high",
        status: "extracted",
      })
      .returning({ id: extractions.id });
    await db.insert(citations).values({
      tenantId,
      documentId,
      sourceType: "extraction",
      extractionId: extraction[0]!.id,
      clauseId: staleClauseId,
      charStart: 0,
      charEnd: 5,
      verbatimAnchor: "Probe",
    });
    await db.insert(flags).values({
      documentId,
      tenantId,
      caseId,
      ruleId: "DE-PROBEZEIT-MAX",
      ruleVersion: "1",
      severity: "red",
      clauseIds: [staleClauseId],
      rationale: "stale",
      sources: [],
    });
    await db
      .update(documents)
      .set({ analysisStatus: "analyzed" })
      .where(eq(documents.id, documentId));

    await runIngestion({ db, blobStore, embeddings }, documentId);

    expect(
      await db.select().from(extractions).where(eq(extractions.documentId, documentId)),
    ).toHaveLength(0);
    expect(await db.select().from(flags).where(eq(flags.documentId, documentId))).toHaveLength(0);
    expect(
      await db.select().from(citations).where(eq(citations.documentId, documentId)),
    ).toHaveLength(0);

    // Reset so the worker re-chains analysis over the clauses that now exist.
    const doc = (await db.select().from(documents).where(eq(documents.id, documentId)))[0];
    expect(doc?.analysisStatus).toBe("pending");

    // No flag may reference a clause that is gone.
    const dangling = await db.execute<{ n: number }>(sql`
      select count(*)::int as n
      from flags f, unnest(f.clause_ids) as u(cid)
      left join clauses c on c.id = u.cid
      where f.document_id = ${documentId} and c.id is null
    `);
    expect(dangling.rows[0]!.n).toBe(0);
  });

  it("marks unparseable uploads failed without throwing (no pointless retries)", async () => {
    const garbage = new TextEncoder().encode("definitely not a pdf");
    const stored = await blobStore.put(garbage, ".pdf");
    const d = await db
      .insert(documents)
      .values({
        caseId,
        tenantId,
        sha256: stored.sha256,
        filename: "broken.pdf",
        mimeType: "application/pdf",
        byteSize: garbage.byteLength,
      })
      .returning({ id: documents.id });
    const brokenId = d[0]!.id;

    await expect(runIngestion({ db, blobStore, embeddings }, brokenId)).resolves.toMatchObject({
      status: "failed",
    });

    const doc = (await db.select().from(documents).where(eq(documents.id, brokenId)))[0];
    expect(doc?.status).toBe("failed");
    expect(doc?.parseReport?.error).toMatch(/unparseable/);
  });
});
