# ADR-0008: Document classification and chained analysis

- **Status:** accepted
- **Date:** 2026-07-25
- **Builds on:** ADR-0004 (provider interfaces / models.yaml), ADR-0005 (frozen
  offsets), ADR-0006 (constrained extraction + deterministic rules)

## Context

After Phase 2, the extraction and rules machinery was fully built and tested but
**disconnected from the running service**: the BullMQ ingest job stopped at
`documents.status = 'ready'`, and `runExtraction` / `benchmarkDocument` were
callable only from scripts and the eval — no HTTP endpoint reached them. Two gaps
blocked an end-to-end "upload → cited red-flag report":

1. **No classifier.** `runExtraction` selects the extraction family from
   `documents.type` (ADR-0006), but nothing set it on a live upload — only the demo
   seed backfilled it. ADR-0006 explicitly deferred the FR-1.2 classifier to Phase 3.
2. **No wiring or surface.** Ingestion never triggered analysis, and there was no
   report/analyze route.

This is the first Phase-3 slice. It must keep the keyless path first-class
(ADR-0004) and the citation-integrity invariants (ADR-0005/0006/0007) intact.

## Decision

1. **Classifier is a sibling service** (`classifier-service.ts`), reusing the
   `LlmProvider.extract` forced-tool interface with no interface or `models.yaml`
   change. It drives one `classify_document` call (small model = Haiku) over a
   first-page + heading sample into a shared `classificationSchema`, then persists
   `documents.type`. A lone enum needs no repair pass: invalid output degrades to
   `other`/`low`. Keyless honesty is one scoped line in `FakeLlm` — `document_type`
   resolves to `other` (classification's no-signal answer, since it has no
   `not_found` member), so the whole chain runs deterministically without a key.

2. **Analysis runs as a separate chained BullMQ job**, not folded into the ingest
   job. `runAnalysis` orchestrates `classify → extract → benchmark`; the ingest
   worker enqueues it once a document reaches `ready`. Rationale: ingestion's infra
   surface is the parser + **paid Jina embeddings**, and its retry recomputes the
   whole job. Bolting the LLM-driven analysis onto that job would make an Anthropic
   hiccup **re-embed the entire document** on retry. A separate queue gives each
   stage its own retry and its own business/infra failure line. Every stage is
   already idempotent (each replaces its own rows), so a mid-chain crash recomputes
   cleanly — no partial analysis is observable, mirroring the ingest guarantee.

3. **The pure pipeline stays queue-agnostic.** `runIngestion` now returns its
   terminal `{ status, tenantId }` instead of `void`; the **worker** — not the
   pipeline — enqueues analysis, and only after the ingest transaction commits.

4. **`analysisStatus` is its own column** (`pending | analyzing | analyzed |
failed`), distinct from the ingest `status`. Overloading `status` would conflate
   a parse failure with an analysis failure and can't express "analyzing". The
   worker marks `failed` only once BullMQ retries are exhausted.

5. **Auto-chain, re-runnable.** Analysis auto-runs after ingestion; `POST
/documents/{id}/analyze` re-runs it. `enqueueAnalysis` uses `jobId = documentId`
   but removes any retained job first, so a re-analyze supersedes a finished/failed
   run while an in-flight (locked) job dedupes the add — a document is never
   analyzed twice at once.

6. **The report is a pure compose over stored rows.** `getDocumentReport` reads the
   persisted extractions, flags, and citations (tenant-scoped) and hands them to a
   pure `composeDocumentReport`. Citations are reused as the structural spans
   written at extraction time (ADR-0005/0007) — the resolver is never re-run and
   text is never re-quote-matched. Every report carries the not-legal-advice
   disclaimer (FR-7.6).

## Consequences

- Upload → cited red-flag report is reachable end to end through the API, keyless
  in CI and real once keyed, without rewriting any Phase-2 service.
- Analysis is re-runnable and versioned by the extraction/rule-set versions it
  already stamps, so a schema or `rules.yaml` bump is a re-analyze, not a migration.
- A second worker and a second Redis producer connection now run in the worker
  process; the API gains an `analysisQueue` dependency. Acceptable for one process.
- **Deferred, not dropped:** SSE progress (the analysis job already emits
  `onStage`, so a later events endpoint is a clean add); the OpenAI dual-provider
  fallback router (ADR-0004 — `models.yaml fallback.model` stays null); and a
  classifier gold eval (the corpus is 5 docs; the full golden corpus is Phase-4).
  Classifier accuracy is therefore **not** gated in CI yet — re-evaluate when the
  golden corpus grows, adding a classification metric alongside extraction/retrieval.
- Auth is still the single dev tenant (ADR-0006 / Phase-3 auth slice). The analysis
  job carries the real `tenantId` end to end so the guard is already correct when
  real tenants land.
