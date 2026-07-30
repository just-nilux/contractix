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
pnpm eval:rules            # red-flag precision/recall/F1 vs gold flags (deterministic, keyless; --gate / --write-baseline)
pnpm test:e2e              # playwright smoke over the running stack (starts `pnpm dev` itself; needs a seeded demo corpus)
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
- Read ADR-0010 before touching the agent loop, its tools, or the grounding validator: a
  `[[clause_id]]` marker resolves **only** if a tool surfaced that clause in the same request
  (the citable set is built from tool output, never model output), tenant/case scope comes from
  the HTTP request and is never a tool argument, and a validation failure buys exactly one
  corrective regeneration before the claim is surfaced under `couldNotVerify`.
- `models.yaml` is the only place model IDs/dimensions live — including per-role `params`, since
  request-shape capabilities are model facts (`claude-sonnet-5` 400s on a non-default
  `temperature`; Haiku 4.5 needs `temperature: 0` to keep extraction deterministic). Keyless mode
  (fake providers, incl. a scripted agent loop) must keep working — never make a test depend on a
  real API key.
- Eval baselines (`packages/eval/baselines/`) change only in deliberate `chore(eval)` commits
  with the PR-template section filled in.
- Read ADR-0011 before touching auth, tenancy, or the demo path: the tenant comes **only** from
  the signed session cookie (`tenantOf(c)`), never a path param, header, or body field; the
  demo corpus is **cloned** into a visitor's own tenant rather than shared read-only, so the
  guard below stays a single equality check; and rate limiting fails **open** on a Redis error.
- Read ADR-0012 before touching the web data layer, its streams, or citation highlighting: the
  client `.parse()`s responses with the **API's own Zod objects** from `@contractix/shared/schemas`
  (anything the web must parse belongs there, never retyped); `EventSource` serves the GET stream
  while the two POST streams use `fetch` + the hand-rolled framer; completion is derived from
  phases, **never from `done` alone** (an ingested-but-unanalyzed case never emits it); and
  highlight rectangles are exact only where a citation covers whole blocks — partial coverage is
  interpolated, labelled `exact: false`, and always shown beside the exact clause-text panel.
  `verbatimAnchor` is display-only and must never be used to locate anything.
- Read ADR-0013 before touching the trace, the chat panel, or `qa_turns.trace_json`: the trace is
  a **published schema** (`schemas/trace.ts`), so adding a field to it is an API change, not a
  debug tweak; `citableClauseIds` is serialized ids on **both** paths; a step records _which_
  clauses it surfaced, never their text; `narrativeSchema.trace` is nullable because that one is
  replayed from storage, and `latestNarrative` parses rather than casts it. On the client, `ask`
  has **no `restart`** — the corrective turn is not streamed, so `retry` keeps the draft and
  `done` replaces it.
- `tenant_id` guard in every chunk/clause/extraction/flag/citation/qa_turn query — denormalized
  precisely so no join is needed. Never widen it to set membership.
