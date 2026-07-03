# ADR-0005: Clause identity (uuid PK + natural ref) and frozen char offsets

- **Status:** accepted
- **Date:** 2026-07-03

## Context

FR-1.3 mandates stable clause IDs of the form `doc:page:clause_path`; FR-1.4 mandates that every
downstream answer cites `clause_id` + `char_start..char_end`, resolved structurally (never by
quote matching). These two invariants are the product's credibility: a drifting offset or
unstable ref silently corrupts every citation.

## Decision

**Identity.** Clause rows get a UUIDv7 primary key; the PRD's stable ID is decomposed:

- `clause_ref = "{page}:{clause_path}"` — natural key, unique per `(document_id, clause_ref)`,
  human-writable (gold labels in the eval set use it directly).
- Serialized form `"{document_uuid}:{clause_ref}"` — produced by a shared helper; used in API
  responses and later `[[clause_id]]` citation markers.

Rejected: the serialized string as the physical PK. It would bloat every FK
(chunks, citations, flags), turn any ref-format evolution into a data migration, and buy
nothing — stability across re-ingestion already holds because segmentation is deterministic
from the blob and idempotent re-ingestion keys on content hash (FR-1.5). UUIDv7 keeps b-tree
insert locality.

**Offsets.** One invariant, enforced repo-wide:

> All text normalization (NFKC, ligature folding, soft-hyphen stripping, dehyphenation,
> whitespace collapsing) happens inside `parser/normalize.ts` **before** offsets are assigned.
> The canonical document text is `blocks.map(b => b.text).join("\n")`; offsets are frozen
> against that string exactly once at parse time; every downstream stage only slices
> (`clause.text === canonical.slice(clause.charStart, clause.charEnd)`, chunk offsets are
> clause-relative additions). No stage after parse may transform text it stores.

A test iterates every clause and chunk of every corpus document asserting the slice identity.
Block geometry (bboxes for the Phase-3 PDF highlighter) is persisted as a
`{sha256}.blocks.json` sidecar next to the blob, not in the DB.

## Consequences

- Citations survive re-parsing, re-chunking, and re-embedding unchanged unless the source
  bytes change — in which case the content hash changes and the document is a new document.
- DOCX has no intrinsic pages: `page = 1` by convention, refs stay honest, and the Phase-3 UI
  renders DOCX as HTML span highlights instead of PDF page highlights.
- Any future normalization improvement (better dehyphenation, unicode edge cases) is a
  re-ingestion, never an in-place text fix.
