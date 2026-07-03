import { postJson, type PostJsonOptions } from "../http.js";
import { type EmbedOptions, type EmbeddingsProvider } from "./types.js";

interface JinaEmbeddingResponse {
  data: { index: number; embedding: number[] }[];
}

const BATCH_SIZE = 64;

export class JinaEmbeddings implements EmbeddingsProvider {
  readonly id: string;
  readonly dimensions: number;

  constructor(
    private readonly cfg: {
      model: string;
      dimensions: number;
      apiKey: string;
      baseUrl: string;
    },
    private readonly http: PostJsonOptions = {},
  ) {
    this.id = `jina:${cfg.model}@${cfg.dimensions}`;
    this.dimensions = cfg.dimensions;
  }

  async embed(texts: readonly string[], opts: EmbedOptions): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const res = await postJson<JinaEmbeddingResponse>(
        `${this.cfg.baseUrl}/embeddings`,
        {
          model: this.cfg.model,
          input: batch,
          dimensions: this.cfg.dimensions,
          task: opts.inputType === "query" ? "retrieval.query" : "retrieval.passage",
        },
        { authorization: `Bearer ${this.cfg.apiKey}` },
        this.http,
      );
      const sorted = [...res.data].sort((a, b) => a.index - b.index);
      if (sorted.length !== batch.length) {
        throw new Error(`jina returned ${sorted.length} embeddings for ${batch.length} inputs`);
      }
      for (const item of sorted) {
        if (item.embedding.length !== this.dimensions) {
          throw new Error(
            `jina embedding has ${item.embedding.length} dims, expected ${this.dimensions}`,
          );
        }
        out.push(item.embedding);
      }
    }
    return out;
  }
}
