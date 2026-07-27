import { extractionSchemaForType, notFound, serializeClauseId } from "@contractix/shared";
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
import { runAnalysis } from "./analysis-service.js";

const NC_TEXT = "Wettbewerbsverbot 12 Monate. Karenzentschädigung 30% des letzten Gehalts.";
const NC_ANCHOR = "Karenzentschädigung 30%";
const IP_TEXT = "Alle Arbeitsergebnisse gehen über. No carve-out for personal side projects.";
const IP_ANCHOR = "No carve-out for personal side projects";

/** Routes each forced tool call to a fixed JSON — classify vs extract in one chain. */
class RoutingStubLlm implements LlmProvider {
  readonly id = "stub:llm";
  constructor(private readonly byTool: Record<string, unknown>) {}
  extract(opts: LlmExtractOptions): Promise<LlmExtractResult> {
    const json = this.byTool[opts.toolName];
    if (json === undefined) throw new Error(`no stub for tool ${opts.toolName}`);
    return Promise.resolve({ json, usage: { inputTokens: 5, outputTokens: 5 } });
  }
}

function employmentJson(overrides: Record<string, unknown>): unknown {
  const base: Record<string, unknown> = {};
  for (const key of extractionSchemaForType("employment_offer")?.fieldKeys ?? []) {
    base[key] = notFound();
  }
  return { ...base, ...overrides };
}

describe("runAnalysis (integration)", () => {
  const { db, pool } = createDb(
    process.env.DATABASE_URL ?? "postgres://contractix:contractix@localhost:5433/contractix",
  );
  let tenantId: string;
  let caseId: string;
  let realDocId: string;
  let keylessDocId: string;

  async function insertReadyDoc(sha: string, filename: string): Promise<string> {
    return (
      await db
        .insert(documents)
        .values({
          caseId,
          tenantId,
          sha256: sha,
          filename,
          mimeType: "application/pdf",
          byteSize: 1,
          language: "de",
          status: "ready",
        })
        .returning()
    )[0]!.id;
  }

  beforeAll(async () => {
    tenantId = (
      await db
        .insert(tenants)
        .values({ name: `analysis-int-${Date.now()}`, kind: "user" })
        .returning()
    )[0]!.id;
    caseId = (await db.insert(cases).values({ tenantId, title: "Analysis IT" }).returning())[0]!.id;

    realDocId = await insertReadyDoc("a11a11a1", "offer.pdf");
    keylessDocId = await insertReadyDoc("b22b22b2", "unknown.pdf");

    await db.insert(clauses).values([
      {
        documentId: realDocId,
        tenantId,
        clauseRef: "2:§11",
        clausePath: "§11",
        heading: "Wettbewerbsverbot",
        headingPath: [],
        page: 2,
        charStart: 0,
        charEnd: NC_TEXT.length,
        text: NC_TEXT,
        seq: 0,
      },
      {
        documentId: realDocId,
        tenantId,
        clauseRef: "1:§9",
        clausePath: "§9",
        heading: "IP",
        headingPath: [],
        page: 1,
        charStart: 500,
        charEnd: 500 + IP_TEXT.length,
        text: IP_TEXT,
        seq: 1,
      },
      {
        documentId: keylessDocId,
        tenantId,
        clauseRef: "1:§1",
        clausePath: "§1",
        heading: "Präambel",
        headingPath: [],
        page: 1,
        charStart: 0,
        charEnd: 20,
        text: "Diese Vereinbarung regelt Folgendes.",
        seq: 0,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(cases).where(eq(cases.id, caseId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await pool.end();
  });

  it("classifies, extracts, and benchmarks in one idempotent chain", async () => {
    const llm = new RoutingStubLlm({
      classify_document: { document_type: "employment_offer", confidence: "high" },
      record_extraction: employmentJson({
        non_compete: {
          value: {
            present: true,
            duration_months: 12,
            karenzentschaedigung_percent: 30,
            scope: "DE",
          },
          confidence: "high",
          citations: [serializeClauseId(realDocId, "2:§11")],
          verbatim_anchor: NC_ANCHOR,
          status: "extracted",
        },
        ip_assignment: {
          value: { present: true, side_project_carveout: false },
          confidence: "high",
          citations: [serializeClauseId(realDocId, "1:§9")],
          verbatim_anchor: IP_ANCHOR,
          status: "extracted",
        },
      }),
    });

    const result = await runAnalysis({ db, llm }, { documentId: realDocId, tenantId });
    expect(result.documentType).toBe("employment_offer");
    expect(result.extracted).toBe(true);
    expect(result.flags.map((f) => f.ruleId).sort()).toEqual([
      "DE-NONCOMP-KARENZ",
      "EMP-IP-NOCARVEOUT",
    ]);

    const doc = (
      await db
        .select({ type: documents.type, analysisStatus: documents.analysisStatus })
        .from(documents)
        .where(eq(documents.id, realDocId))
    )[0]!;
    expect(doc.type).toBe("employment_offer");
    expect(doc.analysisStatus).toBe("analyzed");

    // Idempotent re-run: same flags, still analyzed.
    const again = await runAnalysis({ db, llm }, { documentId: realDocId, tenantId });
    expect(again.flags.map((f) => f.ruleId).sort()).toEqual([
      "DE-NONCOMP-KARENZ",
      "EMP-IP-NOCARVEOUT",
    ]);
  });

  it("keyless FakeLlm reaches 'analyzed' as 'other' with no extraction or flags", async () => {
    const result = await runAnalysis(
      { db, llm: new FakeLlm() },
      { documentId: keylessDocId, tenantId },
    );
    expect(result.documentType).toBe("other");
    expect(result.extracted).toBe(false);
    expect(result.flags).toEqual([]);

    const doc = (
      await db
        .select({ type: documents.type, analysisStatus: documents.analysisStatus })
        .from(documents)
        .where(eq(documents.id, keylessDocId))
    )[0]!;
    expect(doc.type).toBe("other");
    expect(doc.analysisStatus).toBe("analyzed");
  });

  it("is tenant-scoped: a foreign tenant cannot analyze the document", async () => {
    const otherTenant = (
      await db
        .insert(tenants)
        .values({ name: `analysis-other-${Date.now()}`, kind: "user" })
        .returning()
    )[0]!.id;
    await expect(
      runAnalysis({ db, llm: new FakeLlm() }, { documentId: realDocId, tenantId: otherTenant }),
    ).rejects.toThrow(/not found/u);
    await db.delete(tenants).where(eq(tenants.id, otherTenant));
  });
});
