# ADR-0002: One Postgres for relational, vector, full-text, and trigram retrieval

- **Status:** accepted
- **Date:** 2026-07-03

## Context

FR-2.2 requires hybrid retrieval: dense embeddings, language-aware full-text, and trigram term
lookup, fused with RRF (k=60). The corpus per case is small (≤10 docs × ≤150 pages); even the
full golden corpus stays well under 10k chunks. A dedicated vector DB (Qdrant, Weaviate) would
add an operational surface, a second backup story, and cross-store consistency questions.

## Decision

Postgres 17 (`pgvector/pgvector:pg17` image) is the only datastore:

- `chunks.embedding vector(1024)` with an HNSW index (`vector_cosine_ops`), **default build
  params** `m=16, ef_construction=64` — at this corpus size recall is governed by the query-time
  `hnsw.ef_search`, which the search transaction raises to 100 (`SET LOCAL`). This also guards
  against filtered-scan starvation (tenant/case predicates shrink the candidate stream).
  `hnsw.iterative_scan = relaxed_order` is the documented next knob if starvation is ever
  observed.
- `chunks.tsv` is a **stored generated column** using the two-argument
  `to_tsvector('german'|'english'::regconfig CASE, text)` — the one-argument form and
  `unaccent()` are STABLE, not IMMUTABLE, and are rejected in generated columns. No unaccent in
  v1; the trigram channel backstops diacritic and compound-word misses (German
  `Kündigungsfrist`-class terms defeat stemming — that is _why_ there are three channels).
- `pg_trgm` GIN index on `chunks.text` for `word_similarity` lookup.
- RRF fusion happens in one SQL statement; reranking happens in code behind a provider
  interface.

Related clarification: the `tenants` table is **not** multi-tenant scope creep (PRD explicitly
excludes orgs/teams). A tenant is one user account or the anonymous demo tenant; the table
exists so FR-7.4's "single `tenant_id` guard in every query" has a subject, and `tenant_id` is
denormalized onto documents/clauses/chunks so the guard never needs joins.

## Consequences

- One backup/restore/migration story; retrieval is testable with plain SQL fixtures.
- Embedding dimension is DDL-frozen at 1024 (see ADR-0004 for the re-embed recipe).
- If corpus scale ever demands a dedicated ANN store, the retrieval module is the single seam.
