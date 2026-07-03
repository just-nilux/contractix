# ADR-0001: pnpm monorepo with source-exporting internal packages

- **Status:** accepted
- **Date:** 2026-07-03

## Context

The PRD pins a pnpm monorepo (`api`, `web`, `eval`, `rules`, `mcp`). Cross-cutting types and
schemas (canonical blocks, clause refs, search contracts, models.yaml loader) need one home, and
the eval runner must import the API's search service directly so the eval measures the exact
production code path. TypeScript offers two wiring models: composite project references with
declaration emit, or "internal packages" that export TS source consumed through workspace
symlinks.

## Decision

- A sixth package, `@contractix/shared`, holds cross-cutting Zod schemas and helpers.
- Internal packages export **TypeScript source** (`"exports": { ".": { "types": "./src/index.ts",
"default": "./src/index.ts" } }`); consumers declare `workspace:*` dependencies. tsx, Vitest,
  and Vite execute TS through the symlink; each package runs its own `tsc --noEmit`.
- **No composite project references.** At six packages with essentially one dependency edge
  (everything → shared, eval → api), references buy incremental build orchestration we don't
  need and cost declaration-emit plumbing plus `tsc -b` babysitting.
- Production builds bundle workspace deps: the API's tsup config sets
  `noExternal: [/^@contractix\//]` so deploy artifacts never rely on workspace symlinks.
- Version consistency is enforced with a **pnpm catalog** (exact pins) for peer-sensitive
  packages: typescript, zod, vitest, drizzle-orm, eslint tooling.

## Consequences

- Instant cross-package type feedback, zero build steps in dev; `pnpm -r typecheck` is the
  whole-graph check.
- Repo-wide typecheck is O(all files) per package that imports shared. Re-evaluate project
  references if `pnpm typecheck` exceeds ~30 s.
- Any future _published_ package must add a real build; internal-source exports are only valid
  for private workspace consumers.
