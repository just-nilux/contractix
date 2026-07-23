# Contractix — agent notes

Read PRD.md first — it is the authoritative spec and is marked **do not edit**.

## Commands

```bash
pnpm compose:up            # postgres :5433 + redis :6380 (host services own the default ports)
pnpm db:migrate            # drizzle migrations (packages/api/drizzle)
pnpm dev                   # api :3000 + web (vite)
pnpm lint && pnpm typecheck
pnpm test                  # unit (keyless, no services)
pnpm test:int              # integration (needs compose stack; forks pool for mupdf WASM)
pnpm seed:demo             # ingest the demo corpus into postgres
pnpm demo:extract          # extract + benchmark demo docs → data/demo-red-flags.json (keyless ⇒ no flags; ANTHROPIC_API_KEY for real)
pnpm eval:retrieval        # recall@8 / MRR over gold Q&A
pnpm eval:extraction       # extraction field accuracy / not_found precision / citation recall (real: ANTHROPIC_API_KEY + EVAL_ALLOW_LIVE_PROVIDERS)
```

## Conventions

- Conventional commits; every commit leaves lint/typecheck/test green.
- Architectural decisions get an ADR in docs/adr/ (see template.md). Read ADR-0005 before
  touching anything in the parse → segment → chunk path: **offsets are frozen at parse time;
  downstream code may only slice canonical text, never transform it.**
- Read ADR-0006 before touching extraction or rules: extraction is schema-first (Zod →
  forced-tool JSON, one repair pass), citations resolve **structurally** (slice the frozen
  clause text, never quote-match), and the rules engine is deterministic — versioned
  `rules.yaml` copy + pure TS checks joined by id, never LLM-judged.
- `models.yaml` is the only place model IDs/dimensions live; keyless mode (fake providers) must
  keep working — never make a test depend on a real API key.
- Eval baselines (`packages/eval/baselines/`) change only in deliberate `chore(eval)` commits
  with the PR-template section filled in.
- `tenant_id` guard in every chunk/clause/extraction/flag query — denormalized precisely so no
  join is needed.
