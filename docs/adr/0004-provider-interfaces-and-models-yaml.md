# ADR-0004: Provider interfaces, models.yaml, and the Jina pick

- **Status:** accepted
- **Date:** 2026-07-03

## Context

FR-2.4/FR-8 require embeddings, reranker, and LLMs behind config-driven provider interfaces with
per-chunk model versioning, EU-compatible data processing (FR-7.1), and cheap keyless test runs.
The model landscape shifts monthly; the PRD mandates a fresh landscape check at build start,
then pinning.

Landscape check (2026-07-03): Voyage `voyage-3-large` leads retrieval-quality benchmarks;
Cohere `embed-v4` + `Rerank 4 Pro` is the common managed stack; Jina (Berlin) ships
`jina-embeddings-v4` (3.8B, multilingual, matryoshka to 128) / `jina-embeddings-v5-text`
(newer) and `jina-reranker-v3` (0.6B listwise, 131K context), with EU processing and a free
tier. User decision: **Jina for both roles** — EU story matches FR-7.1, zero-cost start,
quality adequate for a corpus this size.

## Decision

- `models.yaml` at the repo root is the single binding of roles → providers → models → key env
  vars, validated by a Zod schema in `@contractix/shared`. Nothing else names a model.
- Pinned now: embeddings `jina:jina-embeddings-v4@1024` (`task: retrieval.passage` for chunks,
  `retrieval.query` for queries, `dimensions: 1024`), reranker `jina:jina-reranker-v3`.
  LLM roles reserved: Anthropic primary (`claude-sonnet-5` agent/report,
  `claude-haiku-4-5-20251001` classify/repair), OpenAI fallback pinned in Phase 3.
  `jina-embeddings-v5-text` is the noted upgrade candidate once its API naming stabilizes.
- Every chunk stores `embedding_model` (e.g. `jina:jina-embeddings-v4@1024`); the API asserts
  at boot that `models.yaml` dimensions equal the DB vector column's dimensions.
- Keyless mode is first-class: missing API key outside production yields deterministic
  **FakeEmbeddings** (char-trigram feature hashing, L2-normalized — weakly semantic on purpose
  so the vector channel is meaningfully exercised in tests) and a passthrough reranker.
- **Dimension/model migration recipe** (1024 is DDL-frozen): add a second nullable vector
  column sized for the new model → backfill batch-wise re-embedding where
  `embedding_model != <new id>` → swap the HNSW index → drop the old column. The per-chunk
  model id makes partial backfills observable and resumable.

## Consequences

- Provider swaps are a models.yaml + key change; the eval harness (recall@8 gate) makes them
  safe rather than scary.
- Free-tier rate limits (100 RPM / 100k TPM) are fine for the demo corpus; ingestion batches
  and backs off. Revisit paid tier before any real multi-user load.
- PRIVACY.md lists Jina as an external processor; anonymization pre-pass lands in Phase 4.
