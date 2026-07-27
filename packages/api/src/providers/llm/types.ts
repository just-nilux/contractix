/** A JSON Schema object (draft 2020-12), passed verbatim as an Anthropic tool input_schema. */
export type JsonSchema = Record<string, unknown>;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmExtractOptions {
  /** System prompt: the model's role and the grounding contract. */
  system: string;
  /**
   * User content: the document as clause-structured DATA, never instructions
   * (FR-7.5 — the extraction call exposes no tools that could exfiltrate).
   */
  user: string;
  /** Name of the single tool the model is forced to call. */
  toolName: string;
  /** JSON Schema (from z.toJSONSchema) the tool input must satisfy. */
  jsonSchema: JsonSchema;
  /** Human-readable tool description. */
  toolDescription?: string;
  maxTokens?: number;
  /** Defaults to 0 — extraction is a deterministic structured task. */
  temperature?: number;
}

export interface LlmExtractResult {
  /** The forced tool_use input; validate against the source Zod schema before trusting it. */
  json: unknown;
  usage: TokenUsage;
}

/**
 * One block of a conversation turn. Deliberately provider-neutral: the agent
 * loop (ADR-0010) never sees an Anthropic wire shape, so the deferred OpenAI
 * fallback router is an adapter swap rather than a rewrite of the loop.
 */
export type LlmContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export interface LlmMessage {
  role: "user" | "assistant";
  content: LlmContentBlock[];
}

export interface LlmToolDef {
  name: string;
  description: string;
  /** JSON Schema (from z.toJSONSchema) the tool input must satisfy. */
  jsonSchema: JsonSchema;
}

export interface LlmConverseOptions {
  /** The model's role and the grounding contract. Cached as a stable prefix. */
  system: string;
  messages: LlmMessage[];
  /** Order is load-bearing: it is part of the cached prompt prefix. */
  tools: LlmToolDef[];
  /** Caps thinking + response text together on adaptive-thinking models. */
  maxTokens?: number;
  /** Present ⇒ stream and report text deltas as they arrive (SSE, FR-6.2). */
  onTextDelta?: (delta: string) => void;
}

/**
 * `refusal` is surfaced rather than thrown: the agent loop turns it into a
 * user-visible "could not answer", never a 500.
 */
export type LlmStopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal";

export interface LlmConverseResult {
  stopReason: LlmStopReason;
  content: LlmContentBlock[];
  usage: TokenUsage;
}

export interface LlmProvider {
  /** Logged/persisted like embedding_model, e.g. "anthropic:claude-haiku-4-5-20251001" or "fake:llm". */
  readonly id: string;
  /** Single-shot structured extraction via a forced tool call. */
  extract(opts: LlmExtractOptions): Promise<LlmExtractResult>;
  /**
   * One turn of a multi-turn tool-use conversation (FR-5.1). The caller owns
   * the loop, the turn budget, and the tool execution — this only exchanges
   * messages, so the grounding contract and budgets stay in our code.
   */
  converse(opts: LlmConverseOptions): Promise<LlmConverseResult>;
}
