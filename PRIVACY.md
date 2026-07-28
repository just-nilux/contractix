# Privacy & Data Handling

> Status: Phase 3 draft. This document tracks FR-7 commitments as they are implemented; it is
> updated in the same PR as the feature it describes.

Contractix processes documents that contain salary and identity data. They are treated as
sensitive by default.

## Commitments (PRD FR-7)

| Commitment                                                                             | Status                                                                       |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| All processing & storage in the EU (Hetzner, Falkenstein/Nuremberg)                    | planned — deploy lands in Phase 3/4                                          |
| Model calls only to providers with EU data-processing terms & no-training guarantees   | in effect — provider list below                                              |
| Anonymization pre-pass (NER redaction) before external model calls                     | Phase 4                                                                      |
| Retention: user-settable, default 30 days; hard delete incl. embeddings & log payloads | in effect for anonymous sessions — 24 h purge job + `DELETE /cases/:id`      |
| At-rest encryption for file storage; TLS everywhere                                    | deploy-time (Phase 3/4)                                                      |
| Document text is data, never instructions (prompt-injection posture)                   | in effect — see the section below; injection suite (regression gate) Phase 4 |

## External model providers

| Role       | Provider                  | Model                                                                      | Data notes                                                                                                                                                                                             |
| ---------- | ------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Embeddings | Jina AI GmbH (Berlin, DE) | `jina-embeddings-v4` @ 1024 dim                                            | chunk/query text sent for vectorization; verify DPA + no-training terms at account setup                                                                                                               |
| Reranking  | Jina AI GmbH (Berlin, DE) | `jina-reranker-v3`                                                         | query + candidate chunk texts sent for scoring                                                                                                                                                         |
| LLM        | Anthropic                 | `claude-haiku-4-5` classification/extraction · `claude-sonnet-5` Q&A agent | document clause text sent for extraction; for Q&A, **the user's question plus the clauses retrieved to answer it**; EU data-processing terms to be confirmed & documented before first production call |

Keyless mode (no API keys configured) performs **zero** external calls: deterministic local
fake embeddings, a passthrough reranker, and a scripted fake agent loop. This is the default
for tests and CI.

## What Q&A stores

Answering a question writes a `qa_turns` row holding the **question as typed**, the answer, and
a trace (tool calls, retrieved clause ids, tokens, cost, latency). Questions are free text and
can contain personal context the documents do not, so they are treated as sensitive on the same
footing as document text: tenant-scoped on read, and cascade-deleted with the case.

Turns are covered by the same deletions as everything else: they cascade when a case is deleted,
and they go with the tenant when the 24-hour purge sweeps an anonymous session. A per-case
`retention_days` for signed-in accounts is Phase 4, along with accounts themselves.

## Prompt-injection posture (FR-7.5)

The agent never receives a raw document in its system prompt. Clause text reaches it only as
tool output, the system prompt states that such text is data and never an instruction, and no
tool can fetch a URL or otherwise exfiltrate — the tool surface is search, clause lookup, stored
extractions, stored red flags, and a hand-rolled arithmetic evaluator with no code path to
execution.

The backstop is the grounding contract (ADR-0010): a citation resolves only if it names a clause
a tool actually returned in that request, and tenant/case scope comes from the HTTP request
rather than from model output — so a document that talks the model into citing another case's
clause still resolves to nothing. What is **not** yet in place is the adversarial regression
gate (PRD E-2: 15 documents with embedded instructions); that is Phase 4, and until it exists
this posture is enforced by construction but not measured.

## What a session is, and how long it lasts

There are no accounts. Visiting the app and creating a case (or adopting the demo corpus)
mints an **anonymous session**: a signed, `HttpOnly` cookie whose only content is an opaque
tenant id. No email, no password, no profile.

- **Everything you upload is scoped to that session.** Every query carries a single
  `tenant_id` equality guard, so another session cannot read your documents — the API
  returns 404, not 403, for a case that is not yours.
- **The session and everything under it are deleted 24 hours after it is created** — files,
  clauses, embeddings, extractions, red flags, and Q&A turns. An hourly job performs the
  deletion and verifies that nothing was left behind.
- **You can delete earlier.** `DELETE /cases/:id` removes the case and everything derived
  from it immediately, including the stored file.
- Deleting the data is also what ends the session: the cookie stops working the moment its
  tenant is gone, so there is no separate token to revoke.

## Demo corpus

All documents in `corpus/` are synthetic, authored for this repository. No real person,
company, or agreement is represented. The eval set never contains user data (PRD E-1).

Choosing "try the demo" **copies** the corpus into your own session rather than showing you
a shared one, so you can ask questions of it, re-run the analysis, upload your own contract
alongside it, and delete the lot. That copy is purged on the same 24-hour clock as anything
else you upload.
