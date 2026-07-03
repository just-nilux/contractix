import { describe, expect, it } from "vitest";

import {
  embeddingsProviderId,
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

  it("rejects unknown providers, bad dims, and wrong version", () => {
    const valid = `
version: 1
embeddings: { provider: jina, model: m, dimensions: 8, api_key_env: K, base_url: "https://x.test" }
reranker: { provider: passthrough, model: m, api_key_env: K, base_url: "https://x.test" }
llm:
  primary: { provider: anthropic, model: a, small_model: b, api_key_env: K }
  fallback: { provider: openai, model: null, api_key_env: K }
`;
    expect(() => parseModelsConfig(valid)).not.toThrow();
    expect(() => parseModelsConfig(valid.replace("version: 1", "version: 2"))).toThrow();
    expect(() => parseModelsConfig(valid.replace("provider: jina", "provider: qdrant"))).toThrow();
    expect(() => parseModelsConfig(valid.replace("dimensions: 8", "dimensions: -1"))).toThrow();
  });
});
