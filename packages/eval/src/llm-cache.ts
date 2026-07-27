import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type LlmConverseOptions,
  type LlmConverseResult,
  type LlmExtractOptions,
  type LlmExtractResult,
  type LlmProvider,
} from "@contractix/api";

const CACHE_PATH = path.resolve(fileURLToPath(import.meta.url), "../..", "cache/llm.jsonl");

interface CacheLine {
  provider: string;
  sha256: string;
  result: LlmExtractResult;
}

/** Content address of a call: same prompt + tool + schema + model => same key. */
function keyOf(opts: LlmExtractOptions): string {
  return createHash("sha256")
    .update(JSON.stringify({ s: opts.system, u: opts.user, t: opts.toolName, j: opts.jsonSchema }))
    .digest("hex");
}

/**
 * Content-addressed LLM-response cache, committed to the repo (mirrors
 * CachedEmbeddings). Extraction calls are deterministic given (model, system,
 * document, schema) at temperature 0, so caching makes the gated eval cheap and
 * reproducible; a genuine miss (edited prompt/schema/corpus) hits the live API
 * and appends a fresh line to commit. NEVER wraps fake/stub providers.
 */
export class CachedLlm implements LlmProvider {
  readonly id: string;
  private readonly map = new Map<string, LlmExtractResult>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly inner: LlmProvider,
    private readonly cachePath: string = CACHE_PATH,
  ) {
    if (inner.id.startsWith("fake:") || inner.id.startsWith("stub:")) {
      throw new Error("refusing to cache fake/stub llm output");
    }
    this.id = inner.id;
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.cachePath)) return;
    for (const line of fs.readFileSync(this.cachePath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as CacheLine;
      if (entry.provider === this.id) this.map.set(entry.sha256, entry.result);
    }
  }

  stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  async extract(opts: LlmExtractOptions): Promise<LlmExtractResult> {
    const sha = keyOf(opts);
    const cached = this.map.get(sha);
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const result = await this.inner.extract(opts);
    this.map.set(sha, result);
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    fs.appendFileSync(
      this.cachePath,
      `${JSON.stringify({ provider: this.id, sha256: sha, result } satisfies CacheLine)}\n`,
    );
    return result;
  }

  /**
   * Passed through uncached. This cache content-addresses a single forced-tool
   * call; an agent turn is a function of the whole message history including
   * tool results, so caching it would key on a transcript that never repeats.
   * The extraction eval never calls this — it exists so CachedLlm stays a
   * drop-in LlmProvider.
   */
  converse(opts: LlmConverseOptions): Promise<LlmConverseResult> {
    return this.inner.converse(opts);
  }
}
