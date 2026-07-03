import { type RerankDoc, type RerankerProvider, type RerankResult } from "./types.js";

/**
 * Keyless mode: preserves the incoming (RRF-fused) order. Scores are the
 * inverted rank so downstream consumers always see a monotonic score.
 */
export class PassthroughReranker implements RerankerProvider {
  readonly id = "passthrough";

  rerank(_query: string, docs: readonly RerankDoc[], topK: number): Promise<RerankResult[]> {
    return Promise.resolve(docs.slice(0, topK).map((d, i) => ({ id: d.id, score: 1 / (i + 1) })));
  }
}
