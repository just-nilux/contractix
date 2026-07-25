# Architecture

The system diagram and component rationale live in [PRD.md §8](../PRD.md); decisions that
shaped the implementation are recorded as ADRs:

- [ADR-0001](adr/0001-pnpm-monorepo-and-internal-packages.md) — monorepo & internal packages
- [ADR-0002](adr/0002-single-postgres-for-relational-vector-fts.md) — one Postgres: vector + FTS + trigram hybrid retrieval
- [ADR-0003](adr/0003-mupdf-agpl-behind-parser-interface.md) — parser isolation & licensing posture
- [ADR-0004](adr/0004-provider-interfaces-and-models-yaml.md) — provider interfaces & model pinning
- [ADR-0005](adr/0005-clause-identity-and-frozen-offsets.md) — clause identity & frozen offsets (citation integrity)
- [ADR-0006](adr/0006-constrained-extraction-and-deterministic-rules.md) — constrained extraction & deterministic rules engine
- [ADR-0007](adr/0007-anchor-first-citation-resolution.md) — anchor-first citation resolution (refines ADR-0006)

A rendered architecture diagram is a planned addition to the README.
