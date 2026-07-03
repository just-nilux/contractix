import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { clauses } from "./clauses.js";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/** Must match models.yaml embeddings.dimensions - asserted at boot (ADR-0004). */
export const EMBEDDING_DIMS = 1024;

/**
 * Retrieval unit (FR-2.1): chunk = clause unless split at ~1,200 tokens.
 * document/case/tenant ids are denormalized so the hybrid query carries the
 * FR-7.4 tenant guard and case/doc scoping without joins.
 */
export const chunks = pgTable(
  "chunks",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    clauseId: uuid()
      .notNull()
      .references(() => clauses.id, { onDelete: "cascade" }),
    documentId: uuid().notNull(),
    caseId: uuid().notNull(),
    tenantId: uuid().notNull(),
    chunkIndex: integer().notNull(),
    text: text().notNull(),
    charStart: integer().notNull(),
    charEnd: integer().notNull(),
    tokenCount: integer().notNull(),
    /** strict binary - the tsvector config needs german|english per row */
    language: text({ enum: ["de", "en"] }).notNull(),
    embedding: vector({ dimensions: EMBEDDING_DIMS }),
    /** e.g. "jina:jina-embeddings-v4@1024" (FR-2.4, re-embed migrations) */
    embeddingModel: text().notNull(),
    /**
     * STORED generated column. Only the two-argument to_tsvector(regconfig,
     * text) is IMMUTABLE (one-arg reads a GUC and is STABLE -> rejected in
     * generated columns); the CASE over per-row language keeps stemming
     * aligned with how queries are built (ADR-0002).
     */
    tsv: tsvector().generatedAlwaysAs(
      sql`to_tsvector(CASE WHEN "language" = 'de' THEN 'german'::regconfig ELSE 'english'::regconfig END, "text")`,
    ),
  },
  (t) => [
    uniqueIndex("chunks_clause_idx_uq").on(t.clauseId, t.chunkIndex),
    index("chunks_tenant_case_idx").on(t.tenantId, t.caseId),
    index("chunks_document_idx").on(t.documentId),
    index("chunks_embedding_hnsw")
      .using("hnsw", t.embedding.op("vector_cosine_ops"))
      .with({ m: 16, ef_construction: 64 }),
    index("chunks_tsv_gin").using("gin", t.tsv),
    index("chunks_text_trgm").using("gin", t.text.op("gin_trgm_ops")),
  ],
);
