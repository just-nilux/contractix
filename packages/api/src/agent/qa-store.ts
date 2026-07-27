import { and, desc, eq } from "drizzle-orm";

import { type Db } from "../db/client.js";
import { citations, qaTurns } from "../db/schema/index.js";
import { type AskResult } from "./agent-service.js";

export interface QaStoreDeps {
  db: Db;
}

export interface PersistedTurn {
  id: string;
  createdAt: Date;
}

/**
 * Persist one answered question and its citations (FR-5.5, PRD data model §8).
 *
 * Written in a single transaction so a turn can never be observed without the
 * citations that justify it. Answer citations reuse the `citations` table with
 * `sourceType: "answer"` and carry the same structural span shape as extraction
 * citations — char offsets frozen at parse time plus the exact clause slice at
 * those offsets (ADR-0005) — so the UI highlighter treats both identically.
 */
export async function saveQaTurn(
  deps: QaStoreDeps,
  params: {
    tenantId: string;
    caseId: string;
    question: string;
    result: AskResult;
    costEur: number;
  },
): Promise<PersistedTurn> {
  const { result } = params;

  return deps.db.transaction(async (tx) => {
    const [turn] = await tx
      .insert(qaTurns)
      .values({
        tenantId: params.tenantId,
        caseId: params.caseId,
        question: params.question,
        answer: result.answer,
        traceJson: result.trace,
        grounded: result.grounded,
        corrected: result.corrected,
        couldNotVerify: result.couldNotVerify,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        // numeric() round-trips as a string in pg; format once, here.
        costEur: params.costEur.toFixed(6),
        latencyMs: result.latencyMs,
      })
      .returning({ id: qaTurns.id, createdAt: qaTurns.createdAt });

    if (!turn) throw new Error("failed to persist qa turn");

    if (result.citations.length > 0) {
      await tx.insert(citations).values(
        result.citations.map((c) => ({
          tenantId: params.tenantId,
          documentId: c.documentId,
          sourceType: "answer" as const,
          answerId: turn.id,
          clauseId: c.clauseId,
          charStart: c.charStart,
          charEnd: c.charEnd,
          verbatimAnchor: c.verbatimAnchor,
        })),
      );
    }

    return turn;
  });
}

export interface QaTurnSummary {
  id: string;
  question: string;
  answer: string;
  grounded: boolean;
  corrected: boolean;
  couldNotVerify: string[];
  inputTokens: number;
  outputTokens: number;
  costEur: number;
  latencyMs: number;
  createdAt: Date;
  trace: unknown;
}

/** Recent turns for a case, newest first — the chat history the UI replays. */
export async function listQaTurns(
  deps: QaStoreDeps,
  params: { caseId: string; tenantId: string; limit?: number },
): Promise<QaTurnSummary[]> {
  const rows = await deps.db
    .select()
    .from(qaTurns)
    .where(and(eq(qaTurns.caseId, params.caseId), eq(qaTurns.tenantId, params.tenantId)))
    .orderBy(desc(qaTurns.createdAt))
    .limit(params.limit ?? 20);

  return rows.map((r) => ({
    id: r.id,
    question: r.question,
    answer: r.answer,
    grounded: r.grounded,
    corrected: r.corrected,
    couldNotVerify: (r.couldNotVerify ?? []) as string[],
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costEur: Number(r.costEur),
    latencyMs: r.latencyMs,
    createdAt: r.createdAt,
    trace: r.traceJson,
  }));
}
