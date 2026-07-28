import { type ExtractedFields } from "@contractix/shared";
import { type Flag, runBenchmark as runRules, type Severity } from "@contractix/rules";
import { and, eq } from "drizzle-orm";

import { type Db } from "../db/client.js";
import { citations, documents, extractions, flags } from "../db/schema/index.js";

export interface BenchmarkDeps {
  db: Db;
}

export interface BenchmarkParams {
  documentId: string;
  tenantId: string;
}

export interface PersistedFlag {
  ruleId: string;
  severity: Severity;
  rationale: string;
  negotiationHint?: string;
  sources: string[];
  /** Clause row ids the triggering fields cite (resolved from the citations table). */
  clauseIds: string[];
}

/**
 * Run the deterministic rules engine over a document's persisted extraction
 * (FR-4) and persist the resulting flags. Reconstructs the extraction from the
 * extractions table, maps each flag's triggering fields to the clause ids they
 * cite (via the citations written at extraction time), and replaces the
 * document's flags idempotently under the tenant guard.
 */
export async function benchmarkDocument(
  deps: BenchmarkDeps,
  params: BenchmarkParams,
): Promise<PersistedFlag[]> {
  const { tenantId } = params;
  const doc = (
    await deps.db
      .select({ id: documents.id, type: documents.type, caseId: documents.caseId })
      .from(documents)
      .where(and(eq(documents.id, params.documentId), eq(documents.tenantId, tenantId)))
      .limit(1)
  )[0];
  if (!doc) throw new Error(`document not found in tenant: ${params.documentId}`);

  const exRows = await deps.db
    .select()
    .from(extractions)
    .where(and(eq(extractions.documentId, doc.id), eq(extractions.tenantId, tenantId)));

  // Reconstruct the extraction (rules read value + status; citations map fields to clauses).
  const ex: ExtractedFields = {};
  const extractionIdByField = new Map<string, string>();
  for (const r of exRows) {
    extractionIdByField.set(r.fieldPath, r.id);
    ex[r.fieldPath] = {
      value: r.value,
      status: r.status,
      confidence: r.confidence,
      citations: [],
      verbatim_anchor: "",
      ...(r.unit ? { unit: r.unit } : {}),
    };
  }

  const citeRows = await deps.db
    .select({ extractionId: citations.extractionId, clauseId: citations.clauseId })
    .from(citations)
    .where(and(eq(citations.documentId, doc.id), eq(citations.tenantId, tenantId)));
  const clausesByExtraction = new Map<string, string[]>();
  for (const c of citeRows) {
    if (!c.extractionId) continue;
    const arr = clausesByExtraction.get(c.extractionId) ?? [];
    arr.push(c.clauseId);
    clausesByExtraction.set(c.extractionId, arr);
  }

  const ruleFlags: Flag[] = doc.type ? runRules(ex, { documentType: doc.type }) : [];
  const items = ruleFlags.map((f) => {
    const clauseIds = [
      ...new Set(
        f.triggeringFields.flatMap((field) => {
          const exId = extractionIdByField.get(field);
          return exId ? (clausesByExtraction.get(exId) ?? []) : [];
        }),
      ),
    ];
    const persisted: PersistedFlag = {
      ruleId: f.ruleId,
      severity: f.severity,
      rationale: f.rationale,
      sources: f.sources,
      clauseIds,
      ...(f.negotiationHint ? { negotiationHint: f.negotiationHint } : {}),
    };
    return { flag: f, persisted };
  });

  await deps.db.transaction(async (tx) => {
    await tx.delete(flags).where(and(eq(flags.documentId, doc.id), eq(flags.tenantId, tenantId)));
    for (const { flag, persisted } of items) {
      await tx.insert(flags).values({
        documentId: doc.id,
        tenantId,
        caseId: doc.caseId,
        ruleId: flag.ruleId,
        ruleVersion: flag.ruleVersion,
        severity: flag.severity,
        clauseIds: persisted.clauseIds,
        rationale: flag.rationale,
        sources: flag.sources,
        ...(flag.negotiationHint ? { negotiationHint: flag.negotiationHint } : {}),
      });
    }
  });

  return items.map((i) => i.persisted);
}
