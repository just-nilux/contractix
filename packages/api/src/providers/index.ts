import { type LlmRole, llmModelId, llmParamsFor, type ModelsConfig } from "@contractix/shared";

import { FakeEmbeddings } from "./embeddings/fake.js";
import { JinaEmbeddings } from "./embeddings/jina.js";
import { type EmbeddingsProvider } from "./embeddings/types.js";
import { AnthropicLlm } from "./llm/anthropic.js";
import { FakeLlm } from "./llm/fake.js";
import { type LlmProvider } from "./llm/types.js";
import { JinaReranker } from "./reranker/jina.js";
import { PassthroughReranker } from "./reranker/passthrough.js";
import { type RerankerProvider } from "./reranker/types.js";

export interface ProviderBundle {
  embeddings: EmbeddingsProvider;
  reranker: RerankerProvider;
  /** Small model (Haiku): classification and extraction, per ADR-0004/0006. */
  llm: LlmProvider;
  /** Frontier model (Sonnet): the Phase-3 agent loop and report generation. */
  agentLlm: LlmProvider;
}

export interface ProviderFactoryOptions {
  /** Usually process.env; injected for tests. */
  envVars: Record<string, string | undefined>;
  /** Missing keys outside production degrade to fakes; in production they throw. */
  production: boolean;
  /** Called when a real provider silently degrades to a fake (log hook). */
  onFallback?: (role: "embeddings" | "reranker" | "llm", reason: string) => void;
}

export function createProviders(cfg: ModelsConfig, opts: ProviderFactoryOptions): ProviderBundle {
  return {
    embeddings: createEmbeddings(cfg, opts),
    reranker: createReranker(cfg, opts),
    llm: createLlm(cfg, opts, "small_model"),
    agentLlm: createLlm(cfg, opts, "model"),
  };
}

function createEmbeddings(cfg: ModelsConfig, opts: ProviderFactoryOptions): EmbeddingsProvider {
  const e = cfg.embeddings;
  if (e.provider === "fake") return new FakeEmbeddings(e.dimensions);

  const apiKey = opts.envVars[e.api_key_env];
  if (!apiKey) {
    if (opts.production) {
      throw new Error(`embeddings provider '${e.provider}' requires env ${e.api_key_env}`);
    }
    opts.onFallback?.("embeddings", `missing ${e.api_key_env}`);
    return new FakeEmbeddings(e.dimensions);
  }
  return new JinaEmbeddings({
    model: e.model,
    dimensions: e.dimensions,
    apiKey,
    baseUrl: e.base_url,
  });
}

function createReranker(cfg: ModelsConfig, opts: ProviderFactoryOptions): RerankerProvider {
  const r = cfg.reranker;
  if (r.provider === "passthrough") return new PassthroughReranker();

  const apiKey = opts.envVars[r.api_key_env];
  if (!apiKey) {
    if (opts.production) {
      throw new Error(`reranker provider '${r.provider}' requires env ${r.api_key_env}`);
    }
    opts.onFallback?.("reranker", `missing ${r.api_key_env}`);
    return new PassthroughReranker();
  }
  return new JinaReranker({ model: r.model, apiKey, baseUrl: r.base_url });
}

/**
 * One adapter per pinned role. Classification/extraction stay on the small
 * model (ADR-0004/0006); the agent loop runs on the frontier model. Each
 * carries its own `params`, because request-shape capabilities differ per model
 * (Sonnet 5 rejects sampling parameters; Haiku 4.5 accepts them).
 */
function createLlm(cfg: ModelsConfig, opts: ProviderFactoryOptions, role: LlmRole): LlmProvider {
  const l = cfg.llm.primary;
  const apiKey = opts.envVars[l.api_key_env];
  if (!apiKey) {
    if (opts.production) {
      throw new Error(`llm provider '${l.provider}' requires env ${l.api_key_env}`);
    }
    opts.onFallback?.("llm", `missing ${l.api_key_env}`);
    return new FakeLlm();
  }
  return new AnthropicLlm({
    model: llmModelId(cfg.llm, role),
    apiKey,
    params: llmParamsFor(cfg.llm, role),
  });
}

export { type EmbeddingsProvider, type EmbedOptions } from "./embeddings/types.js";
export { type RerankDoc, type RerankerProvider, type RerankResult } from "./reranker/types.js";
export {
  type JsonSchema,
  type LlmContentBlock,
  type LlmConverseOptions,
  type LlmConverseResult,
  type LlmExtractOptions,
  type LlmExtractResult,
  type LlmMessage,
  type LlmProvider,
  type LlmStopReason,
  type LlmToolDef,
  type TokenUsage,
} from "./llm/types.js";
export { FakeEmbeddings } from "./embeddings/fake.js";
export { PassthroughReranker } from "./reranker/passthrough.js";
export { AnthropicLlm } from "./llm/anthropic.js";
export { FakeLlm } from "./llm/fake.js";
