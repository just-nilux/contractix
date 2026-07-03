import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../db/client.js";
import { cases, documents } from "../db/schema/index.js";
import { ensureDevTenant } from "../db/tenancy.js";
import { buildPdf } from "../ingestion/parser/__fixtures__/pdf.js";
import { runIngestion } from "../ingestion/pipeline.js";
import { FakeEmbeddings, PassthroughReranker } from "../providers/index.js";
import { LocalBlobStore } from "../storage/local.js";
import { searchClauses, type SearchDeps } from "./search-service.js";

const OFFER_DE = buildPdf([
  [
    { text: "Arbeitsvertrag", size: 18 },
    { text: "zwischen der Beispiel Technologie GmbH und Erika Musterfrau", size: 11 },
    { text: "1. Beginn des Arbeitsverhaeltnisses", size: 14 },
    { text: "Das Arbeitsverhaeltnis beginnt am 1. Februar 2027 und ist unbefristet.", size: 11 },
    { text: "2. Probezeit", size: 14 },
    {
      text: "Die ersten sechs Monate gelten als Probezeit. Waehrend der Probezeit kann beiderseits mit einer Frist von zwei Wochen gekuendigt werden.",
      size: 11,
    },
    { text: "3. Urlaub", size: 14 },
    { text: "Der Mitarbeiter erhaelt dreissig Tage bezahlten Urlaub pro Kalenderjahr.", size: 11 },
  ],
]);

const TERM_SHEET_EN = buildPdf([
  [
    { text: "Series A Term Sheet", size: 18 },
    { text: "Summary of principal terms of the proposed financing.", size: 11 },
    { text: "Section 2.1 Liquidation Preference", size: 14 },
    {
      text: "The holders of Series A shall receive one times the original purchase price, non-participating, prior to any distribution to common.",
      size: 11,
    },
    { text: "Section 2.2 Vesting", size: 14 },
    {
      text: "Founder shares vest over forty-eight months with a twelve month cliff, subject to acceleration on a change of control.",
      size: 11,
    },
  ],
]);

describe("hybrid search over ingested documents", () => {
  let storageDir: string;
  let tenantId: string;
  let caseId: string;
  let offerId: string;
  let termSheetId: string;
  let deps: SearchDeps;

  beforeAll(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "contractix-search-"));
    const blobStore = new LocalBlobStore(storageDir);
    await blobStore.init();
    const embeddings = new FakeEmbeddings(1024);

    tenantId = await ensureDevTenant(db);
    const c = await db
      .insert(cases)
      .values({ tenantId, title: "hybrid search" })
      .returning({ id: cases.id });
    caseId = c[0]!.id;

    for (const [bytes, filename] of [
      [OFFER_DE, "offer_de.pdf"],
      [TERM_SHEET_EN, "term_sheet_en.pdf"],
    ] as const) {
      const stored = await blobStore.put(bytes, ".pdf");
      const d = await db
        .insert(documents)
        .values({
          caseId,
          tenantId,
          sha256: stored.sha256,
          filename,
          mimeType: "application/pdf",
          byteSize: bytes.byteLength,
        })
        .returning({ id: documents.id, filename: documents.filename });
      await runIngestion({ db, blobStore, embeddings }, d[0]!.id);
      if (filename === "offer_de.pdf") offerId = d[0]!.id;
      else termSheetId = d[0]!.id;
    }

    deps = { db, embeddings, reranker: new PassthroughReranker() };
  });

  afterAll(async () => {
    await db.delete(cases).where(eq(cases.id, caseId));
    await fs.rm(storageDir, { recursive: true, force: true });
    await pool.end();
  });

  it("finds the Probezeit clause for a stemmed German query", async () => {
    const results = await searchClauses(deps, { tenantId, caseId, query: "Probezeit" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.clausePath).toBe("2");
    expect(results[0]?.documentId).toBe(offerId);
    expect(results[0]?.serializedClauseId).toBe(`${offerId}:1:2`);
    expect(results[0]?.snippet).toContain("Probezeit");
  });

  it("finds the liquidation preference clause for an English query", async () => {
    const results = await searchClauses(deps, {
      tenantId,
      caseId,
      query: "liquidation preference multiple",
    });
    expect(results[0]?.clausePath).toBe("sec-2.1");
    expect(results[0]?.documentId).toBe(termSheetId);
  });

  it("catches inflected compounds through the trigram channel", async () => {
    // 'gekuendigt' appears only inflected; trigram similarity must catch it
    // even when FTS stemming would miss the exact form.
    const results = await searchClauses(deps, { tenantId, caseId, query: "kuendigung Frist" });
    expect(results.some((r) => r.clausePath === "2" && r.documentId === offerId)).toBe(true);
  });

  it("scopes to a single document on request (FR-2.5)", async () => {
    const results = await searchClauses(deps, {
      tenantId,
      caseId,
      documentId: termSheetId,
      query: "vesting cliff",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.documentId === termSheetId)).toBe(true);
  });

  it("returns each clause at most once, capped at topK", async () => {
    const results = await searchClauses(deps, { tenantId, caseId, query: "Vertrag", topK: 3 });
    const clauseIds = results.map((r) => r.clauseId);
    expect(new Set(clauseIds).size).toBe(clauseIds.length);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("enforces the tenant guard: foreign tenants see nothing", async () => {
    const results = await searchClauses(deps, {
      tenantId: uuidv7(),
      caseId,
      query: "Probezeit",
    });
    expect(results).toEqual([]);
  });
});
