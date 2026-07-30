import { and, desc, eq, isNull } from "drizzle-orm";

import { type NarrativeTrace, narrativeTraceSchema, serializeClauseId } from "@contractix/shared";

import { type Db } from "../db/client.js";
import { citations, clauses, qaTurns } from "../db/schema/index.js";
import { logger } from "../logger.js";
import { type AskResult } from "./agent-service.js";
import { type NarrativeResult } from "./report-writer.js";

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

/**
 * Recent turns for a case, newest first.
 *
 * Unused: there is no `GET /cases/{id}/turns`, and the chat transcript is
 * session-local (ADR-0013 decision 6). Kept because it is most of that endpoint
 * already — what it still needs is the citations join, without which a replayed
 * answer renders every `[[...]]` marker as "unresolved".
 */
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

/**
 * Persist a narrative report (FR-5.3). Same table, same citation path, same
 * transaction guarantee as a Q&A turn - a narrative *is* an agent-written,
 * cited, validated generation with a trace, tokens, cost and latency. `kind`
 * keeps them apart for the cost KPI and for the UI.
 */
export async function saveNarrativeTurn(
  deps: QaStoreDeps,
  params: {
    tenantId: string;
    caseId: string;
    documentId?: string;
    result: NarrativeResult;
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
        kind: "report",
        ...(params.documentId ? { documentId: params.documentId } : {}),
        promptVersion: result.promptVersion,
        // The "question" of a report is the request that produced it; kept
        // non-null so one table serves both kinds without a nullable column.
        question: params.documentId
          ? `narrative report for document ${params.documentId}`
          : "narrative report for case",
        answer: result.markdown,
        traceJson: result.trace,
        grounded: result.grounded,
        corrected: result.corrected,
        couldNotVerify: result.couldNotVerify,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costEur: params.costEur.toFixed(6),
        latencyMs: result.latencyMs,
      })
      .returning({ id: qaTurns.id, createdAt: qaTurns.createdAt });

    if (!turn) throw new Error("failed to persist narrative turn");

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

export interface StoredNarrative {
  turnId: string;
  markdown: string;
  citations: {
    clauseId: string;
    /** The `[[...]]` marker the narrative text carries; the client joins on it. */
    serializedClauseId: string;
    page: number;
    charStart: number;
    charEnd: number;
    documentId: string;
  }[];
  couldNotVerify: string[];
  grounded: boolean;
  corrected: boolean;
  promptVersion: string;
  createdAt: Date;
  trace: NarrativeTrace | null;
}

/**
 * `trace_json` is jsonb written by whichever deploy generated the row, so it is
 * the one field here that can legitimately be of an older shape. Parsed rather
 * than cast: a stale trace degrades to `null` and gets logged, and the report it
 * belongs to is still served. Refusing a working narrative over its debug
 * payload would be the wrong trade.
 */
function parseStoredTrace(turnId: string, raw: unknown): NarrativeTrace | null {
  if (raw == null) return null;
  const parsed = narrativeTraceSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  logger.warn({ turnId, issues: parsed.error.issues }, "stored narrative trace is not readable");
  return null;
}

/** The latest narrative for a case, if one has been generated. */
export async function latestNarrative(
  deps: QaStoreDeps,
  params: { caseId: string; tenantId: string; documentId?: string },
): Promise<StoredNarrative | null> {
  const rows = await deps.db
    .select()
    .from(qaTurns)
    .where(
      and(
        eq(qaTurns.caseId, params.caseId),
        eq(qaTurns.tenantId, params.tenantId),
        eq(qaTurns.kind, "report"),
        params.documentId ? eq(qaTurns.documentId, params.documentId) : isNull(qaTurns.documentId),
      ),
    )
    .orderBy(desc(qaTurns.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // Joined to `clauses` for the natural ref: the narrative's text cites clauses
  // by their serialized id, so without it a reader's client cannot tie a
  // `[[...]]` marker in the prose to the citation row that justifies it. The
  // citations table stores the uuid, which is the identity; the serialized form
  // is derived from it (ADR-0005) rather than duplicated into a column.
  const citationRows = await deps.db
    .select({
      clauseId: citations.clauseId,
      clauseRef: clauses.clauseRef,
      page: clauses.page,
      charStart: citations.charStart,
      charEnd: citations.charEnd,
      documentId: citations.documentId,
    })
    .from(citations)
    .innerJoin(clauses, eq(clauses.id, citations.clauseId))
    .where(and(eq(citations.answerId, row.id), eq(citations.tenantId, params.tenantId)));

  return {
    turnId: row.id,
    markdown: row.answer,
    citations: citationRows.map((c) => ({
      clauseId: c.clauseId,
      serializedClauseId: serializeClauseId(c.documentId, c.clauseRef),
      page: c.page,
      charStart: c.charStart,
      charEnd: c.charEnd,
      documentId: c.documentId,
    })),
    couldNotVerify: (row.couldNotVerify ?? []) as string[],
    grounded: row.grounded,
    corrected: row.corrected,
    promptVersion: row.promptVersion,
    createdAt: row.createdAt,
    trace: parseStoredTrace(row.id, row.traceJson),
  };
}
