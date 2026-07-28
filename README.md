# Contractix

**Term-sheet & employment-offer diligence agent** — upload an employment offer, VSOP/ESOP agreement, or startup term sheet (German or English) and get every material term extracted, benchmarked against market standards, and flagged — with every claim citing the exact page and clause.

> ⚠️ Contractix provides informational analysis, **not legal or tax advice**. Statutory references are pointers, not determinations.

## Who it's for

You've been handed a dense, adversarially-drafted document and a short deadline. Contractix reads it the way a careful advisor would — extracting every material term, checking it against market and German/EU statutory norms, and surfacing what to push back on, with a citation to the exact clause behind every claim.

- 🧑‍💻 **Senior engineer / exec weighing an offer** — _Is this VSOP grant actually worth anything? Is the non-compete enforceable? Where's the bad-leaver trap?_
- 🚀 **Founder handed a term sheet** — _Which terms deviate from standard, and what do I negotiate?_ — liquidation preference, anti-dilution, ESOP dilution math, board control.
- 👼 **Angel / operator-advisor** — _Give me a red-flag summary of this whole document set in five minutes._

German **and** English documents, including mixed sets — with DE/EU statutory awareness (HGB non-compete rules, BGB notice periods, Probezeit ceilings) that generic "chat with your PDF" tools don't have.

## What it catches

A sample of the 31 deterministic rules. Each fires only on the _extracted_ terms, is severity-ranked so the worst traps surface first, and cites the clause(s) that triggered it plus its statutory or market source:

| document   | trigger                                                        | flag                                             |
| ---------- | -------------------------------------------------------------- | ------------------------------------------------ |
| Employment | post-contractual non-compete without ≥ 50% Karenzentschädigung | 🔴 unenforceable under §74 HGB, yet still deters |
| Employment | Probezeit longer than 6 months                                 | 🔴 exceeds the §622 BGB ceiling                  |
| Employment | IP assignment with no side-project carve-out                   | 🟠 captures your open-source / side work         |
| VSOP/ESOP  | bad-leaver forfeiture of **vested** options                    | 🔴 voids already-earned value                    |
| VSOP/ESOP  | payout only on a narrow, board-defined exit                    | 🟠 vested options may never pay out              |
| Term sheet | liquidation preference > 1× or participating                   | 🔴 / 🟠 investors paid first — sometimes twice   |
| Term sheet | full-ratchet anti-dilution                                     | 🔴 maximal founder dilution on a down round      |
| Term sheet | ESOP pool created pre-money                                    | ℹ️ founder-dilutive — the math is shown          |

🔴 red · 🟠 amber · ℹ️ info

## Status

**Phases 0–2 complete; Phase 3 in progress** — the ingestion + retrieval spine, the extraction + red-flag engine, the agentic Q&A path, the API surface, and the web app's report and citation path are built and tested. The chat panel, trace drawer and comparison view, and the staging deploy, are what remain of Phase 3. See [PRD.md](PRD.md) for the full specification and roadmap.

- **Ingestion & retrieval** — layout-aware PDF/DOCX parse → clause segmentation → chunking → pgvector + full-text + trigram hybrid search with cross-encoder rerank.
- **Extraction** — schema-first, per-field-cited extraction (employment offers/contracts, VSOP/ESOP, term sheets); every field carries a structural citation to the exact clause span, and `not_found` is a first-class value, never inferred.
- **Red-flag engine** — 31 deterministic, versioned rules over the extracted schema ([sampled above](#what-it-catches)), each citing the clause(s) that triggered it and its source. Deterministic and auditable — _not_ LLM-judged, so the same document always yields the same flags.
- **Agentic Q&A** — `POST /cases/{id}/ask` streams a cited answer over SSE. A hand-rolled tool loop (search, clause lookup, extraction, red flags, deterministic arithmetic) answers the question, then a validator checks the result: every factual sentence must carry a `[[clause_id]]` marker naming a clause a tool actually returned, resolved structurally to a frozen span — never quote-matched. A failure buys one corrective regeneration; anything still unsupported is returned under "could not verify" rather than dropped. Each turn persists its trace, tokens, cost and latency.
- **Web app** — upload or one-click demo → streamed per-document progress → report → click any citation and the clause is highlighted on the page it came from. The highlight is computed in the browser from the same frozen character offsets the citation carries, intersected with the block geometry the parser retained — so it is exact wherever a citation covers whole blocks (every red flag, since clauses are segmented on block boundaries), and visibly approximate rather than confidently wrong where it covers part of one. Beside it sits the clause text with the cited span marked, which is a plain slice of frozen text at frozen offsets and therefore exact by construction — which is also the fallback for DOCX, which has no page geometry at all. Searching the text layer for the quoted anchor would have been pixel-exact and is exactly what [ADR-0006](docs/adr/0006-constrained-extraction-and-deterministic-rules.md)/[0007](docs/adr/0007-anchor-first-citation-resolution.md) forbid: its failure mode is highlighting a _different_ occurrence of the same phrase ([ADR-0012](docs/adr/0012-web-data-layer-and-client-side-citation-highlighting.md)).
- **Anonymous sessions** — no accounts. Creating a case, or one-click adopting the demo corpus, mints a signed `HttpOnly` cookie carrying nothing but an opaque tenant id; every query then carries a single `tenant_id` equality guard, so one session 404s another's case. The session and everything under it are purged 24 h later, and because the tenant row is the authority, deleting the data _is_ revoking the cookie. Redis-backed per-IP and per-tenant rate limits return an exact `Retry-After`, and fail **open** — a limiter that takes the demo down when Redis hiccups has done more damage than the abuse it prevents ([ADR-0011](docs/adr/0011-anonymous-sessions-and-demo-adoption.md)).
- **Try without upload** — the seeded corpus is _copied_ into your session rather than shared read-only, so you can question it, re-analyze it, upload your own contract beside it and delete the lot. Sharing it read-only would have turned the tenant guard into set membership at every query site, forever; the clone keeps that invariant literally true, and the embeddings never leave Postgres.
- **Evals** — golden-corpus gates in CI, with pinned real numbers on the demo corpus:

  | gate                                          | key metrics                                                                                              |
  | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
  | **Extraction** (Haiku 4.5)                    | field accuracy **0.95** · `not_found` precision **1.00** · hallucination **0.00** · citation recall 0.91 |
  | **Rules / red-flag** (deterministic, keyless) | precision **1.00** · recall **1.00** · F1 **1.00** (24 flags / 5 docs, per severity)                     |
  | **Retrieval** (Jina v4)                       | recall@8 **1.00** · MRR@8 **1.00**                                                                       |

  The rules gate is keyless and runs on **every PR**; the extraction and retrieval gates run live behind `ANTHROPIC_API_KEY` / `JINA_API_KEY` (both baselines pinned from real runs).

  **The Q&A path is not eval-gated yet.** Its citation integrity is enforced structurally at runtime rather than measured — a marker resolves only against a clause a tool actually returned — but faithfulness and answer relevance need an LLM-as-judge suite with a pinned judge model and versioned prompts (PRD E-2/E-4), which is Phase 4. The 30 gold Q&A pairs that currently score retrieval become its answer-level set then. Same for the adversarial injection suite.

  Running things live has repeatedly earned its keep: the first live extraction run caught a citation-validation defect that keyless fakes had masked ([ADR-0007](docs/adr/0007-anchor-first-citation-resolution.md)), and the first live Q&A run caught a grounding validator strict enough to reject its own correct answers ([ADR-0010](docs/adr/0010-agent-loop-and-grounding-contract.md)).

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
