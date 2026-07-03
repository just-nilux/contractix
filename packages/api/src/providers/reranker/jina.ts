import { postJson, type PostJsonOptions } from "../http.js";
import { type RerankDoc, type RerankerProvider, type RerankResult } from "./types.js";

interface JinaRerankResponse {
  results: { index: number; relevance_score: number }[];
}

export class JinaReranker implements RerankerProvider {
  readonly id: string;

  constructor(
    private readonly cfg: { model: string; apiKey: string; baseUrl: string },
    private readonly http: PostJsonOptions = {},
  ) {
    this.id = `jina:${cfg.model}`;
  }

  async rerank(query: string, docs: readonly RerankDoc[], topK: number): Promise<RerankResult[]> {
    if (docs.length === 0) return [];
    const res = await postJson<JinaRerankResponse>(
      `${this.cfg.baseUrl}/rerank`,
      {
        model: this.cfg.model,
        query,
        documents: docs.map((d) => d.text),
        top_n: Math.min(topK, docs.length),
        return_documents: false,
      },
      { authorization: `Bearer ${this.cfg.apiKey}` },
      this.http,
    );
    return res.results.flatMap((r) => {
      const doc = docs[r.index];
      return doc ? [{ id: doc.id, score: r.relevance_score }] : [];
    });
  }
}
