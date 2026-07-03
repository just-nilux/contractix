export interface RerankDoc {
  id: string;
  text: string;
}

export interface RerankResult {
  id: string;
  score: number;
}

export interface RerankerProvider {
  readonly id: string;
  /** Returns the topK docs re-ordered by relevance to the query. */
  rerank(query: string, docs: readonly RerankDoc[], topK: number): Promise<RerankResult[]>;
}
