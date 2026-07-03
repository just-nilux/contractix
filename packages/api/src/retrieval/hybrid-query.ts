import { sql } from "drizzle-orm";

import { type Db } from "../db/client.js";

export interface HybridQueryParams {
  tenantId: string;
  caseId: string;
  /** FR-2.5: retrieval scopes to the case by default; per-document on request. */
  documentId?: string | undefined;
  query: string;
  queryEmbedding: number[];
  /** fused candidates handed to the reranker (FR-2.3: top-40) */
  limit?: number;
}

export interface HybridRow {
  chunkId: string;
  clauseId: string;
  documentId: string;
  text: string;
  charStart: number;
  charEnd: number;
  chunkIndex: number;
  clauseRef: string;
  clausePath: string;
  heading: string | null;
  headingPath: string[];
  page: number;
  fusedScore: number;
}

const RRF_K = 60;
const PER_CHANNEL = 40;

/**
 * One SQL round trip: three ranked channels (HNSW cosine, language-aware
 * FTS, trigram word-similarity) fused with Reciprocal Rank Fusion (FR-2.2).
 * Runs in a transaction so `SET LOCAL hnsw.ef_search` can lift the HNSW
 * candidate stream above the post-filter starvation threshold (ADR-0002).
 * Every channel carries the single tenant guard (FR-7.4).
 */
export async function hybridQuery(db: Db, p: HybridQueryParams): Promise<HybridRow[]> {
  const limit = p.limit ?? PER_CHANNEL;
  const qvec = `[${p.queryEmbedding.join(",")}]`;
  const doc = p.documentId ?? null;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL hnsw.ef_search = 100`);

    const res = await tx.execute(sql`
      WITH vec AS (
        SELECT id, row_number() OVER (ORDER BY embedding <=> ${qvec}::vector) AS r
        FROM chunks
        WHERE tenant_id = ${p.tenantId} AND case_id = ${p.caseId}
          AND (${doc}::uuid IS NULL OR document_id = ${doc}::uuid)
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ${qvec}::vector
        LIMIT ${PER_CHANNEL}
      ),
      fts AS (
        SELECT id, row_number() OVER (ORDER BY rank DESC) AS r
        FROM (
          SELECT ch.id,
                 ts_rank_cd(ch.tsv, q.tsq) AS rank
          FROM chunks ch
          CROSS JOIN LATERAL websearch_to_tsquery(
            CASE WHEN ch.language = 'de' THEN 'german'::regconfig
                 ELSE 'english'::regconfig END,
            ${p.query}) AS q(tsq)
          WHERE ch.tenant_id = ${p.tenantId} AND ch.case_id = ${p.caseId}
            AND (${doc}::uuid IS NULL OR ch.document_id = ${doc}::uuid)
            AND ch.tsv @@ q.tsq
          ORDER BY rank DESC
          LIMIT ${PER_CHANNEL}
        ) ranked_fts
      ),
      trgm AS (
        SELECT id, row_number() OVER (ORDER BY sim DESC) AS r
        FROM (
          SELECT id, word_similarity(${p.query}, text) AS sim
          FROM chunks
          WHERE tenant_id = ${p.tenantId} AND case_id = ${p.caseId}
            AND (${doc}::uuid IS NULL OR document_id = ${doc}::uuid)
            AND ${p.query} <% text
          ORDER BY sim DESC
          LIMIT ${PER_CHANNEL}
        ) ranked_trgm
      ),
      fused AS (
        SELECT id, sum(1.0 / (${RRF_K} + r)) AS rrf
        FROM (
          SELECT id, r FROM vec
          UNION ALL SELECT id, r FROM fts
          UNION ALL SELECT id, r FROM trgm
        ) all_ranks
        GROUP BY id
      )
      SELECT ch.id            AS chunk_id,
             ch.clause_id     AS clause_id,
             ch.document_id   AS document_id,
             ch.text          AS text,
             ch.char_start    AS char_start,
             ch.char_end      AS char_end,
             ch.chunk_index   AS chunk_index,
             cl.clause_ref    AS clause_ref,
             cl.clause_path   AS clause_path,
             cl.heading       AS heading,
             cl.heading_path  AS heading_path,
             cl.page          AS page,
             f.rrf::float8    AS fused_score
      FROM fused f
      JOIN chunks ch ON ch.id = f.id
      JOIN clauses cl ON cl.id = ch.clause_id
      ORDER BY f.rrf DESC, ch.id
      LIMIT ${limit}
    `);

    return res.rows.map((row) => {
      const r = row;
      return {
        chunkId: r.chunk_id as string,
        clauseId: r.clause_id as string,
        documentId: r.document_id as string,
        text: r.text as string,
        charStart: r.char_start as number,
        charEnd: r.char_end as number,
        chunkIndex: r.chunk_index as number,
        clauseRef: r.clause_ref as string,
        clausePath: r.clause_path as string,
        heading: (r.heading as string | null) ?? null,
        headingPath: r.heading_path as string[],
        page: r.page as number,
        fusedScore: r.fused_score as number,
      };
    });
  });
}
