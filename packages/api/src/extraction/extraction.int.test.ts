import { extractionSchemaForType, notFound, serializeClauseId } from "@contractix/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb } from "../db/client.js";
import { cases, citations, clauses, documents, extractions, tenants } from "../db/schema/index.js";
import { FakeLlm } from "../providers/llm/fake.js";
import {
  type LlmExtractOptions,
  type LlmExtractResult,
  type LlmProvider,
} from "../providers/llm/types.js";
import { runExtraction } from "./extraction-service.js";

const CLAUSE_TEXT = "Die Probezeit beträgt sechs Monate. Danach gilt eine Frist von drei Monaten.";
const CLAUSE_START = 50;
const ANCHOR = "sechs Monate";

/** Returns a fixed extraction JSON, echoing what a real model would produce. */
class StubLlm implements LlmProvider {
  readonly id = "stub:llm";
  constructor(private readonly json: unknown) {}
  extract(_opts: LlmExtractOptions): Promise<LlmExtractResult> {
    return Promise.resolve({ json: this.json, usage: { inputTokens: 5, outputTokens: 5 } });
  }
  converse(): never {
    throw new Error("StubLlm does not implement converse");
  }
}

/** A schema-valid employment extraction: every field not_found except the overrides. */
function employmentJson(overrides: Record<string, unknown>): unknown {
  const base: Record<string, unknown> = {};
  for (const key of extractionSchemaForType("employment_offer")?.fieldKeys ?? []) {
    base[key] = notFound();
  }
  return { ...base, ...overrides };
}

describe("runExtraction (integration)", () => {
  const { db, pool } = createDb(
    process.env.DATABASE_URL ?? "postgres://contractix:contractix@localhost:5433/contractix",
  );
  let tenantId: string;
  let caseId: string;
  let documentId: string;
  let clauseId: string;
  let citedClauseId: string;

  beforeAll(async () => {
    tenantId = (
      await db
        .insert(tenants)
        .values({ name: `extract-int-${Date.now()}`, kind: "user" })
        .returning()
    )[0]!.id;
    caseId = (await db.insert(cases).values({ tenantId, title: "Extraction IT" }).returning())[0]!
      .id;
    documentId = (
      await db
        .insert(documents)
        .values({
          caseId,
          tenantId,
          sha256: "deadbeef",
          filename: "offer.pdf",
          mimeType: "application/pdf",
          byteSize: 1,
          type: "employment_offer",
          status: "ready",
        })
        .returning()
    )[0]!.id;
    clauseId = (
      await db
        .insert(clauses)
        .values({
          documentId,
          tenantId,
          clauseRef: "1:§2",
          clausePath: "§2",
          heading: "Probezeit",
          headingPath: [],
          page: 1,
          charStart: CLAUSE_START,
          charEnd: CLAUSE_START + CLAUSE_TEXT.length,
          text: CLAUSE_TEXT,
          seq: 0,
        })
        .returning()
    )[0]!.id;
    citedClauseId = serializeClauseId(documentId, "1:§2");
  });

  afterAll(async () => {
    await db.delete(cases).where(eq(cases.id, caseId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await pool.end();
  });

  it("persists fields + a structurally resolved citation, tenant-scoped", async () => {
    const llm = new StubLlm(
      employmentJson({
        probation_period_months: {
          value: 6,
          unit: "months",
          confidence: "high",
          citations: [citedClauseId],
          verbatim_anchor: ANCHOR,
          status: "extracted",
        },
      }),
    );

    const result = await runExtraction({ db, llm }, { documentId, tenantId });
    expect(result.schemaVer).toBe("employment@1");
    expect(result.extraction).not.toBeNull();

    const rows = await db
      .select()
      .from(extractions)
      .where(and(eq(extractions.documentId, documentId), eq(extractions.tenantId, tenantId)));
    expect(rows.length).toBe(Object.keys(result.extraction!).length);
    expect(rows.every((r) => r.tenantId === tenantId && r.caseId === caseId)).toBe(true);

    const probation = rows.find((r) => r.fieldPath === "probation_period_months");
    expect(probation?.status).toBe("extracted");
    expect(probation?.confidence).toBe("high");
    expect(probation?.value).toBe(6);

    const cites = await db
      .select()
      .from(citations)
      .where(eq(citations.extractionId, probation!.id));
    expect(cites).toHaveLength(1);
    const c = cites[0]!;
    expect(c.clauseId).toBe(clauseId);
    // End-to-end ADR-0005 slice identity: the stored span slices back to the anchor.
    expect(CLAUSE_TEXT.slice(c.charStart - CLAUSE_START, c.charEnd - CLAUSE_START)).toBe(ANCHOR);

    // Idempotent re-run: same row count, no duplicates.
    await runExtraction({ db, llm }, { documentId, tenantId });
    const again = await db.select().from(extractions).where(eq(extractions.documentId, documentId));
    expect(again.length).toBe(rows.length);
  });

  it("FakeLlm yields an all-not_found extraction with no citations", async () => {
    const result = await runExtraction({ db, llm: new FakeLlm() }, { documentId, tenantId });
    const rows = await db.select().from(extractions).where(eq(extractions.documentId, documentId));
    expect(rows.every((r) => r.status === "not_found" && r.value === null)).toBe(true);
    const cites = await db.select().from(citations).where(eq(citations.documentId, documentId));
    expect(cites).toHaveLength(0);
    expect(result.extraction).not.toBeNull();
  });
});
