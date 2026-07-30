/**
 * Server-Sent Event payloads for the two POST streams (`ask`, `narrative`) and
 * the one GET stream (`progress`).
 *
 * These exist as Zod rather than as TypeScript types on the API side so the
 * emitter and the consumer are the same object: `AgentEvent` and
 * `NarrativeEvent` are `z.infer`s of the schemas below, which means a new event
 * variant cannot be emitted without the web being able to parse it.
 *
 * Two levels, because the wire carries more than the writer emits. The agent
 * and the report writer emit progress events; the *routes* wrap them with a
 * terminal `done` (the full response body) and `error`. So `*EventSchema` is
 * what a writer may emit, and `*StreamEventSchema` is what a client may see.
 *
 * One asymmetry to know about: the `done` and `error` frames carry bare bodies
 * with no `type` field, because the route serializes the response object
 * itself. A client therefore injects the SSE event name as the discriminator
 * before parsing - a no-op for the frames that already carry it, and the reason
 * one union covers every frame on the stream.
 */
import { z } from "zod";

import { askResponseSchema, narrativeSchema } from "./api.js";

/** The body of a terminal `error` frame on any stream. */
export const streamErrorSchema = z.object({ message: z.string() });

// --- agent (`POST /cases/{id}/ask`) -------------------------------------------

const agentTokenSchema = z.object({ type: z.literal("token"), text: z.string() });
const agentToolCallSchema = z.object({
  type: z.literal("tool_call"),
  name: z.string(),
  input: z.unknown(),
});
const agentToolResultSchema = z.object({
  type: z.literal("tool_result"),
  name: z.string(),
  ok: z.boolean(),
  /** How many clauses the tool surfaced - the citable set grows only here (ADR-0010). */
  clauseCount: z.number().int(),
});
const agentRetrySchema = z.object({ type: z.literal("retry"), reason: z.string() });

/** What `askCase` may emit. */
export const agentEventSchema = z.discriminatedUnion("type", [
  agentTokenSchema,
  agentToolCallSchema,
  agentToolResultSchema,
  agentRetrySchema,
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;

/** What a client reading the stream may see, terminal frames included. */
export const agentStreamEventSchema = z.discriminatedUnion("type", [
  agentTokenSchema,
  agentToolCallSchema,
  agentToolResultSchema,
  agentRetrySchema,
  askResponseSchema.extend({ type: z.literal("done") }),
  streamErrorSchema.extend({ type: z.literal("error") }),
]);
export type AgentStreamEvent = z.infer<typeof agentStreamEventSchema>;

// --- narrative (`POST /cases/{id}/narrative`) ---------------------------------

const narrativeTokenSchema = z.object({ type: z.literal("token"), text: z.string() });
const narrativeRetrySchema = z.object({ type: z.literal("retry"), reason: z.string() });
/**
 * Unlike `ask`, the corrective regeneration is streamed, so the client is told
 * to discard what it has rather than being left with two concatenated drafts.
 */
const narrativeRestartSchema = z.object({ type: z.literal("restart") });

/** What `writeNarrativeReport` may emit. */
export const narrativeEventSchema = z.discriminatedUnion("type", [
  narrativeTokenSchema,
  narrativeRetrySchema,
  narrativeRestartSchema,
]);
export type NarrativeEvent = z.infer<typeof narrativeEventSchema>;

export const narrativeStreamEventSchema = z.discriminatedUnion("type", [
  narrativeTokenSchema,
  narrativeRetrySchema,
  narrativeRestartSchema,
  narrativeSchema.extend({ type: z.literal("done") }),
  streamErrorSchema.extend({ type: z.literal("error") }),
]);
export type NarrativeStreamEvent = z.infer<typeof narrativeStreamEventSchema>;

// --- progress (`GET /cases/{id}/events`) --------------------------------------

/**
 * `progress`, `done` and `timeout` each carry the same full `progressSchema`
 * snapshot, which is what makes a reconnect indistinguishable from a first
 * connect. `heartbeat` is a real event with an *empty* body rather than a
 * comment line, so it parses as a frame and is discarded by name.
 *
 * `done` fires only once every document is terminal *and* analysis has been
 * asked for, so it is not the only way a case finishes - a merely-ingested case
 * runs to `timeout` instead. Clients derive completion from the phases.
 */
export const progressEventNameSchema = z.enum(["progress", "done", "timeout", "heartbeat"]);
export type ProgressEventName = z.infer<typeof progressEventNameSchema>;

/** The event names whose body is a snapshot; `heartbeat` deliberately is not. */
export const progressSnapshotEventNameSchema = z.enum(["progress", "done", "timeout"]);
export type ProgressSnapshotEventName = z.infer<typeof progressSnapshotEventNameSchema>;
