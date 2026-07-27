import { extractionSchemaForType, notFound, serializeClauseId } from "@contractix/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb } from "../db/client.js";
import { cases, clauses, documents, flags, tenants } from "../db/schema/index.js";
import {
  type LlmExtractOptions,
  type LlmExtractResult,
  type LlmProvider,
} from "../providers/llm/types.js";
import { benchmarkDocument } from "./benchmark-service.js";
import { runExtraction } from "./extraction-service.js";

const NC_TEXT = "Wettbewerbsverbot 12 Monate. Karenzentschädigung 30% des letzten Gehalts.";
const NC_ANCHOR = "Karenzentschädigung 30%";
const IP_TEXT = "Alle Arbeitsergebnisse gehen über. No carve-out for personal side projects.";
const IP_ANCHOR = "No carve-out for personal side projects";

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

function employmentJson(overrides: Record<string, unknown>): unknown {
  const base: Record<string, unknown> = {};
  for (const key of extractionSchemaForType("employment_offer")?.fieldKeys ?? []) {
    base[key] = notFound();
  }
  return { ...base, ...overrides };
}

describe("benchmarkDocument (integration)", () => {
  const { db, pool } = createDb(
    process.env.DATABASE_URL ?? "postgres://contractix:contractix@localhost:5433/contractix",
  );
  let tenantId: string;
  let caseId: string;
  let documentId: string;
  let ncClauseId: string;
  let ipClauseId: string;

  beforeAll(async () => {
    tenantId = (
      await db
        .insert(tenants)
        .values({ name: `bench-int-${Date.now()}`, kind: "user" })
        .returning()
    )[0]!.id;
    caseId = (await db.insert(cases).values({ tenantId, title: "Benchmark IT" }).returning())[0]!
      .id;
    documentId = (
      await db
        .insert(documents)
        .values({
          caseId,
          tenantId,
          sha256: "cafef00d",
          filename: "offer.pdf",
          mimeType: "application/pdf",
          byteSize: 1,
          type: "employment_offer",
          status: "ready",
        })
        .returning()
    )[0]!.id;
    ncClauseId = (
      await db
        .insert(clauses)
        .values({
          documentId,
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
        })
        .returning()
    )[0]!.id;
    ipClauseId = (
      await db
        .insert(clauses)
        .values({
          documentId,
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
        })
        .returning()
    )[0]!.id;

    const llm = new StubLlm(
      employmentJson({
        non_compete: {
          value: {
            present: true,
            duration_months: 12,
            karenzentschaedigung_percent: 30,
            scope: "DE",
          },
          confidence: "high",
          citations: [serializeClauseId(documentId, "2:§11")],
          verbatim_anchor: NC_ANCHOR,
          status: "extracted",
        },
        ip_assignment: {
          value: { present: true, side_project_carveout: false },
          confidence: "high",
          citations: [serializeClauseId(documentId, "1:§9")],
          verbatim_anchor: IP_ANCHOR,
          status: "extracted",
        },
      }),
    );
    await runExtraction({ db, llm }, { documentId, tenantId });
  });

  afterAll(async () => {
    await db.delete(cases).where(eq(cases.id, caseId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await pool.end();
  });

  it("fires the corpus rules and persists flags with resolved clause citations", async () => {
    const result = await benchmarkDocument({ db }, { documentId, tenantId });
    const ids = result.map((f) => f.ruleId).sort();
    expect(ids).toEqual(["DE-NONCOMP-KARENZ", "EMP-IP-NOCARVEOUT"]);

    const karenz = result.find((f) => f.ruleId === "DE-NONCOMP-KARENZ")!;
    expect(karenz.severity).toBe("red");
    expect(karenz.clauseIds).toContain(ncClauseId);

    const ip = result.find((f) => f.ruleId === "EMP-IP-NOCARVEOUT")!;
    expect(ip.clauseIds).toContain(ipClauseId);

    const rows = await db
      .select()
      .from(flags)
      .where(and(eq(flags.documentId, documentId), eq(flags.tenantId, tenantId)));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.caseId === caseId && r.ruleVersion.length > 0)).toBe(true);

    // Idempotent re-benchmark: still two rows, no duplicates.
    await benchmarkDocument({ db }, { documentId, tenantId });
    const again = await db.select().from(flags).where(eq(flags.documentId, documentId));
    expect(again).toHaveLength(2);
  });
});
