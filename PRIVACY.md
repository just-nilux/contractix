# Privacy & Data Handling

> Status: Phase 2 draft. This document tracks FR-7 commitments as they are implemented; it is
> updated in the same PR as the feature it describes.

Contractix processes documents that contain salary and identity data. They are treated as
sensitive by default.

## Commitments (PRD FR-7)

| Commitment                                                                             | Status                                                                                                                      |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| All processing & storage in the EU (Hetzner, Falkenstein/Nuremberg)                    | planned — deploy lands in Phase 3/4                                                                                         |
| Model calls only to providers with EU data-processing terms & no-training guarantees   | in effect — provider list below                                                                                             |
| Anonymization pre-pass (NER redaction) before external model calls                     | Phase 4                                                                                                                     |
| Retention: user-settable, default 30 days; hard delete incl. embeddings & log payloads | schema carries `retention_days`; deletion job lands in Phase 4                                                              |
| At-rest encryption for file storage; TLS everywhere                                    | deploy-time (Phase 3/4)                                                                                                     |
| Document text is data, never instructions (prompt-injection posture)                   | extraction sends clauses as delimited data; document text cannot invoke tools, and only the forced schema-output tool is available (Phase 2); agent-loop enforcement Phase 3, injection suite Phase 4 |

## External model providers

| Role           | Provider                  | Model                                                             | Data notes                                                                                                                   |
| -------------- | ------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Embeddings     | Jina AI GmbH (Berlin, DE) | `jina-embeddings-v4` @ 1024 dim                                   | chunk/query text sent for vectorization; verify DPA + no-training terms at account setup                                     |
| Reranking      | Jina AI GmbH (Berlin, DE) | `jina-reranker-v3`                                                | query + candidate chunk texts sent for scoring                                                                               |
| LLM (Phase 2+) | Anthropic                 | `claude-haiku-4-5` extraction · `claude-sonnet-5` agent (Phase 3) | document clause text sent for extraction; EU data-processing terms to be confirmed & documented before first production call |

Keyless mode (no API keys configured) performs **zero** external calls: deterministic local
fake embeddings and a passthrough reranker. This is the default for tests and CI.

## Demo corpus

All documents in `corpus/` are synthetic, authored for this repository. No real person,
company, or agreement is represented. The eval set never contains user data (PRD E-1).
