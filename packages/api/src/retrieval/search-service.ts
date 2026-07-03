import { serializeClauseId } from "@contractix/shared";

import { type Db } from "../db/client.js";
import { type EmbeddingsProvider, type RerankerProvider } from "../providers/index.js";
import { hybridQuery, type HybridRow } from "./hybrid-query.js";

export interface SearchDeps {
  db: Db;
  embeddings: EmbeddingsProvider;
  reranker: RerankerProvider;
}

export interface SearchParams {
  tenantId: string;
  caseId: string;
  documentId?: string | undefined;
  query: string;
  topK?: number;
}

export interface SearchResultItem {
  clauseId: string;
  chunkId: string;
  documentId: string;
  clauseRef: string;
  /** the PRD's fully-qualified doc:page:clause_path citation id */
  serializedClauseId: string;
  clausePath: string;
  heading: string | null;
  headingPath: string[];
  page: number;
  charStart: number;
  charEnd: number;
  snippet: string;
  scores: { fused: number; rerank: number | null };
}

const DEFAULT_TOP_K = 8;
const SNIPPET_CHARS = 400;

/**
 * THE search code path (FR-2.3): embed query -> hybrid RRF top-40 -> rerank
 * -> dedupe chunks to clauses (best chunk wins) -> top-8 structural
 * citations. The REST route (Phase 1), the agent tool search_clauses
 * (Phase 3), the MCP tool (Phase 4), and the eval runner all call this
 * function - one implementation keeps the eval honest.
 */
export async function searchClauses(
  deps: SearchDeps,
  params: SearchParams,
): Promise<SearchResultItem[]> {
  const topK = params.topK ?? DEFAULT_TOP_K;
  const query = params.query.trim();
  if (query.length === 0) return [];

  const [queryEmbedding] = await deps.embeddings.embed([query], { inputType: "query" });
  if (!queryEmbedding) throw new Error("query embedding missing");

  const fused = await hybridQuery(deps.db, {
    tenantId: params.tenantId,
    caseId: params.caseId,
    documentId: params.documentId,
    query,
    queryEmbedding,
  });
  if (fused.length === 0) return [];

  const byChunkId = new Map<string, HybridRow>(fused.map((r) => [r.chunkId, r]));
  const reranked = await deps.reranker.rerank(
    query,
    fused.map((r) => ({ id: r.chunkId, text: r.text })),
    fused.length, // rerank the whole fused set; clause dedupe happens after
  );

  const results: SearchResultItem[] = [];
  const seenClauses = new Set<string>();
  for (const scored of reranked) {
    const row = byChunkId.get(scored.id);
    if (!row || seenClauses.has(row.clauseId)) continue;
    seenClauses.add(row.clauseId);
    results.push(toResult(row, scored.score));
    if (results.length >= topK) break;
  }
  return results;
}

function toResult(row: HybridRow, rerankScore: number | null): SearchResultItem {
  return {
    clauseId: row.clauseId,
    chunkId: row.chunkId,
    documentId: row.documentId,
    clauseRef: row.clauseRef,
    serializedClauseId: serializeClauseId(row.documentId, row.clauseRef),
    clausePath: row.clausePath,
    heading: row.heading,
    headingPath: row.headingPath,
    page: row.page,
    charStart: row.charStart,
    charEnd: row.charEnd,
    snippet:
      row.text.length > SNIPPET_CHARS ? `${row.text.slice(0, SNIPPET_CHARS - 3)}...` : row.text,
    scores: { fused: row.fusedScore, rerank: rerankScore },
  };
}
