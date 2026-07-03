# PRD — Contractix: Term Sheet & Employment Offer Diligence Agent

**Version:** 1.0 · **Date:** 2026-07-03 · **Owner:** Samuel Klyk · **Status:** Draft for build
**AI/LLM: DO NOT EDIT THIS DOCUMENT**
---

## 1. Summary

Contractix is a production, agentic document-diligence system for founders, senior engineers, and angel investors evaluating **employment offers, VSOP/ESOP agreements, and startup term sheets** (German + English). The user uploads one or more documents; the system extracts every material term into a typed schema, benchmarks each term against market standards and statutory norms (DE/EU-aware), answers free-form questions via an agentic RAG loop, and produces a **red-flag report where every claim carries a citation to the exact page and clause**.

**Strategic purpose (equally important as the product itself):** produce demonstrable, live, production evidence of shipping LLM + RAG + agent systems over documents — with a CI eval harness, cost/latency instrumentation, citation enforcement, and human-review UX. Every architectural choice below is made to be defensible in a senior AI-engineer interview.

**Non-goal framing:** this is not legal advice and must say so. It is decision support with verifiable citations.

---

## 2. Problem

- Offer letters, VSOPs, and term sheets are dense, adversarially drafted, and read under time pressure. Recipients routinely miss bad-leaver clauses, non-standard liquidation preferences, or unenforceable non-competes.
- Enterprise tools that do this (Harvey, Hebbia, Luminance) cost $3K–40K+/seat/year and target law firms — inaccessible to the individual on the receiving end of the document.
- Generic "chat with PDF" tools hallucinate, give no citations, don't know German employment/corporate law norms, and cannot compare multiple offers side-by-side.

## 3. Target users

| Persona | Job to be done |
|---|---|
| P1: Senior engineer / exec candidate (primary) | "Is this offer + VSOP fair? What's negotiable? What's a trap?" |
| P2: Founder receiving a term sheet | "Which terms deviate from standard? What do I push back on?" |
| P3: Angel / operator advisor | "Give me a red-flag summary of this document set in 5 minutes." |

Primary market: Germany/EU. Documents in **German and English**, including mixed sets.

## 4. Success criteria

**Product KPIs (instrumented from day one):**
- Faithfulness: ≥ 0.95 of report claims supported by cited source span (judged by eval harness, human-audited sample)
- Extraction field accuracy on golden set: ≥ 0.92 exact/normalized match
- Citation validity: 100% of citations resolve to a real span in the source document (hard-enforced, not just measured)
- P95 end-to-end analysis latency: ≤ 90 s for a 30-page document set; P95 Q&A latency ≤ 8 s
- Cost per full analysis: ≤ €0.40 median; per Q&A query ≤ €0.03 — logged per request
- Uptime ≥ 99.5% (uptime-kuma)

**Career KPIs:**
- Live public demo URL + demo corpus, one-click try without signup
- Public GitHub repo (or public architecture write-up if repo stays private)
- Eval harness runs in CI; README shows the eval dashboard screenshot with real numbers
- Exposed as an MCP server usable from Claude/any MCP client

## 5. Non-goals (v1)

- No legal advice, no drafting/redlining of documents
- No multi-tenant orgs/teams, no SSO (single-user accounts + anonymous demo only)
- No jurisdictions beyond DE (statutory rules) — generic market benchmarks still apply to EN docs
- No fine-tuning / model training (out of scope; roadmap note only)
- No mobile app; responsive web only

---

## 6. Functional requirements

### 6.1 Document ingestion (FR-1)

- **FR-1.1** Accept upload of PDF (native + scanned), DOCX, and images (PNG/JPG of pages). Max 25 MB / 150 pages per document, up to 10 documents per "case".
- **FR-1.2** Classify each document into: `employment_offer`, `employment_contract`, `vsop_esop_agreement`, `term_sheet`, `shareholders_agreement`, `side_letter`, `other`. Classification is agent-driven (first-page + structure sample → LLM classify with confidence); `other` is analyzed generically (Q&A only, no schema extraction).
- **FR-1.3** Parsing pipeline (per document):
  1. Detect native text layer; if coverage < 80% of pages → OCR path.
  2. Layout-aware parse to a canonical intermediate format: ordered blocks `{page, bbox, type: heading|paragraph|list_item|table_cell|footer, text, char_start, char_end}`. Tables preserved as structured cells.
  3. Clause segmentation: split on numbered headings (`§ 3`, `3.2`, `Article IV`, `Ziffer 5`) into `clauses` with stable IDs (`doc:page:clause_path`).
  4. Language detection per document (de/en/mixed).
- **FR-1.4** Every downstream answer/extraction must reference `clause_id` + `char_start..char_end`; the UI resolves these to page + highlighted span. **Citations are structural, never quoted-text-matched after the fact.**
- **FR-1.5** Idempotent re-ingestion (content hash); parse failures produce a per-page error report, never a silent partial index.

### 6.2 Indexing & retrieval (FR-2)

- **FR-2.1** Chunking: clause-based (a chunk = a clause, split at ~1,200 tokens with 100-token overlap only when a clause exceeds the limit). Each chunk stores `doc_id, clause_id, page, heading_path, language, text, char offsets`.
- **FR-2.2** Hybrid retrieval over Postgres: `pgvector` (HNSW) embeddings + `tsvector` full-text (german + english configs) + `pg_trgm` for term lookup; fused with Reciprocal Rank Fusion (k=60). No separate vector DB in v1 — one Postgres, defensible choice ("boring infra, fewer moving parts").
- **FR-2.3** Cross-encoder rerank of top-40 fused → top-8 passed to generation. Reranker behind a provider interface (hosted rerank API default; local ONNX cross-encoder as fallback/self-host option).
- **FR-2.4** Embeddings behind a provider interface (config-driven, same pattern as existing model-routing work); multilingual model required (German legal text). Embedding model name + version stored per chunk for safe re-embedding migrations.
- **FR-2.5** Retrieval is scoped to the case (set of docs) by default; the agent may request per-document scoping as a tool parameter.

### 6.3 Structured extraction (FR-3)

Extraction runs per classified document, schema-first: **Zod schema → JSON-schema-constrained LLM extraction → validation → per-field citation requirement.** Every extracted field is `{value, unit?, confidence: high|medium|low, citations: clause_id[], verbatim_anchor: string}`. Fields with no supporting clause are `not_found` — never inferred.

**FR-3.1 Employment offer / contract schema (minimum fields):**
- Compensation: base salary (amount, currency, period), bonus (type: fixed/target/discretionary, amount/%), signing bonus, benefits summary
- Equity: instrument (`vsop` | `esop_options` | `real_shares_geschaeftsanteile` | `rsu` | `none`), grant size (units and/or %), strike/base price, vesting duration, cliff, vesting frequency, acceleration (single/double trigger)
- Leaver terms: good-leaver definition, bad-leaver definition, forfeiture/buyback terms and price basis
- Employment terms: start date, probation period (Probezeit), notice period (Kündigungsfrist) both sides, working hours, overtime treatment, vacation days, remote policy
- Restrictive covenants: non-compete post-termination (duration, scope, **Karenzentschädigung % — statutory check, see FR-4**), non-solicit, IP assignment scope (incl. side-project carve-out present/absent), confidentiality survival
- Governing law, exclusivity/side-work clause, contract type (befristet/unbefristet)

**FR-3.2 Term sheet schema (minimum fields):**
- Round: instrument (equity / SAFE / convertible / Wandeldarlehen), amount, pre/post-money valuation, price per share
- Economics: liquidation preference (multiple, participating/non-participating, cap), anti-dilution (full ratchet / broad / narrow WA), dividends
- ESOP: pool size, created pre- or post-money (dilution attribution)
- Control: board composition, veto/consent matters list, information rights
- Founder terms: founder vesting/reverse vesting (duration, cliff), lock-up, drag-along threshold, tag-along, pro-rata rights
- Process: exclusivity/no-shop period, expenses cap, binding vs non-binding sections, closing conditions

**FR-3.3 VSOP/ESOP agreement schema:** allocation mechanics, exercise/settlement (cash-settled vs shares), exit definition, leaver treatment matrix, board discretion clauses, transfer restrictions, tax remark presence.

**FR-3.4** Extraction is resumable and per-field retryable; malformed JSON triggers one repair pass, then field-level `extraction_failed`.

### 6.4 Benchmarking & red-flag engine (FR-4)

A **deterministic rules engine** (TypeScript, versioned YAML rule files) runs over the extracted schema — deliberately *not* LLM-judged, so results are reproducible and auditable. Each rule: `{id, applies_to, severity: red|amber|info, check(fields), rationale, negotiation_hint, sources[]}`.

**Seed rule set (v1, ~30 rules), examples:**
- `DE-NONCOMP-KARENZ`: post-contractual non-compete without ≥ 50% Karenzentschädigung → **red** (unenforceable/costly under §74 HGB — cite as "statutory reference", link, disclaim)
- `DE-PROBEZEIT-MAX`: Probezeit > 6 months → **red**
- `EQ-VEST-STD`: vesting ≠ 4y/1y-cliff → **amber** with market-standard note
- `EQ-BADLEAVER-BROAD`: bad-leaver includes ordinary employee resignation with full forfeiture → **red**
- `EQ-VSOP-EXITONLY`: VSOP pays out only on narrowly defined exit, board-discretionary → **amber**
- `TS-LIQPREF-GT1X` / `TS-LIQPREF-PARTICIPATING`: >1× or participating preference → **red/amber**
- `TS-FULLRATCHET`: full-ratchet anti-dilution → **red**
- `TS-ESOP-PREMONEY`: ESOP pool created pre-money (founder-dilutive) → **info** with math shown
- `EMP-IP-NOCARVEOUT`: IP assignment with no side-project carve-out → **amber** (persona-aware: red for P1 with OSS/side projects)
- `EMP-NOTICE-ASYM`: notice periods asymmetric against employee → **amber**

Every triggered rule links to the citing clause(s). Rule files carry their own tests (fixture schemas → expected flags).

### 6.5 Agentic Q&A + report generation (FR-5)

- **FR-5.1** Agent runtime: multi-turn tool-use loop (max 12 turns, hard token budget per request) on the primary model provider with automatic fallback provider (existing dual-provider pattern). Tools exposed to the agent (all Zod-validated):
  - `search_clauses(query, doc_id?, top_k)` — hybrid retrieval + rerank
  - `get_clause(clause_id)` / `get_clause_context(clause_id, radius)`
  - `get_extraction(doc_id, field_path?)`
  - `run_benchmark(doc_id)` — rules-engine results
  - `compare_documents(field_path, doc_ids[])` — for multi-offer comparison
  - `math(expression)` — dilution/vesting arithmetic done deterministically, never in-token
- **FR-5.2** Grounding contract (system-prompt enforced + output-validated): every factual sentence in an answer must carry ≥1 citation marker `[[clause_id]]`; a post-generation validator strips/blocks uncited claims and can trigger one corrective re-generation (CRAG-style: critique → re-retrieve → regenerate). Answers with unresolved claims are returned with an explicit "could not verify" section rather than silently dropped.
- **FR-5.3** Report generation ("Full Analysis"): pipeline = classify → extract → benchmark → agent writes narrative report (summary, terms table, red flags ranked by severity, negotiation checklist, open questions) — every line cited. Rendered in UI + exportable as PDF.
- **FR-5.4** Multi-offer comparison mode: side-by-side table across 2–4 offers on the shared schema + agent-written "decision memo".
- **FR-5.5** Self-RAG behavior: the agent decides when to retrieve vs. answer from already-fetched clauses; retrieval decisions and tool calls are logged per request for the trace view.

### 6.6 Delivery surfaces (FR-6)

- **FR-6.1 Web app:** upload → analysis progress (streamed) → report view with click-through citations (PDF viewer with highlighted span) → chat panel → comparison view. React 19 + Vite. Includes a **trace drawer**: per-answer tool calls, retrieved chunks, token/cost — the "show your work" interviewer view.
- **FR-6.2 REST API:** `POST /cases`, `POST /cases/:id/documents`, `GET /documents/:id/extraction`, `POST /cases/:id/analyze`, `POST /cases/:id/ask` (SSE stream), `GET /cases/:id/report`, `GET /healthz`, `GET /metrics`. JWT auth; anonymous demo tenant with rate limits.
- **FR-6.3 MCP server:** the same capabilities as MCP tools (`analyze_offer`, `ask_case`, `get_red_flags`, `compare_offers`) so any agent/Claude client can drive Contractix. Read-only tools by default; upload via pre-signed URL tool. This is the portfolio-differentiator surface — reuse existing MCP server patterns.
- **FR-6.4 Demo corpus:** 6–8 synthetic but realistic documents (2 DE offers, 1 EN offer, 1 VSOP, 2 term sheets, 1 SHA excerpt) pre-loaded; "try without upload" path.

### 6.7 Privacy, security, compliance (FR-7)

These documents contain salary and identity data — treat as sensitive by default.

- **FR-7.1** All processing and storage in EU (Hetzner, Falkenstein/Nuremberg). Model API calls only to providers with EU data-processing terms and no-training-on-inputs guarantees; provider list documented in `PRIVACY.md`.
- **FR-7.2** Optional **anonymization pre-pass** (default ON for demo tenant): NER-based redaction of person names, addresses, emails, phone numbers before any external model call; redaction map stored locally only, re-hydrated in UI. (Deterministic pass, e.g., regex + local NER; documented accuracy limits.)
- **FR-7.3** Retention: user-settable, default 30 days; hard delete (files, chunks, embeddings, logs' payloads) via `DELETE /cases/:id`; deletion job verified nightly. Demo-tenant uploads purged after 24 h.
- **FR-7.4** At-rest encryption for file storage; TLS everywhere (Caddy); per-tenant row-level scoping in every query (single `tenant_id` guard, tested).
- **FR-7.5** Prompt-injection posture: document text is data, never instructions — enforced via strict tool-mediated access (the agent never receives raw full documents in the system prompt), injection canaries in the eval suite, and output validator (FR-5.2) as backstop. No tool in the agent's set can exfiltrate (no fetch/browse tools in v1).
- **FR-7.6** Prominent, non-dismissable-on-first-run disclaimer: informational analysis, not legal or tax advice; statutory references are pointers, not determinations.

### 6.8 Observability & cost control (FR-8)

- Structured logs (pino) with request/trace IDs; Prometheus metrics: latency histograms per stage (parse, retrieve, rerank, generate), token counts, USD/EUR cost per request, rule-engine timings, error rates. Grafana dashboard committed to repo.
- Per-tenant budget guard: hard monthly cost cap, per-request token ceilings, 429 + retry-after on breach.
- Rate-limit backoff and provider circuit-breaking (existing pattern from trading systems).

---

## 7. Evaluation harness (first-class deliverable, not an afterthought)

**Repo:** `eval/` package, runnable locally and in CI (GitHub Actions on every PR touching prompts, retrieval, rules, or schemas).

- **E-1 Golden corpus:** 20 documents (synthetic + public templates: e.g., open-source VSOP templates, published term-sheet templates, standard DE Arbeitsvertrag templates), fully hand-labeled: extraction ground truth per field, expected red flags, 100 Q&A pairs with gold clause citations. Stored in-repo (all synthetic/public — no real user data ever enters the eval set).
- **E-2 Metrics:**
  - Extraction: per-field exact/normalized accuracy, macro-averaged; `not_found` precision (does it hallucinate absent terms?)
  - Retrieval: recall@8 and MRR of gold clauses for the 100 Q&A pairs
  - Generation: faithfulness + citation-correctness via LLM-as-judge (deterministic, temp 0, pinned judge model + prompt version) with a 10% human-audited calibration sample; answer relevance
  - Rules engine: 100% fixture pass (deterministic)
  - Injection suite: 15 adversarial documents (instructions embedded in clauses); pass = zero instruction-following, zero uncited claims
- **E-3 Regression contract:** CI fails if extraction accuracy drops > 2 pts, recall@8 drops > 3 pts, faithfulness < 0.93, or any injection case fails. Cost and latency per eval run tracked over time (committed JSONL history → chart in README).
- **E-4 Judge governance:** judge prompts versioned; judge changes require re-baselining, flagged in PR template.

---

## 8. Architecture & stack (July 2026)

**Principles:** boring, self-hosted core; provider-abstracted AI edges; one database; everything typed end-to-end.

```
[React 19 + Vite SPA]
        │ HTTPS (Caddy)
[API: Node 22 + Hono + Zod (+ zod-openapi)] ── [MCP server (same service, /mcp)]
        │
        ├── Ingestion worker (BullMQ on Redis): parse → OCR → segment → embed
        ├── Agent service: tool loop, provider router (primary + fallback), output validator
        ├── Rules engine (pure TS + YAML rules)
        │
[PostgreSQL 17: relational + pgvector HNSW + tsvector + pg_trgm]
[Object storage: local disk vol (v1) → S3-compatible later]
[Prometheus + Grafana + uptime-kuma]   [pino → Loki (optional)]
```

**Pinned choices & rationale (interview-defensible):**

| Concern | Choice | Why / alternative |
|---|---|---|
| Language/runtime | TypeScript, Node 22 | Primary stack; Zod as single source of truth for API, tools, extraction schemas |
| HTTP | Hono | Lightweight, already used; OpenAPI via zod-openapi |
| Parsing | Native text via `mupdf`/pdf.js text+coords; OCR path via a doc-parsing service abstraction (hosted OCR API default; self-host `docling`/`marker` in a Python sidecar as the sovereign option) | Verify current best OCR option at build start — this niche moves monthly; the abstraction is the point |
| DB / vectors | Postgres 17 + pgvector | Deep existing PG expertise; RRF hybrid in SQL; one backup story. Qdrant only if corpus scale demands (it won't in v1) |
| Queue | BullMQ + Redis | Already operated; parse jobs are minutes-long |
| Models | Provider-router: frontier model for agent/report, small model for classify/extract-repair; embeddings + reranker behind interfaces | Same dual-provider pattern as prediction-market-bot; pin exact model IDs in `models.yaml`, re-verify at build start |
| Agent loop | Hand-rolled tool loop (existing pattern) — *not* LangChain/LlamaIndex | Full control over grounding contract, budgets, tracing; frameworks add opacity you'd have to explain away in interviews |
| Frontend | React 19 + Vite + Tailwind v4; `react-pdf` viewer with span highlighting | Existing stack |
| Deploy | Docker Compose on Hetzner VPS (EU), Caddy, systemd, Borg backups; GH Actions CI/CD with smoke test + dry-run deploy | Existing ops playbook |

**Data model (core tables):** `tenants`, `users`, `cases`, `documents (id, case_id, sha256, type, language, status, page_count)`, `clauses (id, document_id, clause_path, page, char_start, char_end, heading, text)`, `chunks (clause_id, embedding vector, tsv, model_ver)`, `extractions (document_id, schema_ver, field_path, value_json, confidence, status)`, `citations (extraction_id|answer_id, clause_id, char_start, char_end)`, `flags (document_id, rule_id, severity, clause_ids[])`, `qa_turns (case_id, question, answer, trace_json, tokens, cost_eur, latency_ms)`, `audit_log`.

---

## 9. UX flows (v1)

1. **Analyze:** landing → upload or "use demo docs" → streamed progress (parse → extract → benchmark → report) → report page: summary card, red-flag list (severity-sorted, each expands to clause with highlighted PDF span), terms table, negotiation checklist, "ask a question" panel.
2. **Ask:** chat with streamed answer; citations render as chips → click opens PDF at highlighted span; trace drawer per answer.
3. **Compare:** select 2–4 analyzed offers → schema-aligned comparison table (deltas highlighted) → agent decision memo.
4. **Manage:** case list, retention setting, delete case (with confirmation of hard delete).

Empty/error states specified: parse failure per page, low-confidence extraction badge, "not found in document" as a first-class value.

---

## 10. Milestones (4 weeks core + 1 hardening, solo, at demonstrated velocity)

**Phase 0 (2 days):** repo scaffold (pnpm monorepo: `api`, `web`, `eval`, `rules`, `mcp`), CI, Compose stack, model/provider config, pin model+OCR choices after a fresh landscape check.

**Phase 1 — Ingestion & retrieval (days 3–8):** parsing pipeline for native PDFs + DOCX, clause segmentation, chunking, embeddings, hybrid retrieval + RRF + rerank, `search_clauses`/`get_clause` tools, retrieval eval (recall@8) green on first 30 gold Q&A pairs. *Exit: cited clause search over demo corpus.*

**Phase 2 — Extraction & rules (days 9–14):** employment + term-sheet schemas, constrained extraction with per-field citations, rules engine + 30 seed rules with fixtures, extraction eval green. *Exit: red-flag JSON for all demo docs.*

**Phase 3 — Agent, report, UI (days 15–21):** tool loop + grounding validator + CRAG retry, full-analysis report pipeline, web app (report view, PDF highlight, chat, trace drawer), SSE streaming. *Exit: end-to-end live on staging.*

**Phase 4 — Evals, MCP, hardening (days 22–28):** full golden corpus + injection suite in CI, MCP server, anonymization pass, comparison mode, metrics dashboard, cost guards, OCR path, retention/deletion jobs, PDF export. *Exit: public launch.*

**Phase 5 (week 5, hardening/marketing):** README with eval numbers + architecture diagram, demo video, write-up post, submit to relevant directories; instrument real-usage KPIs for CV bullets.

**v1.1 roadmap (explicitly deferred):** SHA deep analysis, negotiation email drafting, EN-jurisdiction statutory rules (UK/US), second vertical on the same engine (EU-AI-Act gap analyzer — proves engine generality), GraphRAG over cross-references, team accounts.

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Legal-advice liability optics | Persistent disclaimer, "statutory reference" framing, no prescriptive "sign/don't sign" outputs, rationale + sources per rule |
| Hallucinated terms (worst failure mode) | Structural citations only, `not_found` as first-class, uncited-claim blocker, faithfulness gate in CI |
| German legal-domain errors in rules | Rules cite public statutory sources; mark rule set version + "verified against sources as of <date>"; invite corrections via repo issues |
| Scanned/low-quality PDFs tank accuracy | Coverage detection → OCR path; per-page error surfacing; golden set includes 3 scanned docs |
| Prompt injection via uploaded docs | FR-7.5 posture + CI injection suite as regression gate |
| Model/OCR landscape shifts mid-build | Everything behind provider interfaces; `models.yaml` single point of change; eval harness makes swaps safe |
| Scope creep (the real risk) | Phases have exit criteria; anything not in FR list goes to v1.1 |

---

## 12. Open questions (resolve in Phase 0)

1. Exact model IDs for agent/extract/embed/rerank/judge — fresh benchmark check at build start, then pin.
2. OCR: hosted API vs. Python sidecar self-host for v1 (decide on cost + DE-language table accuracy on 3 sample scans).
3. Name/domain and whether the repo is fully public or public-write-up + private core.
4. Anonymization default for authenticated (non-demo) users: opt-in vs opt-out.
5. Whether to seed 5 real beta users (Berlin founder network) in week 5 to get usage numbers for the CV.
