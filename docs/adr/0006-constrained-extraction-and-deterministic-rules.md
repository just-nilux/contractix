# ADR-0006: Constrained extraction and a deterministic rules engine

- **Status:** accepted
- **Date:** 2026-07-23

## Context

Phase 2 (PRD FR-3/FR-4) turns retrieved clauses into structured diligence:
extract every material term into a typed schema, then flag red flags. Three
requirements shape the design:

- **Citations must be verifiable, not plausible** — every extracted field must
  point at the exact source span (FR-1.4), building on ADR-0005's frozen
  offsets. Hallucinated terms are the worst failure mode.
- **`not_found` is first-class** — a missing term is reported, never inferred
  (FR-3), so the schema and prompt must make abstention the default.
- **Benchmarking must be reproducible and auditable** — the rules engine is
  _deliberately not_ LLM-judged (FR-4): same input, same flags, every run, with
  statutory sources a reviewer can check.

Phase 2 also introduces the first LLM provider; per ADR-0004 it sits behind the
same config-driven interface as embeddings/reranker, with a deterministic
keyless fake so tests/CI stay offline. No new binding is needed here — ADR-0004
already reserved the LLM role.

## Decision

- **Schema-first constrained extraction.** Zod family schemas
  (`@contractix/shared/schemas/extraction`) are the single source of truth. Each
  field is a `citedValue` — `{ value, unit?, confidence, citations[],
verbatim_anchor, status }`. The schema is converted to JSON Schema
  (`z.toJSONSchema`, refs inlined) and passed as a **forced tool** input to the
  LLM; the document is presented as clause-delimited **data, never instructions**
  (FR-7.5). Validation runs the Zod schema; a single repair pass follows a
  failure, then per-field `extraction_failed` (FR-3.4). `documents.type` selects
  the family — the classifier (FR-1.2) is deferred to Phase 3.
- **Structural citation resolution (applies ADR-0005).** For each field the
  `verbatim_anchor` is located inside the cited clause's frozen text and stored
  as absolute canonical offsets. An anchor that does not slice from the named
  clause is unresolved (never fuzzy-matched); an extracted value with no
  resolving citation is downgraded to low confidence, not dropped.
- **Deterministic rules engine (`@contractix/rules`).** Rule _copy_ and
  applicability live in a versioned `rules.yaml` (Zod-validated, loaded like
  `models.yaml`); the _checks_ are pure TypeScript over the extracted schema.
  `engine.ts` joins them 1:1 by id (a mismatch throws) and stamps every flag with
  the ruleset version. Rules return the field paths that triggered them; the API
  benchmark layer resolves those to clause ids from the persisted citations, so
  the engine stays pure (no LLM, no DB).
- **Persistence.** `extractions`, `citations`, and `flags` (migration 0004) are
  written idempotently under the `tenant_id` guard. The extraction service is
  standalone (not baked into the ingest worker) so the eval and the demo script
  drive the exact same code path.

## Consequences

- Swapping the extraction model is a `models.yaml` change; the extraction eval
  (field accuracy + citation recall, live-gated with a committed LLM-response
  cache) makes it safe rather than scary — same pattern as the retrieval eval.
- Rule copy (rationale, negotiation hint, statutory sources) is editable without
  touching code; the id-join invariant is the guard against yaml/checks drift.
- Real extraction accuracy and the rules firing on the corpus require a live
  provider key (keyless fake reports every field `not_found`, so no rules fire) —
  the eval baseline is therefore pinned from a deliberate live run, like retrieval.
- Re-evaluate when the classifier lands (Phase 3): extraction currently trusts
  `documents.type`; an agentic classify step will feed it instead.
