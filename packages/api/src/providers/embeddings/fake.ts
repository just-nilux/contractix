import { type EmbedOptions, type EmbeddingsProvider } from "./types.js";

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic char-trigram feature hashing, L2-normalized. Deliberately
 * *weakly semantic*: overlapping text produces nonzero cosine similarity, so
 * keyless tests exercise the vector channel meaningfully instead of hashing
 * to orthogonal noise. Never used in production (factory enforces).
 */
export class FakeEmbeddings implements EmbeddingsProvider {
  readonly id: string;

  constructor(readonly dimensions: number) {
    this.id = `fake:char-trigram@${dimensions}`;
  }

  embed(texts: readonly string[], _opts: EmbedOptions): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.embedOne(t)));
  }

  private embedOne(text: string): number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    const s = ` ${text.toLowerCase().replaceAll(/\s+/gu, " ").trim()} `;
    for (let i = 0; i + 3 <= s.length; i++) {
      const tri = s.slice(i, i + 3);
      const idx = fnv1a(tri) % this.dimensions;
      v[idx] = (v[idx] ?? 0) + 1;
    }
    const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
    return norm === 0 ? v : v.map((x) => x / norm);
  }
}
