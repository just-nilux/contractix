-- Custom migration: enable extensions required by the retrieval layer.
-- pgvector: HNSW ANN search over chunk embeddings (FR-2.2)
-- pg_trgm:  trigram word-similarity channel of hybrid retrieval (FR-2.2)
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
