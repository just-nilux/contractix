import { getEncoding, type Tiktoken } from "js-tiktoken";

let encoder: Tiktoken | null = null;

function enc(): Tiktoken {
  encoder ??= getEncoding("o200k_base");
  return encoder;
}

/**
 * BPE cost is quadratic in the length of a single pretokenizer "word";
 * uploaded documents are untrusted, and a megabyte-long unbroken run must not
 * stall the worker. Runs beyond 256 chars are split before encoding - counts
 * are approximate by design (they only gate the FR-2.1 soft threshold), and
 * nothing ever derives text offsets from token math.
 */
const LONG_RUN = /\S{257,}/gu;

function tame(text: string): string {
  return text.replaceAll(LONG_RUN, (run) => run.match(/.{1,256}/gsu)?.join(" ") ?? run);
}

/**
 * o200k_base as a model-agnostic approximation (pure JS - no second WASM in
 * the test pool). A ±10% mismatch vs the embedding vendor's tokenizer is
 * immaterial at a 1,200-token budget.
 */
export function countTokens(text: string): number {
  return enc().encode(tame(text)).length;
}
