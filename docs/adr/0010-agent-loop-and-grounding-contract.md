# ADR-0010: Agent loop, grounding contract, and the citable set

- **Status:** accepted
- **Date:** 2026-07-27
- **Builds on:** ADR-0004 (provider interfaces / models.yaml), ADR-0005 (frozen
  offsets), ADR-0006 (constrained extraction + deterministic rules), ADR-0007 /
  ADR-0009 (citation resolution)

## Context

ADR-0008 wired upload → classify → extract → benchmark → report. That path is
deterministic: every claim in a report is a stored row with a stored citation.
Free-form Q&A (FR-5.1, FR-5.2, FR-5.5) is the first place a model writes prose
that a user will act on, so it is the first place hallucination can reach them.
The PRD names this the worst failure mode (§11) and demands that every factual
sentence carry a citation to a real span.

Three things were missing. `LlmProvider` had only `extract()` — a single forced
tool call, which cannot express a multi-turn loop. There was no notion of what a
model is _allowed_ to cite. And nothing checked the output.

## Decision

**1. `converse()` extends the provider interface; `extract()` is untouched.**
A second method taking provider-neutral message/tool blocks. Classification and
extraction keep their exact request shape, so the pinned extraction baseline
stays valid, and the loop never sees an Anthropic wire shape — the deferred
OpenAI fallback router is an adapter swap, not a rewrite. Streaming gets its own
`postSse` path because `postJson` reads a whole body; retry applies only to
establishing the stream, since retrying mid-stream would silently replay a
partial turn.

**2. Request-shape capabilities are model facts, pinned in `models.yaml`.**
Claude Sonnet 5 rejects a non-default `temperature` with a 400 and takes
reasoning depth from `output_config.effort`; Haiku 4.5 accepts `temperature: 0`,
which is what pins extraction determinism. Both roles therefore need different
request shapes from the same provider class. `params` per role expresses that
without naming a model anywhere but `models.yaml` (ADR-0004). This also made
`llm.primary.model` live config: `createProviders` now builds `llm` (small) and
`agentLlm` (frontier) side by side.

**3. The loop is hand-rolled.** Max 12 turns, a per-request output-token
ceiling, all tool results for one assistant turn returned in a single user
message (splitting them trains the model out of parallel tool use). A tool that
throws becomes an `is_error` tool_result, not a 500 — the model can retry or
answer without it. PRD §8 rules out LangChain-style frameworks; the deeper
reason is that the budgets, the trace and the grounding contract _are_ the
product and have to stay inspectable.

**4. The citable set is built from tool output, not model output.** Every tool
returns the clauses it surfaced alongside its model-facing payload; their union
is the only set of ids that may be cited. A `[[clause_id]]` marker resolves only
if it parses as a strict `clauseIdSchema` **and** names a clause in that set. So
a well-formed id for a clause the model never retrieved — the most dangerous
failure, because it looks correct — is rejected. Combined with tools that take
tenant and case from the HTTP request rather than from arguments, the model
cannot widen its own scope or cite across cases.

**5. Resolution is structural, never quote-matched.** The stored span is the
clause's frozen offsets and the anchor is its frozen text (ADR-0005), so the
anchor invariant holds by construction and a convincing paraphrase cannot earn a
citation. This is the same posture as extraction, arrived at from the other
direction: ADR-0007 relaxed _model-supplied_ ids to hints because the model
rarely echoes them correctly; ids **we** emit and check stay strict.

**6. Validation failure buys exactly one corrective regeneration.** The critique
names the offending sentences and re-states the only legal ids. If the retry
still fails, the unsupported claims are returned in `couldNotVerify` rather than
dropped: a claim the user can see is flagged is safer than one silently removed
(FR-5.2). Sentence splitting masks markers first so a clause path like
`anlage-1/2.1` cannot split a sentence, skips German legal abbreviations
(`§ 3 Abs. 2`, `z.B.`, `Nr.`), and absorbs a marker trailing the final period —
each of those, left unhandled, fails a _correct_ answer.

**7. Keyless mode stays first-class.** `FakeLlm.converse()` runs a scripted
retrieve-then-answer loop citing only ids a tool actually returned, and emits an
uncited sentence when retrieval finds nothing. CI therefore exercises the loop,
the validator, citation persistence and SSE without a key, and the integration
test asserts the keyless answer is grounded on the _first_ attempt — if the fake
and the validator drift, that fails rather than passing via the retry.

## Consequences

- Upload → analyse → ask → cited answer works end to end over HTTP, keyless in
  CI and real once keyed.
- `qa_turns` persists the trace, tokens, cost and latency per turn, so the
  FR-6.1 trace drawer and the FR-8 cost KPI read stored rows rather than logs.
  Cost derives from the published USD price and one pinned FX rate, so every
  figure traces to a source.
- The strictness is deliberate and will produce false positives: any sentence
  containing letters is treated as an assertion needing a citation, exempting
  only a lead-in ending in `:`. Re-evaluate against real answers once the
  faithfulness eval exists — the tuning signal should come from measurement, not
  from taste.
- **Deferred, not dropped:** the LLM-as-judge faithfulness eval (PRD E-2/E-4)
  needs a `judge` role in `models.yaml`, versioned judge prompts and a
  re-baselining discipline — Phase 4, and the 30 gold Q&A pairs currently
  scoring retrieval become its answer-level set. Also deferred: the injection
  suite (FR-7.5 is enforced by prompt and by tool-mediated access today, but is
  not yet regression-gated), the narrative report (FR-5.3), comparison mode
  (FR-5.4), and Prometheus `/metrics`.
- Auth is still the single dev tenant. `askCase` takes a real `tenantId`, so the
  auth slice is a swap at the route boundary rather than a rewrite.
