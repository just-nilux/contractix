/**
 * The agent trace - what the model reached for, and what the grounding
 * validator made of what came back (FR-5.5, and the FR-6.1 trace drawer).
 *
 * This lives here for the same reason the SSE events do: the emitter and the
 * reader must be the same object. Until now the shape existed only as
 * TypeScript interfaces beside the loop that built it, and both response
 * schemas published it as `z.unknown()` - so the one payload whose entire
 * purpose is "show your work" was the one payload with no contract at all.
 *
 * Publishing it has a consequence worth stating plainly: **the trace is now
 * part of the API**. It appears in `/openapi.json`, the web `.parse()`s it, and
 * adding a field to it is an API change rather than a debug tweak.
 *
 * Two traces, not one. The agent loop and the report writer produce genuinely
 * different objects - a one-shot generation has no turns and calls no tools,
 * and the writer records what it was fed instead. They share exactly three
 * fields, which is what `traceBase` is; forcing the rest together would mean
 * optional `steps` on a schema that can never have them.
 */
import { z } from "zod";

/**
 * What the validator rejected on one attempt (FR-5.2). Shared because "which
 * sentences carried no citation, and which markers named nothing retrievable"
 * is the same question on both paths - only the index differs.
 */
export const groundingRejectionSchema = z.object({
  uncited: z.array(z.string()),
  unresolvedMarkers: z.array(z.string()),
});
export type GroundingRejection = z.infer<typeof groundingRejectionSchema>;

/** Indexed by agent-loop turn. */
export const agentCorrectionSchema = groundingRejectionSchema.extend({
  turn: z.number().int(),
});
export type AgentCorrection = z.infer<typeof agentCorrectionSchema>;

/**
 * Indexed by generation attempt, not by turn - the report writer runs no loop.
 * Deliberately not unified with `agentCorrectionSchema`: they count different
 * things, and renaming this one would change a shape already persisted in
 * `qa_turns.trace_json`.
 */
export const narrativeCorrectionSchema = groundingRejectionSchema.extend({
  attempt: z.number().int(),
});
export type NarrativeCorrection = z.infer<typeof narrativeCorrectionSchema>;

/**
 * Enough of a clause to name it and open it, and nothing more.
 *
 * Carried inline rather than as bare ids because a serialized id does not parse
 * back to the row uuid, and that uuid is what `GET /clauses/{id}` needs - so an
 * id-only trace would owe the client a round trip per step to render a link.
 * No `text`: the trace says which clauses were surfaced, not what they said.
 */
export const traceClauseRefSchema = z.object({
  clauseId: z.uuid(),
  serializedClauseId: z.string(),
  documentId: z.uuid(),
  clauseRef: z.string(),
  page: z.number().int(),
  heading: z.string().nullable(),
});
export type TraceClauseRef = z.infer<typeof traceClauseRefSchema>;

/** One tool call the agent made, in the order it made them. */
export const traceStepSchema = z.object({
  turn: z.number().int(),
  tool: z.string(),
  /**
   * Model-authored arguments, echoed back unvalidated on purpose - a call the
   * tool *rejected* is exactly what a reader debugging a bad answer needs to
   * see. Renderers must treat this as untrusted text (FR-7.5).
   */
  input: z.unknown(),
  ok: z.boolean(),
  /** How many clauses this call put in front of the model (ADR-0010 point 4). */
  clauseCount: z.number().int(),
  durationMs: z.number().int(),
  /**
   * *Which* clauses, so the drawer can attribute a retrieval to the decision
   * that made it (FR-5.5) rather than showing one flat set per answer. Defaulted
   * because traces written before this field existed are still readable.
   */
  clauses: z.array(traceClauseRefSchema).default([]),
});
export type TraceStep = z.infer<typeof traceStepSchema>;

const traceBase = z.object({
  model: z.string(),
  /**
   * Why generation stopped. A free string rather than an enum: it carries the
   * provider's own reason (`end_turn`, `refusal`, ...) alongside our ceilings
   * (`turn_limit`, `budget_exhausted`) and the keyless `stub`, and narrowing it
   * would mean a schema change every time a provider adds one.
   */
  stopReason: z.string(),
  /**
   * The serialized clause ids a `[[...]]` marker was allowed to name - the
   * citable set, so a reader can join the trace to the prose it justifies.
   *
   * Informational. Rows written before this schema landed hold row uuids on the
   * narrative path instead; they still parse, they just will not join.
   */
  citableClauseIds: z.array(z.string()),
});

/** `POST /cases/{id}/ask` - the tool loop. */
export const agentTraceSchema = traceBase.extend({
  turns: z.number().int(),
  steps: z.array(traceStepSchema),
  corrections: z.array(agentCorrectionSchema),
});
export type AgentTrace = z.infer<typeof agentTraceSchema>;

/** `POST /cases/{id}/narrative` - a one-shot generation over the structured report. */
export const narrativeTraceSchema = traceBase.extend({
  promptVersion: z.string(),
  corrections: z.array(narrativeCorrectionSchema),
  /** What the writer was fed: extracted fields and fired rules. */
  inputFields: z.number().int(),
  inputFlags: z.number().int(),
  /** True when keyless mode short-circuited: no model call was made. */
  stubbed: z.boolean(),
});
export type NarrativeTrace = z.infer<typeof narrativeTraceSchema>;
