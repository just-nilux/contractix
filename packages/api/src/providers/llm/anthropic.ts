import { postJson, type PostJsonOptions } from "../http.js";
import { type LlmExtractOptions, type LlmExtractResult, type LlmProvider } from "./types.js";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_MAX_TOKENS = 4_096;

interface AnthropicContentBlock {
  type: string;
  name?: string;
  input?: unknown;
}

interface AnthropicMessageResponse {
  content: AnthropicContentBlock[];
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Structured extraction via the Messages API with a single forced tool
 * (`tool_choice: {type:"tool"}`), so the model must return JSON matching the
 * tool's input_schema. Non-streaming — one shot per field group — which is why
 * the shared postJson helper (retry/backoff/Retry-After) is sufficient; token
 * streaming is a Phase-3 agent-loop concern. Never constructed in keyless mode.
 */
export class AnthropicLlm implements LlmProvider {
  readonly id: string;
  private readonly baseUrl: string;

  constructor(
    private readonly cfg: { model: string; apiKey: string; baseUrl?: string },
    private readonly http: PostJsonOptions = {},
  ) {
    this.id = `anthropic:${cfg.model}`;
    this.baseUrl = cfg.baseUrl ?? DEFAULT_BASE_URL;
  }

  async extract(opts: LlmExtractOptions): Promise<LlmExtractResult> {
    const res = await postJson<AnthropicMessageResponse>(
      `${this.baseUrl}/messages`,
      {
        model: this.cfg.model,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: opts.temperature ?? 0,
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
      {
        "x-api-key": this.cfg.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
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
}
