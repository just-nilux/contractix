import { type ModelParams } from "@contractix/shared";

import { postJson, type PostJsonOptions, postSse } from "../http.js";
import {
  type LlmContentBlock,
  type LlmConverseOptions,
  type LlmConverseResult,
  type LlmExtractOptions,
  type LlmExtractResult,
  type LlmProvider,
  type LlmStopReason,
  type TokenUsage,
} from "./types.js";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_MAX_TOKENS = 4_096;
/** Adaptive-thinking models bill thinking against max_tokens, so a turn needs room. */
const DEFAULT_CONVERSE_MAX_TOKENS = 8_192;

interface AnthropicContentBlock {
  type: string;
  name?: string;
  input?: unknown;
  id?: string;
  text?: string;
}

interface AnthropicMessageResponse {
  content: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

/** The subset of the streaming event envelope we act on. */
interface AnthropicStreamEvent {
  index?: number;
  message?: { usage?: { input_tokens?: number } };
  content_block?: { type?: string; text?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: { output_tokens?: number };
}

function mapStopReason(raw: string | null | undefined): LlmStopReason {
  switch (raw) {
    case "tool_use":
    case "max_tokens":
    case "refusal":
      return raw;
    default:
      // stop_sequence / pause_turn / end_turn / null all mean "nothing more to do".
      return "end_turn";
  }
}

/** Our provider-neutral blocks -> Anthropic wire blocks. */
function toWireBlock(block: LlmContentBlock): Record<string, unknown> {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        ...(block.isError ? { is_error: true } : {}),
      };
  }
}

function fromWireBlocks(blocks: AnthropicContentBlock[]): LlmContentBlock[] {
  const out: LlmContentBlock[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") {
      out.push({ type: "text", text: b.text });
    } else if (b.type === "tool_use" && b.id !== undefined && b.name !== undefined) {
      out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} });
    }
    // thinking / redacted_thinking blocks carry no answer content and are dropped.
  }
  return out;
}

/**
 * Structured extraction via the Messages API with a single forced tool
 * (`tool_choice: {type:"tool"}`), plus the multi-turn `converse()` the Phase-3
 * agent loop drives (ADR-0010).
 *
 * Sampling parameters are gated on `params.sampling` because they are a model
 * fact, not a preference: Claude Sonnet 5 and later reject a non-default
 * `temperature` with a 400, and take reasoning depth from
 * `output_config.effort` instead. Haiku 4.5 still accepts `temperature: 0`,
 * which is what pins extraction determinism. Never constructed in keyless mode.
 */
export class AnthropicLlm implements LlmProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly params: ModelParams;

  constructor(
    private readonly cfg: {
      model: string;
      apiKey: string;
      baseUrl?: string;
      params: ModelParams;
    },
    private readonly http: PostJsonOptions = {},
  ) {
    this.id = `anthropic:${cfg.model}`;
    this.baseUrl = cfg.baseUrl ?? DEFAULT_BASE_URL;
    this.params = cfg.params;
  }

  private get headers(): Record<string, string> {
    return { "x-api-key": this.cfg.apiKey, "anthropic-version": ANTHROPIC_VERSION };
  }

  /** Sampling/effort knobs, shaped by what this specific model accepts. */
  private tuning(temperature?: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (this.params.sampling) out.temperature = temperature ?? 0;
    if (this.params.effort) out.output_config = { effort: this.params.effort };
    return out;
  }

  async extract(opts: LlmExtractOptions): Promise<LlmExtractResult> {
    const res = await postJson<AnthropicMessageResponse>(
      `${this.baseUrl}/messages`,
      {
        model: this.cfg.model,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...this.tuning(opts.temperature),
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
        tools: [
          {
            name: opts.toolName,
            description: opts.toolDescription ?? "Record the structured extraction.",
            input_schema: opts.jsonSchema,
          },
        ],
        tool_choice: { type: "tool", name: opts.toolName },
      },
      this.headers,
      this.http,
    );

    const toolUse = res.content.find((b) => b.type === "tool_use" && b.name === opts.toolName);
    if (toolUse?.input === undefined) {
      throw new Error(`anthropic: response contained no '${opts.toolName}' tool_use block`);
    }
    return {
      json: toolUse.input,
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      },
    };
  }

  async converse(opts: LlmConverseOptions): Promise<LlmConverseResult> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      max_tokens: opts.maxTokens ?? DEFAULT_CONVERSE_MAX_TOKENS,
      ...this.tuning(),
      // Cached as a stable prefix: the system prompt and tool list are re-sent
      // on every turn of a loop that can run 12 deep (see prompt-caching).
      system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
      messages: opts.messages.map((m) => ({
        role: m.role,
        content: m.content.map(toWireBlock),
      })),
      tools: opts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.jsonSchema,
      })),
    };

    return opts.onTextDelta
      ? this.converseStreaming(body, opts.onTextDelta)
      : this.converseBuffered(body);
  }

  private async converseBuffered(body: Record<string, unknown>): Promise<LlmConverseResult> {
    const res = await postJson<AnthropicMessageResponse>(
      `${this.baseUrl}/messages`,
      body,
      this.headers,
      this.http,
    );
    return {
      stopReason: mapStopReason(res.stop_reason),
      content: fromWireBlocks(res.content),
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      },
    };
  }

  private async converseStreaming(
    body: Record<string, unknown>,
    onTextDelta: (delta: string) => void,
  ): Promise<LlmConverseResult> {
    const content: LlmContentBlock[] = [];
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: LlmStopReason = "end_turn";

    // Blocks arrive incrementally and are indexed; assemble then flatten in order.
    const partials = new Map<
      number,
      { type: string; text: string; id: string | undefined; name: string | undefined; json: string }
    >();

    await postSse(
      `${this.baseUrl}/messages`,
      { ...body, stream: true },
      this.headers,
      (ev) => {
        const d = ev.data as AnthropicStreamEvent;
        switch (ev.event) {
          case "message_start":
            usage.inputTokens = d.message?.usage?.input_tokens ?? 0;
            break;
          case "content_block_start":
            if (d.index === undefined) break;
            partials.set(d.index, {
              type: d.content_block?.type ?? "text",
              text: d.content_block?.text ?? "",
              id: d.content_block?.id,
              name: d.content_block?.name,
              json: "",
            });
            break;
          case "content_block_delta": {
            const p = d.index === undefined ? undefined : partials.get(d.index);
            if (!p) break;
            if (d.delta?.type === "text_delta") {
              const text = d.delta.text ?? "";
              p.text += text;
              if (p.type === "text") onTextDelta(text);
            } else if (d.delta?.type === "input_json_delta") {
              p.json += d.delta.partial_json ?? "";
            }
            break;
          }
          case "message_delta":
            if (d.delta?.stop_reason) stopReason = mapStopReason(d.delta.stop_reason);
            if (typeof d.usage?.output_tokens === "number") {
              usage.outputTokens = d.usage.output_tokens;
            }
            break;
          default:
            break;
        }
      },
      this.http,
    );

    for (const index of [...partials.keys()].sort((a, b) => a - b)) {
      const p = partials.get(index)!;
      if (p.type === "text") {
        content.push({ type: "text", text: p.text });
      } else if (p.type === "tool_use" && p.id && p.name) {
        let input: unknown = {};
        try {
          input = p.json.length > 0 ? JSON.parse(p.json) : {};
        } catch {
          // Malformed tool input is a tool-level error, not a transport failure:
          // the loop reports it back as an is_error tool_result and lets the
          // model correct itself.
          input = { __parseError: p.json };
        }
        content.push({ type: "tool_use", id: p.id, name: p.name, input });
      }
    }

    return { stopReason, content, usage };
  }
}
