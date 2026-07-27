import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb } from "../db/client.js";
import { cases, clauses, documents, tenants } from "../db/schema/index.js";
import { FakeLlm } from "../providers/llm/fake.js";
import {
  type LlmExtractOptions,
  type LlmExtractResult,
  type LlmProvider,
} from "../providers/llm/types.js";
import { classifyDocument } from "./classifier-service.js";

/** Returns a fixed classification JSON, echoing what a real model would produce. */
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

describe("classifyDocument (integration)", () => {
  const { db, pool } = createDb(
    process.env.DATABASE_URL ?? "postgres://contractix:contractix@localhost:5433/contractix",
  );
  let tenantId: string;
  let caseId: string;
  let documentId: string;

  beforeAll(async () => {
    tenantId = (
      await db
        .insert(tenants)
        .values({ name: `classify-int-${Date.now()}`, kind: "user" })
        .returning()
    )[0]!.id;
    caseId = (await db.insert(cases).values({ tenantId, title: "Classify IT" }).returning())[0]!.id;
    documentId = (
      await db
        .insert(documents)
        .values({
          caseId,
          tenantId,
          sha256: "c1a55f00",
          filename: "arbeitsvertrag.pdf",
          mimeType: "application/pdf",
          byteSize: 1,
          language: "de",
          status: "ready",
        })
        .returning()
    )[0]!.id;
    await db.insert(clauses).values([
      {
        documentId,
        tenantId,
        clauseRef: "1:§1",
        clausePath: "§1",
        heading: "Probezeit",
        headingPath: [],
        page: 1,
        charStart: 0,
        charEnd: 35,
        text: "Die Probezeit beträgt sechs Monate.",
        seq: 0,
      },
      {
        documentId,
        tenantId,
        clauseRef: "1:§2",
        clausePath: "§2",
        heading: "Kündigungsfrist",
        headingPath: [],
        page: 1,
        charStart: 36,
        charEnd: 76,
        text: "Die Kündigungsfrist beträgt drei Monate.",
        seq: 1,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(cases).where(eq(cases.id, caseId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await pool.end();
  });

  it("keyless FakeLlm classifies as 'other' and persists documents.type", async () => {
    const res = await classifyDocument({ db, llm: new FakeLlm() }, { documentId, tenantId });
    expect(res.documentType).toBe("other");
    const row = (
      await db.select({ type: documents.type }).from(documents).where(eq(documents.id, documentId))
    )[0]!;
    expect(row.type).toBe("other");
  });

  it("persists a stubbed real classification (employment_offer)", async () => {
    const llm = new StubLlm({ document_type: "employment_offer", confidence: "high" });
    const res = await classifyDocument({ db, llm }, { documentId, tenantId });
    expect(res.documentType).toBe("employment_offer");
    expect(res.confidence).toBe("high");
    const row = (
      await db.select({ type: documents.type }).from(documents).where(eq(documents.id, documentId))
    )[0]!;
    expect(row.type).toBe("employment_offer");
  });

  it("is tenant-scoped: a foreign tenant cannot classify the document", async () => {
    const otherTenant = (
      await db
        .insert(tenants)
        .values({ name: `classify-other-${Date.now()}`, kind: "user" })
        .returning()
    )[0]!.id;
    await expect(
      classifyDocument({ db, llm: new FakeLlm() }, { documentId, tenantId: otherTenant }),
    ).rejects.toThrow(/not found/u);
    await db.delete(tenants).where(eq(tenants.id, otherTenant));
  });
});
