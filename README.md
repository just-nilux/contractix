# Contractix

**Term-sheet & employment-offer diligence agent** — upload an employment offer, VSOP/ESOP agreement, or startup term sheet (German or English) and get every material term extracted, benchmarked against market standards, and flagged — with every claim citing the exact page and clause.

> ⚠️ Contractix provides informational analysis, **not legal or tax advice**. Statutory references are pointers, not determinations.

## Who it's for

You've been handed a dense, adversarially-drafted document and a short deadline. Contractix reads it the way a careful advisor would — extracting every material term, checking it against market and German/EU statutory norms, and surfacing what to push back on, with a citation to the exact clause behind every claim.

- 🧑‍💻 **Senior engineer / exec weighing an offer** — *Is this VSOP grant actually worth anything? Is the non-compete enforceable? Where's the bad-leaver trap?*
- 🚀 **Founder handed a term sheet** — *Which terms deviate from standard, and what do I negotiate?* — liquidation preference, anti-dilution, ESOP dilution math, board control.
- 👼 **Angel / operator-advisor** — *Give me a red-flag summary of this whole document set in five minutes.*

German **and** English documents, including mixed sets — with DE/EU statutory awareness (HGB non-compete rules, BGB notice periods, Probezeit ceilings) that generic "chat with your PDF" tools don't have.

## What it catches

A sample of the 31 deterministic rules. Each fires only on the *extracted* terms, is severity-ranked so the worst traps surface first, and cites the clause(s) that triggered it plus its statutory or market source:

| document | trigger | flag |
| --- | --- | --- |
| Employment | post-contractual non-compete without ≥ 50% Karenzentschädigung | 🔴 unenforceable under §74 HGB, yet still deters |
| Employment | Probezeit longer than 6 months | 🔴 exceeds the §622 BGB ceiling |
| Employment | IP assignment with no side-project carve-out | 🟠 captures your open-source / side work |
| VSOP/ESOP | bad-leaver forfeiture of **vested** options | 🔴 voids already-earned value |
| VSOP/ESOP | payout only on a narrow, board-defined exit | 🟠 vested options may never pay out |
| Term sheet | liquidation preference > 1× or participating | 🔴 / 🟠 investors paid first — sometimes twice |
| Term sheet | full-ratchet anti-dilution | 🔴 maximal founder dilution on a down round |
| Term sheet | ESOP pool created pre-money | ℹ️ founder-dilutive — the math is shown |

🔴 red · 🟠 amber · ℹ️ info

## Status

**Phases 0–2 complete** — the ingestion + retrieval spine and the extraction + red-flag engine are built and tested. Phase 3 (agentic Q&A, full report, web UI) is next. See [PRD.md](PRD.md) for the full specification and roadmap.

- **Ingestion & retrieval** — layout-aware PDF/DOCX parse → clause segmentation → chunking → pgvector + full-text + trigram hybrid search with cross-encoder rerank.
- **Extraction** — schema-first, per-field-cited extraction (employment offers/contracts, VSOP/ESOP, term sheets); every field carries a structural citation to the exact clause span, and `not_found` is a first-class value, never inferred.
- **Red-flag engine** — 31 deterministic, versioned rules over the extracted schema ([sampled above](#what-it-catches)), each citing the clause(s) that triggered it and its source. Deterministic and auditable — *not* LLM-judged, so the same document always yields the same flags.
- **Evals** — golden-corpus gates in CI, with pinned real numbers on the demo corpus:

  | gate | key metrics |
  | --- | --- |
  | **Extraction** (Haiku 4.5) | field accuracy **0.95** · `not_found` precision **1.00** · hallucination **0.00** · citation recall 0.43 |
  | **Rules / red-flag** (deterministic, keyless) | precision **1.00** · recall **1.00** · F1 **1.00** (24 flags / 5 docs, per severity) |
  | **Retrieval** (Jina v4) | recall@8 **0.97** · MRR@8 **0.86** |

  The rules gate is keyless and runs on **every PR**; the extraction gate runs live behind `ANTHROPIC_API_KEY`; the retrieval baseline is pending `JINA_API_KEY`. (The first live extraction run also earned its keep — it caught a citation-validation defect that keyless fakes had masked; see [ADR-0007](docs/adr/0007-anchor-first-citation-resolution.md).)

> Runs fully offline in **keyless mode** (deterministic fake providers) — `pnpm test`, the rules/red-flag eval, and their CI gates need no API keys. Real extraction/retrieval and their eval baselines require provider keys; see [`.env.example`](.env.example).

## One engine, many document types

The spine — typed extraction → a deterministic, versioned rules engine → a report where every claim resolves to an exact source span — is document-agnostic. The same approach benchmarks NDAs, DPAs, or SaaS/commercial contracts, or runs EU-regulation gap analysis (GDPR, the AI Act) — anywhere an **auditable, cited** answer matters more than a fluent one. Employment offers and venture-finance are the first vertical, not the ceiling.

## Documentation

- [PRD.md](PRD.md) — product requirements (authoritative spec)
- [docs/adr/](docs/adr/) — architecture decision records
- [PRIVACY.md](PRIVACY.md) — data handling & model-provider posture

## License

MIT for this codebase — see [LICENSE](LICENSE).

Note: the PDF parsing path currently uses [`mupdf`](https://www.npmjs.com/package/mupdf) (AGPL-3.0). Parsing sits behind a `Parser` interface precisely so this dependency is swappable; the licensing reasoning is documented in the ADRs.
