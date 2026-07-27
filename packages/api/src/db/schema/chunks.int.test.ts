import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertEmbeddingDims } from "../assert.js";
import { db, pool } from "../client.js";
import { createTestTenant, deleteTestTenant } from "../../auth/testing.js";
import { cases, chunks, clauses, documents, EMBEDDING_DIMS } from "./index.js";

describe("chunks schema semantics", () => {
  let tenantId: string;
  let caseId: string;
  let documentId: string;
  let clauseId: string;

  beforeAll(async () => {
    tenantId = await createTestTenant(db, "chunks");
    const c = await db
      .insert(cases)
      .values({ tenantId, title: "schema semantics" })
      .returning({ id: cases.id });
    caseId = c[0]!.id;
    const d = await db
      .insert(documents)
      .values({
        caseId,
        tenantId,
        sha256: `schema-test-${Date.now()}`,
        filename: "t.pdf",
        mimeType: "application/pdf",
        byteSize: 1,
      })
      .returning({ id: documents.id });
    documentId = d[0]!.id;
    const cl = await db
      .insert(clauses)
      .values({
        documentId,
        tenantId,
        clauseRef: "1:§1",
        clausePath: "§1",
        heading: "§ 1 Test",
        headingPath: ["§ 1 Test"],
        page: 1,
        charStart: 0,
        charEnd: 10,
        text: "irrelevant",
        seq: 0,
      })
      .returning({ id: clauses.id });
    clauseId = cl[0]!.id;
  });

  afterAll(async () => {
    await deleteTestTenant(db, tenantId);
    await pool.end();
  });

  it("boot assert accepts the migrated schema", async () => {
    await expect(assertEmbeddingDims(db)).resolves.toBeUndefined();
  });

  it("stems the generated tsv with the row language config", async () => {
    const embedding = new Array<number>(EMBEDDING_DIMS).fill(0);
    await db.insert(chunks).values([
      {
        clauseId,
        documentId,
        caseId,
        tenantId,
        chunkIndex: 0,
        text: "Die Kündigungsfristen der Verträge sind lang.",
        charStart: 0,
        charEnd: 45,
        tokenCount: 10,
        language: "de",
        embedding,
        embeddingModel: "fake:test@1024",
      },
      {
        clauseId,
        documentId,
        caseId,
        tenantId,
        chunkIndex: 1,
        text: "The liquidation preferences of the agreements are long.",
        charStart: 46,
        charEnd: 100,
        tokenCount: 10,
        language: "en",
        embedding,
        embeddingModel: "fake:test@1024",
      },
    ]);

    // German stemmer folds plural "Kündigungsfristen" onto the singular query...
    const de = await db.execute(sql`
      SELECT count(*)::int AS n FROM chunks
      WHERE case_id = ${caseId}
        AND tsv @@ websearch_to_tsquery('german'::regconfig, 'Kündigungsfrist')`);
    expect((de.rows[0] as { n: number }).n).toBe(1);

    // ...and the english row was NOT stemmed with the german config.
    const en = await db.execute(sql`
      SELECT count(*)::int AS n FROM chunks
      WHERE case_id = ${caseId}
        AND tsv @@ websearch_to_tsquery('english'::regconfig, 'preference')`);
    expect((en.rows[0] as { n: number }).n).toBe(1);
  });

  it("answers trigram word-similarity via the <% operator", async () => {
    const res = await db.execute(sql`
      SELECT count(*)::int AS n FROM chunks
      WHERE case_id = ${caseId} AND ${"Kündigungsfrist"} <% text`);
    expect((res.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);
  });

  it("has the hnsw and gin indexes in place", async () => {
    const res = await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'chunks' ORDER BY indexname`);
    const names = res.rows.map((r) => (r as { indexname: string }).indexname);
    expect(names).toEqual(
      expect.arrayContaining(["chunks_embedding_hnsw", "chunks_tsv_gin", "chunks_text_trgm"]),
    );
  });
});
