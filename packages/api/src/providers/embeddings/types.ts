export interface EmbedOptions {
  /** Asymmetric retrieval: corpus chunks embed as documents, queries as queries. */
  inputType: "document" | "query";
}

export interface EmbeddingsProvider {
  /** Stored per chunk as embedding_model (FR-2.4), e.g. "jina:jina-embeddings-v4@1024". */
  readonly id: string;
  readonly dimensions: number;
  embed(texts: readonly string[], opts: EmbedOptions): Promise<number[][]>;
}
