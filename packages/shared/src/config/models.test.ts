import { describe, expect, it } from "vitest";

import {
  costEur,
  embeddingsProviderId,
  llmModelId,
  llmParamsFor,
  loadModelsConfig,
  parseModelsConfig,
  rerankerProviderId,
} from "./models.js";

describe("models.yaml loader", () => {
  it("parses the repo's actual models.yaml", () => {
    const cfg = loadModelsConfig();
    expect(cfg.version).toBe(1);
    expect(cfg.embeddings.dimensions).toBe(1024);
    expect(cfg.embeddings.api_key_env).toBe("JINA_API_KEY");
    expect(embeddingsProviderId(cfg.embeddings)).toBe("jina:jina-embeddings-v4@1024");
    expect(rerankerProviderId(cfg.reranker)).toBe("jina:jina-reranker-v3");
    expect(cfg.llm.primary.provider).toBe("anthropic");
  });

  it("pins request-shape capabilities per role, not per provider", () => {
    const cfg = loadModelsConfig();
    // The agent model rejects sampling params (400); the small model needs
    // temperature: 0 to keep extraction deterministic. See ADR-0010.
    expect(llmParamsFor(cfg.llm, "model").sampling).toBe(false);
    expect(llmParamsFor(cfg.llm, "model").effort).toBeDefined();
    expect(llmParamsFor(cfg.llm, "small_model").sampling).toBe(true);
    expect(llmModelId(cfg.llm, "model")).not.toBe(llmModelId(cfg.llm, "small_model"));
  });

  it("derives cost in EUR from the pinned USD price and FX rate", () => {
    const cfg = loadModelsConfig();
    const { pricing_usd_per_mtok: price, usd_to_eur: fx } = cfg.llm.primary;
    const eur = costEur(cfg.llm, "model", { inputTokens: 1_000_000, outputTokens: 0 });
    expect(eur).toBeCloseTo(price.model.input * fx, 10);
    expect(costEur(cfg.llm, "model", { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("rejects unknown providers, bad dims, and wrong version", () => {
    const valid = `
version: 1
embeddings: { provider: jina, model: m, dimensions: 8, api_key_env: K, base_url: "https://x.test" }
reranker: { provider: passthrough, model: m, api_key_env: K, base_url: "https://x.test" }
llm:
  primary:
    provider: anthropic
    model: a
    small_model: b
    api_key_env: K
    params: { model: { sampling: false, effort: high }, small_model: { sampling: true } }
    pricing_usd_per_mtok: { model: { input: 3, output: 15 }, small_model: { input: 1, output: 5 } }
    usd_to_eur: 0.92
  fallback: { provider: openai, model: null, api_key_env: K }
`;
    expect(() => parseModelsConfig(valid)).not.toThrow();
    expect(() => parseModelsConfig(valid.replace("version: 1", "version: 2"))).toThrow();
    expect(() => parseModelsConfig(valid.replace("provider: jina", "provider: qdrant"))).toThrow();
    expect(() => parseModelsConfig(valid.replace("dimensions: 8", "dimensions: -1"))).toThrow();
    expect(() => parseModelsConfig(valid.replace("usd_to_eur: 0.92", "usd_to_eur: 0"))).toThrow();
    expect(() => parseModelsConfig(valid.replace("effort: high", "effort: turbo"))).toThrow();
  });
});
