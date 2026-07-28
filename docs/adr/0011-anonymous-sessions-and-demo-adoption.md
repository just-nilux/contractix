# ADR-0011: Anonymous sessions, tenant scope, and demo adoption

- **Status:** accepted
- **Date:** 2026-07-27
- **Builds on:** ADR-0005 (frozen offsets), ADR-0010 (agent loop / scope is never
  a tool argument)

## Context

Every route handler resolved its tenant by calling `ensureDevTenant(db)` — a
select-or-insert of a tenant literally named `"dev"`, once per request. FR-7.4's
"single `tenant_id` guard in every query, tested" was therefore real in shape and
vacuous in effect: one tenant, every request, no request-derived identity
anywhere. Five analysis services went further and took `tenantId?: string`, so a
caller who forgot the tenant silently got the dev one.

The web app (FR-6.1) cannot be built on that, and neither can the public demo.
PRD §4 wants "one-click try without signup" and FR-6.4 wants a preloaded corpus,
but `pnpm seed:demo` writes under a tenant named `"demo"` that no request ever
resolved to — the seeded corpus was invisible to the API.

FR-6.2 specifies "JWT auth; anonymous demo tenant with rate limits". PRD §5 makes
accounts, orgs and SSO explicit non-goals for v1.

## Decision

**1. One source of tenant scope: a signed session cookie.** Never a path param,
never a client-chosen header, never a body field. This is ADR-0010's rule for the
agent's tool surface — scope comes from the request, never from something the
model or client can name — held one layer up. `sessionMiddleware` reads it on
every request; `requireTenant` demands one; `ensureTenant` mints one.

**2. A JWT in an `HttpOnly` cookie, signed with `hono/jwt` HS256.** Not a Hono
signed cookie, for two reasons. Its `exp` is the same 24 h contract the FR-7.3
retention job enforces, so a session's lifetime is one number with two enforcers
rather than two numbers that can drift. And the same token rides
`Authorization: Bearer` for the Phase-4 MCP server (FR-6.3), so there is no
second auth mechanism to build later — the bearer path is five lines and exists
today. `jose` is not needed.

The token cannot be revoked mid-life. **The tenant row is the authority:** a live
token whose tenant has been purged reads as an expired session, so deleting data
_is_ revocation, and that is exactly what the retention sweep does. Real accounts
would need a session table; anonymous demo sessions do not.

**3. Only two routes mint.** `POST /cases` and `POST /demo/adopt`. Everything
else 401s, distinguishing `no_session` (a first visit — the web shows the landing
page) from `session_expired` (the 24 h demo ended and the documents are gone,
which is worth saying out loud). Restricting minting means a crawler hitting
`/healthz` cannot fill the tenants table.

**4. `ensureDevTenant` is deleted, not deprecated.** Two live tenant sources at
once is strictly worse than one large diff, and deleting the file is the
regression test: nothing can fall back to a path that no longer exists. The five
services' optional `tenantId` became required, so the compiler now catches the
class of bug that optional was hiding.

**5. The demo corpus is cloned into the visitor's own tenant, not shared
read-only.** A read-only demo tenant is cheaper on disk and much worse
everywhere else: it turns the single `tenant_id` equality guard into set
membership at ~30 query sites, forever, and the one site somebody forgets to
widen is a cross-tenant leak. Cloning keeps FR-7.4's invariant literally true.

It also buys what a read-only corpus cannot: the visitor can ask questions of the
documents, re-run analysis, upload their own contract beside them, and delete the
case. That is what "try without signup" has to mean to be worth building. The
24 h purge bounds the duplication.

The copy is one transaction of `INSERT ... SELECT` per table, keyed through a
temp id map, so the 1024-dimension embeddings never leave Postgres. Blobs are not
copied at all — the store is content-addressed, so the clone reuses the same
`sha256` and its geometry sidecar. One deliberate cross-tenant read survives:
`GET /demo` serves the template's **metadata only** — filenames, types,
languages, page counts — and nothing derived from document contents.

`POST /demo/adopt`'s idempotency is a partial unique index
(`cases_one_demo_per_tenant`), not a read-then-write check, because two
concurrent requests from a double-clicked button would both pass the check. The
route turns the resulting conflict back into the same 200 a sequential second
call gets.

**6. Rate limits are Redis-backed and fail open.** A per-process Map resets on
every deploy — the wrong failure mode for an abuse-facing public demo — and stops
working the moment there are two API processes behind Caddy. One Lua script does
`INCR` + `PEXPIRE` atomically (two commands leak immortal keys when the process
dies between them) and returns the PTTL, which is what makes `Retry-After` exact.

**Fail-open is a decision, not an oversight.** A limiter that takes the demo down
when its bookkeeping store hiccups has done more damage than the abuse it
prevents; the Phase-4 budget cap is the second line for cost, which is the thing
actually worth protecting. Routes that mint tenants are scoped per-IP — a
per-tenant limit there limits nothing, since every request arrives as a fresh
tenant. Limits live in `AppDeps`, not env, so tests exercise real 429s without an
`if (TEST)` branch in production code.

**7. `x-forwarded-for` is trusted because Caddy sets it.** Exposing :3000
directly would make every IP-scoped limit forgeable. This is a deployment
constraint, recorded because it is invisible from the code that depends on it.

## Consequences

Wiring real accounts later means replacing the resolver, not the queries — every
`tenant_id` guard is already threaded through and now genuinely exercised, with
integration tests asserting that two sessions 404 each other's cases.

Integration tests authenticate the way a browser does: `POST /cases` mints, the
`Set-Cookie` comes back, later calls present it. There is deliberately no
`X-Test-Tenant` bypass — a test-only auth bypass is an auth bypass, and it would
ship.

Cloning costs a duplicated corpus per visitor (~2 MB of pgvector rows). The purge
bounds it. If demo traffic ever makes that material, the answer is a shorter TTL,
not a shared tenant.

**For the Phase-4 anonymization pre-pass (FR-7.2):** every string that reaches an
external model passes through exactly three chokepoints — `asToolClause` in
`agent/tools/index.ts`, the document rendering in `extraction-service.ts`, and
the report writer's user message. Redaction must happen **at call time, never at
parse time**: redacting before offsets are frozen would violate ADR-0005 and
invalidate every stored citation. Anyone implementing this will reach for the
parser first; that is the wrong file.

Rate-limit keys are namespaced `rl:{scope}:{id}:{bucket}:{window}` so the Phase-4
per-tenant monthly budget guard (`budget:{tenantId}:{yyyy-mm}`) lands in the same
module rather than growing a parallel one.
