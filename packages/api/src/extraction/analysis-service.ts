import { type DocumentType } from "@contractix/shared";
import { and, eq } from "drizzle-orm";

import { type Db } from "../db/client.js";
import { documents } from "../db/schema/index.js";
import { ensureDevTenant } from "../db/tenancy.js";
import { type LlmProvider, type TokenUsage } from "../providers/index.js";
import { benchmarkDocument, type PersistedFlag } from "./benchmark-service.js";
import { classifyDocument } from "./classifier-service.js";
import { runExtraction } from "./extraction-service.js";

type RunningStatus = "analyzing" | "analyzed";

export interface AnalysisDeps {
  db: Db;
  llm: LlmProvider;
}

export interface AnalysisParams {
  documentId: string;
  /** Defaults to the dev tenant; the analysis worker passes the document's tenant. */
  tenantId?: string;
}

export interface AnalysisResult {
  documentId: string;
  documentType: DocumentType;
  /** false when the classified type has no extraction family (Q&A-only, FR-1.2). */
  extracted: boolean;
  flags: PersistedFlag[];
  usage: TokenUsage;
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

async function setStatus(
  db: Db,
  documentId: string,
  tenantId: string,
  status: RunningStatus,
): Promise<void> {
  await db
    .update(documents)
    .set({ analysisStatus: status })
    .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)));
}

/**
 * The document analysis chain (FR-5.3): classify -> extract -> benchmark, run as
 * one idempotent unit after ingestion reaches `ready`. Each step reuses its
 * standalone service and replaces its own rows, so a crash mid-chain recomputes
 * cleanly on retry — no partial analysis is observable. Ordering is load-bearing:
 * classification persists documents.type before extraction re-reads it. Sets
 * analysisStatus `analyzing` on entry and `analyzed` on success; infra failures
 * propagate so BullMQ retries, and the worker marks `failed` only once attempts
 * are exhausted. Tenant-scoped throughout (FR-7.4).
 */
export async function runAnalysis(
  deps: AnalysisDeps,
  params: AnalysisParams,
): Promise<AnalysisResult> {
  const tenantId = params.tenantId ?? (await ensureDevTenant(deps.db));
  const { documentId } = params;

  const owned = await deps.db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)))
    .limit(1);
  if (!owned[0]) throw new Error(`document not found in tenant: ${documentId}`);

  await setStatus(deps.db, documentId, tenantId, "analyzing");

  const classification = await classifyDocument(deps, { documentId, tenantId });
  const extraction = await runExtraction(deps, { documentId, tenantId });
  const flags = await benchmarkDocument({ db: deps.db }, { documentId, tenantId });

  await setStatus(deps.db, documentId, tenantId, "analyzed");

  return {
    documentId,
    documentType: classification.documentType,
    extracted: extraction.extraction !== null,
    flags,
    usage: addUsage(classification.usage, extraction.usage),
  };
}
