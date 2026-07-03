# ADR-0003: mupdf (AGPL-3.0) behind a Parser interface

- **Status:** accepted
- **Date:** 2026-07-03

## Context

FR-1.3 needs layout-aware PDF parsing with per-block page + coordinates so citations can resolve
to highlighted spans. The npm `mupdf` package (Artifex's official WASM build) provides
structured text with geometry and is the strongest option without a Python sidecar. It is
licensed **AGPL-3.0** (dual-licensed commercially); this repository's own code is MIT. An MIT
`LICENSE` file does not and cannot relicense a dependency, and because the API links mupdf and
will eventually be offered as a network service, **AGPL §13 (remote network interaction)
obligations attach to the deployed combined work** — users of the hosted service must be offered
the corresponding source.

## Decision

- Use `mupdf` for the native-PDF path, isolated behind a `Parser` interface
  (`supports(mime)` / `parse(buf) → { blocks, pageCount, report }`). Nothing outside
  `ingestion/parser/` may import mupdf.
- Compliance posture, in order of project state:
  1. **Now (private repo, no public deployment):** no AGPL network obligation is triggered;
     local/dev use is unrestricted.
  2. **At public launch (planned):** the repository goes public, which satisfies §13's
     corresponding-source offer for the deployed service.
  3. **If the repo ever stays private while the service is public, or the project is
     commercialized:** swap the PDF implementation to pdf.js (Apache-2.0) behind the same
     interface, or purchase the Artifex commercial license. The interface is the escape hatch;
     the swap cost is one module.
- The DOCX path (mammoth, BSD-2) sits behind the same interface. Known limitation, accepted for
  v1: Word auto-numbering lives in `numbering.xml` and is invisible to mammoth, so
  auto-numbered DOCX degrade to fallback segmentation; our authored corpus uses literal
  clause-number text (common in German legal templates anyway).

## Consequences

- README carries a one-line AGPL notice so nobody is surprised.
- The Parser interface is also the Phase-4 seam for the OCR/docling path (PRD parsing
  abstraction requirement).
- Interview-ready answer exists in writing for "you mixed MIT and AGPL?"
