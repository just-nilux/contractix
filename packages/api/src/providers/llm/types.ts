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

export interface LlmProvider {
  /** Logged/persisted like embedding_model, e.g. "anthropic:claude-haiku-4-5-20251001" or "fake:llm". */
  readonly id: string;
  /** Single-shot structured extraction via a forced tool call. */
  extract(opts: LlmExtractOptions): Promise<LlmExtractResult>;
}
