# ADR-0013: The agent trace as a published contract

- **Status:** accepted
- **Date:** 2026-07-30
- **Builds on:** ADR-0010 (agent loop, grounding contract, citable set),
  ADR-0012 (web data layer, streams, client-side highlighting)

## Context

ADR-0012 shipped the report, the citation click-through and the narrative panel, and named what
it deferred: _"the chat panel over `POST /cases/:id/ask`, the trace drawer (which needs
`askResponseSchema.trace` to stop being `z.unknown()`), and comparison mode."_ This closes the
first two.

The chat panel is not a nice-to-have appended to the report. FR-1.2 says a document classified
`other` is "analyzed generically (**Q&A only**, no schema extraction)" — so for every
unclassifiable upload, and for the entire keyless deployment, Q&A is the only analysis surface
there is.

The trace drawer ran into the fact that the payload whose whole purpose is "show your work" was
the one payload with no contract at all. `askResponseSchema.trace` and `narrativeSchema.trace`
were `z.unknown()`; the real shape lived as TypeScript interfaces next to the loops that built it,
where nothing stopped the emitter drifting from what the API published. Moving it into shared was
forced by CLAUDE.md's rule — anything the web must parse belongs in `@contractix/shared/schemas`,
never retyped — and doing so surfaced two things that had been true and invisible.

## Decision

**1. The trace is part of the API.** `agentTraceSchema` and `narrativeTraceSchema` live in
`schemas/trace.ts`; `agent-service.ts` and `report-writer.ts` derive their types from them, the
same arrangement `AgentEvent` already had. Drift is now a compile error rather than a
`ResponseShapeError` in somebody's browser, and the shape appears in `/openapi.json` — which the
Phase-4 MCP surface (FR-6.3) inherits for free.

The consequence to state plainly: **adding a field to the trace is an API change, not a debug
tweak.** That is the cost of the guarantee, and it is the right way round — a trace nobody can
rely on is not evidence of anything.

Two schemas rather than one. The agent loop emits `{model, stopReason, citableClauseIds, turns,
steps, corrections}`; the report writer emits `{model, stopReason, citableClauseIds,
promptVersion, corrections, inputFields, inputFlags, stubbed}`. They share exactly three fields,
which is what `traceBase` is. Forcing the rest together would mean optional `steps` on a schema
that can never have them. `turn` and `attempt` stay distinct because they count different things —
agent-loop turn versus generation attempt — and renaming narrative's would change a shape already
sitting in `qa_turns.trace_json`.

**2. `citableClauseIds` means serialized ids on both paths.** It did not before:
`agent-service.ts` keyed its citable map by `serializedClauseId` and returned those, while
`report-writer.ts` returned `clause.clauseId` — the row uuid. One published field, two meanings,
decided by which code path produced it. Fixed forward to the serialized form, because that is the
id a `[[...]]` marker carries, so a reader can join the trace's citable set to the prose it
justifies; the uuid form joined to nothing. Narrative rows written before this hold uuids. They
still parse — the field is `z.array(z.string())` and is informational — they simply will not join.

**3. Steps record which clauses they surfaced, not just how many.** FR-6.1 asks the drawer for
"retrieved chunks" and FR-5.5 asks for retrieval _decisions_ to be logged. `clauseCount` plus one
request-wide `citableClauseIds` union answered neither: it could not say which call surfaced
which clause, which is the decision.

`ToolOutcome.clauses` is already ADR-0010 point 4's citable-set source and the loop already
iterates it, so this costs a `.map()` and no query. Refs carry the row uuid alongside the
serialized id because a serialized id does not parse back to the uuid, and `GET /clauses/{id}`
needs the uuid — an id-only trace would owe the client a round trip per step just to render a
link, which is what ADR-0012 rejected for citations. No clause text: the trace says what was
surfaced, not what it said. FR-2.1 makes a chunk a clause, so recording chunk ids would give the
drawer something it cannot open.

**4. `narrativeSchema.trace` is nullable; the ask trace is not.** Only the narrative is served
from storage — `GET /cases/{id}/narrative` replays a `qa_turns` row that an older deploy may have
written. `latestNarrative` parses it rather than casting, and a row of an unreadable shape
degrades to `null` with a warning. A legacy row's markdown and citations are still perfectly good;
refusing to serve a working report over its debug payload would be the wrong trade. Ask traces
have no such path — there is no endpoint that replays one — so that field stays required.

**5. `ask` has no `restart`, and the reducer is built around that.** The agent disables streaming
on its corrective turn, so after a `retry` frame no further tokens arrive and the corrected answer
comes only inside `done`. The narrative stream is the opposite: its regeneration _is_ streamed,
which is why that reducer clears its buffer on `restart` and this one has nothing to clear on. So
`retry` keeps the rejected draft visible under a "re-checking citations" notice, and `done`
replaces it outright. A reducer that appended would show the rejected draft glued to the corrected
one with nothing on screen saying which half was which.

**6. The transcript is session-local.** It lives in the query cache, so navigating away and back
keeps it, but a reload loses it. FR-6.1 asks for a chat panel and §9 flow 2 for streamed answers
with clickable citations; neither asks for history. `qa_turns` is persisted for cost accounting
and audit, not published — and a `GET /cases/{id}/turns` needs a citations join to be worth
having, because a replayed answer without its citations renders every marker as "unresolved",
which is a history that paints the whole past conversation as suspect.

**7. The drawer is honest about a keyless run.** Zero tokens render as "running without a model
key", not as €0.0000. Presenting the absence of a measurement as a measurement would be the first
dishonest number in a codebase that has gone out of its way to avoid them.

## Consequences

The trace drawer shows what the grounding contract actually did — including, on a live run, the
exact sentences the validator made the agent take back. That evidence existed in a database column
from ADR-0010 onward and was visible to nobody.

`step.input` is model-authored and `heading` is document-authored. Both render as plain text, and
must keep doing so: no markdown renderer, no `dangerouslySetInnerHTML` (FR-7.5). React escapes
them; the drawer's job is not to undo that.

The trace drawer sits at `z-30`, under `ViewerDrawer`'s `z-40`, so a clause chip inside the trace
stacks the document over it and closing that returns the reader to the trace. Backwards, this is
invisible until someone clicks a chip, so the e2e test pins it.

**Rejected:**

- _One unified trace schema._ Optional `steps` and `turns` on a shape that can never have them,
  to save three fields of duplication.
- _A deduped `citableClauses` lookup table with steps referencing by id._ The more elegant shape,
  and genuinely better if traces ever get large. It loses today because it breaks
  `citableClauseIds` on both schemas — including the narrative one served from storage — trading
  bounded duplication for exactly the back-compat problem decision 4 exists to contain.
  **Trigger to revisit:** the first trace big enough that the duplication is measurable.
- _Client-side resolution of `citableClauseIds` instead of per-step refs._ Loses per-step
  attribution entirely, needs a route that resolves serialized ids to uuids, and costs N round
  trips on drawer open.

**Deferred:**

- **A trace drawer for the narrative.** `narrativeSchema` carries no `usage`, so it could show
  tool calls it never makes and a cost it does not publish. Cost per narrative _is_ persisted in
  `qa_turns`; it is simply not exposed.
- **Q&A history.** **Trigger to revisit:** the first time a mid-conversation reload on staging
  actually costs someone an answer, or the moment FR-6.3's `ask_case` needs turns it did not
  itself produce. `listQaTurns` in `qa-store.ts` is the unused shell of it.
- **Comparison mode**, still, per PRD §10 — it is Phase 4.
