# Contractix

**Term-sheet & employment-offer diligence agent** — upload an employment offer, VSOP/ESOP agreement, or startup term sheet (German or English) and get every material term extracted, benchmarked against market standards, and flagged — with every claim citing the exact page and clause.

> ⚠️ Contractix provides informational analysis, **not legal or tax advice**. Statutory references are pointers, not determinations.

## Status

🚧 **Phase 0/1 — ingestion & retrieval under construction.** See [PRD.md](PRD.md) for the full specification and roadmap.

## Documentation

- [PRD.md](PRD.md) — product requirements (authoritative spec)
- [docs/adr/](docs/adr/) — architecture decision records
- [PRIVACY.md](PRIVACY.md) — data handling & model-provider posture

## License

MIT for this codebase — see [LICENSE](LICENSE).

Note: the PDF parsing path currently uses [`mupdf`](https://www.npmjs.com/package/mupdf) (AGPL-3.0). Parsing sits behind a `Parser` interface precisely so this dependency is swappable; the licensing reasoning is documented in the ADRs.
