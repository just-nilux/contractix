# ADR-0007: Anchor-first citation resolution

- **Status:** accepted
- **Date:** 2026-07-25
- **Refines:** ADR-0006 (structural citation resolution)

## Context

ADR-0006 resolved each extracted field's citation **within the clause the model
named**, and the extraction schema validated `citedValue.citations` as a strict
`clauseIdSchema` (`{uuid}:{page}:{clause_path}`). Both choices assume the model
reliably reproduces the serialized clause id.

The **first live extraction eval** (Haiku 4.5, the extraction `small_model`)
disproved that assumption and exposed a severe failure mode that keyless fakes
had hidden (`FakeLlm` returns `not_found` with empty citations, so the citation
path was never exercised for real):

- The whole extraction is validated in one `safeParse`. When the model returned a
  citation string that wasn't a valid `clauseIdSchema` — which it did routinely,
  it rarely echoes the long id verbatim — the **entire document** failed
  validation, the repair pass failed the same way, and `allFailed()` marked
  **every field** `extraction_failed`. Two of four demo doc types
  (`employment_contract`, `vsop_esop_agreement`) extracted **zero** fields even
  though the model's **values were correct** — only the citation ids were
  malformed. Measured: extraction accuracy 0.64, citation recall 0.27.
- Even when validation passed, binding resolution to the model's (often wrong or
  malformed) id depressed citation recall.

This contradicts ADR-0006's own principle that citations resolve **structurally**
from `verbatim_anchor`, never by trusting model-authored ids.

## Decision

1. **The extraction schema accepts any string citation.** `citedValue.citations`
   is `z.array(z.string())`, not `z.array(clauseIdSchema)`. Model citations are
   **hints**, not a validation gate — their format never fails the extraction.
   (`clauseIdSchema` remains the contract everywhere _our_ code authors a
   serialized id: API responses, agent `[[clause_id]]` markers, eval gold.)

2. **Citation resolution is anchor-first.** The clause whose frozen text contains
   the exact `verbatim_anchor` **is** the citation; its absolute offsets are
   emitted by slicing (ADR-0005). The model's ids are used only to **disambiguate**
   a repeated anchor:
   - anchor present → the containing clause, preferring a hinted one; with no
     usable hint, resolve only when the anchor is **unambiguous** (a single
     containing clause) — never guess among several (ADR-0005: no fuzzy matching);
   - anchor empty → the whole span of each hinted clause;
   - nothing grounded → `unresolved` (the value is kept, confidence downgraded).

## Consequences

- Extraction is robust to small-model citation formatting: a malformed id no
  longer zeroes out a document, and a correct `verbatim_anchor` grounds the value
  even when the id is unusable — recovering both accuracy and citation recall.
- The safety property is preserved and sharpened: resolution still only ever
  **slices** frozen text (ADR-0005), and an ambiguous anchor with no hint is left
  unresolved rather than guessed — precision over recall.
- Keyless mode is unaffected (`FakeLlm` still returns empty citations). The
  extraction eval — now live-gated with a committed LLM-response cache and a
  pinned baseline — measures both effects and guards against regressions.
- This refines ADR-0006's citation-resolution mechanism only; its schema-first
  extraction, `not_found`-first, and deterministic-rules decisions stand.
