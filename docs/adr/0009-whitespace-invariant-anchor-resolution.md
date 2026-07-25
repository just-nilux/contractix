# ADR-0009: Whitespace- and typography-invariant anchor resolution

- **Status:** accepted
- **Date:** 2026-07-25
- **Refines:** ADR-0007 (anchor-first citation resolution)

## Context

ADR-0007 made citation resolution anchor-first: the clause whose frozen text
contains the model's exact `verbatim_anchor` **is** the citation, located with
`clause.text.includes(anchor)`. It recovered citation recall from 0.27 to 0.43,
but 0.43 remained the extraction eval's weakest metric — under half of extracted
fields got a resolving citation, against the product's headline promise that
_every claim cites the exact clause_.

Replaying the live run pinned the cause exactly. Of 85 extracted-field anchors,
44 matched and **41 did not — and every failure was a long, multi-word span whose
divergence fell on a whitespace boundary**:

```
…drei Tagen pro Woche | ␣nach Abstimmung…      (frozen text: "Woche\nnach")
…zum Monatsende       | ␣kündigen
…des Arbeitsverhältnisses | ␣ohne zeitliche Begrenzung
```

Char offsets are frozen at parse time (ADR-0005), so the canonical clause text
keeps the document's **original** whitespace (line breaks, NBSP, doubled spaces
from PDF/DOCX layout) and typography (German `„…"` quotes, en/em dashes). The
small model, reading that text, echoes anchors with plain single spaces and
straight punctuation. Exact `includes` then fails on the first such divergence —
so short anchors matched and long ones didn't. Measured recovery under
whitespace + quote/dash-tolerant matching: **37 of the 41**.

## Decision

Match the anchor against a **normalized projection** of each clause's frozen text
that still maps every normalized character back to its exact original UTF-16
offsets:

1. Any run of Unicode whitespace collapses to one space; quote and dash variants
   fold to `"` / `'` / `-`. The projection is built char-by-char, recording the
   original `[start, end)` span each normalized char came from.
2. The anchor is normalized the same way and located in the projection. The hit's
   original offsets come straight from the map, and the stored `verbatim_anchor`
   is the **original frozen slice** — not the model's re-spaced echo — so ADR-0005
   slice-identity holds exactly.
3. Everything else in ADR-0007 stands: model ids are hints only; prefer a hinted
   clause, otherwise resolve only when a single clause contains the anchor.

This is **invariance to formatting, not fuzzy matching**: still an exact substring
match (no edit distance, no partial credit), and an ambiguous anchor with no hint
is still left unresolved (ADR-0005: never guess).

## Consequences

- Citation recall on the demo corpus rises **0.43 → 0.91** (same cached model
  outputs, deterministic), with extraction accuracy (0.955), `not_found`
  precision (1.00), and hallucination (0.00) unchanged — the fix is purely in
  resolution, not extraction. The extraction baseline is re-pinned (a deliberate,
  reviewed change; PRD E-4).
- Precision is preserved: the projection is lossless with respect to offsets, and
  the unambiguous-or-hinted guard is untouched — no field resolves to a clause it
  didn't come from.
- The remaining misses are genuine (e.g. a value whose anchor is a paraphrase, or
  truly ambiguous), not formatting artifacts — the honest floor for this model.
- Clause projections are memoized per clause object; resolution stays O(clauses)
  per field with a small constant.
- Refines ADR-0007's matching mechanism only; its anchor-first, hints-as-hints,
  and never-guess decisions are unchanged.
