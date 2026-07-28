# ADR-0012: Web data layer, streaming conventions, and client-side citation highlighting

- **Status:** accepted
- **Date:** 2026-07-28

## Context

Phases 0–2 and the Phase-3 backend were complete: 24 routes, three streams, anonymous sessions,
and a browser-safe `@contractix/shared/schemas` barrel built expressly so a client could parse the
same objects the API publishes. `packages/web` was still a Vite scaffold.

The web app has to make good on the product's central claim — _every line carries a citation you
can click through to the exact clause_ — which is not a rendering problem so much as a question
about what the client is allowed to compute. Three constraints shaped everything:

- **ADR-0005**: character offsets are frozen at parse time, and downstream code may only _slice_
  canonical text. Any resolution the client performs has to respect that.
- **ADR-0006/0007**: citations resolve structurally. Quote-matching is forbidden, and its failure
  mode — silently highlighting a different occurrence of the same phrase — is exactly what
  structural citations exist to eliminate.
- **ADR-0011**: the tenant comes only from the session cookie, and an anonymous session lasts 24 h.

Two further facts constrain the client specifically. The block geometry sidecar records rectangles
at _block_ granularity, not per character. And the API's three streams are not uniform: one is a
GET, two are POSTs with a JSON body, which `EventSource` cannot issue.

## Decision

**1. The client parses every response with the API's own Zod objects.** No generated client sits
between them. Anything the web must parse moves into `@contractix/shared/schemas` rather than being
retyped — this commit moved the clause, search, narrative, upload and analyze-accepted shapes, plus
the `DISCLAIMER` string that FR-7.6 requires the first-run modal and every report to agree on. A
mismatch surfaces as a `ResponseShapeError` naming the offending field, which is the only thing
that makes client-side parsing worth its cost.

The SSE payloads become Zod too, at two levels: `*EventSchema` is what a writer may emit,
`*StreamEventSchema` is what a client may see, because the routes wrap the writer's events with a
terminal `done`/`error`. `AgentEvent` and `NarrativeEvent` are `z.infer`s of these, so a variant
cannot be emitted without the web being able to read it.

**2. `EventSource` for the GET stream, `fetch` + a hand-rolled framer for the POSTs.** Progress is
a GET whose every event is a full snapshot of persisted state, which makes the browser's automatic
reconnection _correct_ rather than merely tolerable. `ask` and `narrative` are POSTs, so they get
`postSse`, which routes a non-2xx through the same status mapper as every other request — a 429 on
`ask` is ordinary at five per minute and must surface as a countdown, not a dead stream.

Because the wire is not uniform — `token`/`retry`/`restart` carry their own `type` while
`done`/`error` carry bare bodies — the client injects the SSE event name as the discriminator
before parsing, which lets one union cover every frame. Unrecognised frames parse to null and are
ignored rather than killing a working stream.

**3. Completion is derived from phases, never from `done` alone.** The API sets `done` only once
every document is terminal _and_ analysis has been asked for, so a merely-ingested case — exactly
what `POST /demo/adopt` produces — never emits it and runs to the five-minute `timeout`.
`deriveCaseStage` reads the raw `status`/`analysisStatus` pair rather than `phase`, because `phase`
collapses "not yet parsed" and "parsed, awaiting analysis" into the same `queued`, and that
difference is what decides whether analysis should start. `derivePhase` itself moved into shared so
the client's polling path cannot disagree with the stream's precomputed value.

**4. Citation highlighting resolves on the client, at block granularity, with partial coverage
labelled approximate.** `resolveHighlights` intersects a citation's frozen character span with the
sidecar's block ranges. Whole-block coverage — which is _every_ flag citation, since clauses are
segmented on block boundaries — yields exact rectangles. Partial coverage is interpolated from the
block's own geometry and marked `exact: false`, rendered with a dashed edge, and always accompanied
by the clause-text panel, which is a plain `.slice()` of frozen text at frozen offsets and
therefore pixel-exact by construction.

The function never touches text. `verbatimAnchor` is carried for display and never used to locate
anything. A `granularity: "block"` option disables the interpolation entirely in one place.

Point-to-pixel conversion derives its scale from what was actually rendered rather than from the
viewer's `scale` prop, and `scaleDisagreement` checks that mupdf's page box and pdf.js's viewport
describe the same rectangle — turning "rotation needs no matrix here" from an assumption into a
checked one, with the clause-text panel as the fallback when it fails.

**5. Session failures throw to the route error boundary.** Queries are configured to throw
`SessionError` rather than return it, so ADR-0011's no-session/expired distinction is implemented
once. Screens where a 401 is the _expected_ answer — the landing page asking for cases before a
visitor has a session — opt out explicitly.

## Consequences

Adding a screen means adding an endpoint function and a schema import; there is no codegen step and
no client artefact to regenerate. The cost is that a server-side schema change breaks the web at
runtime rather than at build time — which the `ResponseShapeError` path is designed to make loud.

Sub-block highlights are approximate, and the UI says so. This is the deliberate trade: a visibly
coarse highlight beside an exact clause-text panel is honest, and the alternative was worse.

**Rejected:**

- _Quote-matching the rendered text layer for `verbatimAnchor`._ Would give pixel-exact sub-block
  rectangles, and is exactly what ADR-0006/0007 forbid. Its failure mode is confidently
  highlighting the wrong occurrence, which is worse than being coarse.
- _A server-side `GET /citations/:id/rects`._ A round trip per citation, and the sidecar is already
  the smallest form of the data. `routes/files.ts` states client-side resolution as the design
  intent.
- _Per-line geometry in the sidecar — the real fix, deferred._ `mupdf-parser.ts` already holds
  `rb.lines` with per-line bboxes and text. Adding an optional `lines?: […]` to `blockSchema` and
  `documentLayoutSchema` would make every highlight exact and delete the estimator; old sidecars
  simply lack the field and fall back. Cost: a parser change plus a `pnpm seed:demo` re-run, since
  sidecars are keyed by sha256. **Trigger to revisit:** the first approximate rectangle that is
  visibly wrong on the demo corpus, or the first document whose blocks are paragraphs rather than
  single lines.

**Deferred to branch B and later:** the chat panel over `POST /cases/:id/ask`, the trace drawer
(which needs `askResponseSchema.trace` to stop being `z.unknown()`), and comparison mode. The
staging deploy — Dockerfiles, a Caddyfile with `flush_interval -1`, and a deploy workflow — is what
remains of PRD §10's Phase-3 exit criterion. `flush_interval -1` is not optional: Hono sets
`text/event-stream` but not `X-Accel-Buffering`, and a buffered progress stream is
indistinguishable from a hung app. The Vite dev proxy was measured and does not buffer.
