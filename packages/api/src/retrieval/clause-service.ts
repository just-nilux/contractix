import { serializeClauseId } from "@contractix/shared";
import { and, eq, gte, inArray, lte } from "drizzle-orm";

import { type Db } from "../db/client.js";
import { clauses } from "../db/schema/index.js";

export interface ClauseDeps {
  db: Db;
}

/**
 * A clause with its structural citation fields. `charStart`/`charEnd` are
 * absolute canonical offsets frozen at parse time (ADR-0005) — the UI resolves
 * them to a highlighted page span, and the grounding validator slices `text`
 * at them rather than quote-matching.
 */
export interface ClauseView {
  id: string;
  documentId: string;
  clauseRef: string;
  serializedClauseId: string;
  clausePath: string;
  heading: string | null;
  headingPath: string[];
  page: number;
  charStart: number;
  charEnd: number;
  seq: number;
  text: string;
}

type ClauseRow = typeof clauses.$inferSelect;

export function toClauseView(row: ClauseRow): ClauseView {
  return {
    id: row.id,
    documentId: row.documentId,
    clauseRef: row.clauseRef,
    serializedClauseId: serializeClauseId(row.documentId, row.clauseRef),
    clausePath: row.clausePath,
    heading: row.heading,
    headingPath: row.headingPath,
    page: row.page,
    charStart: row.charStart,
    charEnd: row.charEnd,
    seq: row.seq,
    text: row.text,
  };
}

/**
 * THE clause-loading path, shared by `GET /clauses/{id}`, the agent's
 * `get_clause` tool, and (Phase 4) the MCP server — one implementation so the
 * three surfaces cannot drift. Tenant-scoped (FR-7.4); returns null when the
 * clause is not in the tenant so callers 404 rather than leak existence.
 */
export async function getClause(
  deps: ClauseDeps,
  params: { clauseId: string; tenantId: string },
): Promise<ClauseView | null> {
  const rows = await deps.db
    .select()
    .from(clauses)
    .where(and(eq(clauses.id, params.clauseId), eq(clauses.tenantId, params.tenantId)))
    .limit(1);
  const row = rows[0];
  return row ? toClauseView(row) : null;
}

export interface ClauseContext {
  clause: ClauseView;
  before: ClauseView[];
  after: ClauseView[];
}

/** A clause plus `radius` neighbours in document order (FR-5.1). */
export async function getClauseContext(
  deps: ClauseDeps,
  params: { clauseId: string; tenantId: string; radius: number },
): Promise<ClauseContext | null> {
  const clause = await getClause(deps, params);
  if (!clause) return null;

  const neighbors = await deps.db
    .select()
    .from(clauses)
    .where(
      and(
        eq(clauses.documentId, clause.documentId),
        eq(clauses.tenantId, params.tenantId),
        gte(clauses.seq, clause.seq - params.radius),
        lte(clauses.seq, clause.seq + params.radius),
      ),
    )
    .orderBy(clauses.seq);

  return {
    clause,
    before: neighbors.filter((n) => n.seq < clause.seq).map(toClauseView),
    after: neighbors.filter((n) => n.seq > clause.seq).map(toClauseView),
  };
}

/** Batch-load clauses by uuid PK — the shape search results carry. */
export async function getClausesByIds(
  deps: ClauseDeps,
  params: { clauseIds: string[]; tenantId: string },
): Promise<ClauseView[]> {
  if (params.clauseIds.length === 0) return [];
  const rows = await deps.db
    .select()
    .from(clauses)
    .where(
      and(
        eq(clauses.tenantId, params.tenantId),
        inArray(clauses.id, [...new Set(params.clauseIds)]),
      ),
    );
  return rows.map(toClauseView);
}

/**
 * Batch-load clauses by serialized id (`{documentId}:{page}:{path}`), the form
 * carried by `[[clause_id]]` answer markers. Unknown ids are simply absent from
 * the result, which is what lets the grounding validator report them as
 * unresolved instead of failing the turn.
 */
export async function getClausesBySerializedId(
  deps: ClauseDeps,
  params: { serializedIds: string[]; tenantId: string },
): Promise<Map<string, ClauseView>> {
  const out = new Map<string, ClauseView>();
  if (params.serializedIds.length === 0) return out;

  const wanted = new Set(params.serializedIds);
  const documentIds = [
    ...new Set(
      params.serializedIds.map((id) => id.slice(0, id.indexOf(":"))).filter((id) => id.length > 0),
    ),
  ];
  if (documentIds.length === 0) return out;

  const rows = await deps.db
    .select()
    .from(clauses)
    .where(and(eq(clauses.tenantId, params.tenantId), inArray(clauses.documentId, documentIds)));

  for (const row of rows) {
    const view = toClauseView(row);
    if (wanted.has(view.serializedClauseId)) out.set(view.serializedClauseId, view);
  }
  return out;
}
