# Contractix

**Term-sheet & employment-offer diligence agent** — upload an employment offer, VSOP/ESOP agreement, or startup term sheet (German or English) and get every material term extracted, benchmarked against market standards, and flagged — with every claim citing the exact page and clause.

> ⚠️ Contractix provides informational analysis, **not legal or tax advice**. Statutory references are pointers, not determinations.

## Status

**Phases 0–2 complete** — the ingestion + retrieval spine and the extraction + red-flag engine are built and tested. Phase 3 (agentic Q&A, full report, web UI) is next. See [PRD.md](PRD.md) for the full specification and roadmap.

- **Ingestion & retrieval** — layout-aware PDF/DOCX parse → clause segmentation → chunking → pgvector + full-text + trigram hybrid search with cross-encoder rerank.
- **Extraction** — schema-first, per-field-cited extraction (employment offers/contracts, VSOP/ESOP, term sheets); every field carries a structural citation to the exact clause span, and `not_found` is a first-class value, never inferred.
- **Red-flag engine** — 31 deterministic, versioned rules over the extracted schema (e.g. sub-50% Karenzentschädigung, >1× / participating liquidation preference, bad-leaver forfeiture), each citing the clause(s) that triggered it.
- **Evals** — golden-corpus gates in CI, with pinned real numbers on the demo corpus:

  | gate | key metrics |
  | --- | --- |
  | **Extraction** (Haiku 4.5) | field accuracy **0.95** · `not_found` precision **1.00** · hallucination **0.00** · citation recall 0.43 |
  | **Rules / red-flag** (deterministic, keyless) | precision **1.00** · recall **1.00** · F1 **1.00** (24 flags / 5 docs, per severity) |
  | **Retrieval** (Jina v4) | recall@8 **0.97** · MRR@8 **0.86** |

  The rules gate is keyless and runs on **every PR**; the extraction gate runs live behind `ANTHROPIC_API_KEY`; the retrieval baseline is pending `JINA_API_KEY`. (The first live extraction run also earned its keep — it caught a citation-validation defect that keyless fakes had masked; see [ADR-0007](docs/adr/0007-anchor-first-citation-resolution.md).)

> Runs fully offline in **keyless mode** (deterministic fake providers) — `pnpm test`, the rules/red-flag eval, and their CI gates need no API keys. Real extraction/retrieval and their eval baselines require provider keys; see [`.env.example`](.env.example).

## Documentation

- [PRD.md](PRD.md) — product requirements (authoritative spec)
- [docs/adr/](docs/adr/) — architecture decision records
- [PRIVACY.md](PRIVACY.md) — data handling & model-provider posture

## License

MIT for this codebase — see [LICENSE](LICENSE).

Note: the PDF parsing path currently uses [`mupdf`](https://www.npmjs.com/package/mupdf) (AGPL-3.0). Parsing sits behind a `Parser` interface precisely so this dependency is swappable; the licensing reasoning is documented in the ADRs.
