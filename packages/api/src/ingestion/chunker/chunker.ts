import { countTokens } from "./tokens.js";

export interface ClauseChunk {
  chunkIndex: number;
  text: string;
  /** absolute canonical-text offsets (clause offset + local position) */
  charStart: number;
  charEnd: number;
  tokenCount: number;
}

export interface ChunkOptions {
  maxTokens?: number;
  overlapTokens?: number;
}

/** FR-2.1: chunk = clause; split only past maxTokens, with ~overlap tokens. */
const DEFAULT_MAX = 1_200;
const DEFAULT_OVERLAP = 100;

/**
 * Boundaries are char positions where a new unit may start: paragraph breaks
 * first, then sentence ends. Splitting picks among these so chunk text is
 * always an exact slice - offsets never drift (ADR-0005).
 */
function unitBoundaries(text: string): number[] {
  const set = new Set<number>([0]);
  for (const m of text.matchAll(/\n+/g)) {
    set.add(m.index + m[0].length);
  }
  for (const m of text.matchAll(/[.!?:;]\s+/g)) {
    set.add(m.index + m[0].length);
  }
  set.add(text.length);
  return [...set].sort((a, b) => a - b);
}

/** Largest boundary index e such that tokens(text[startPos, boundary[e])) fits. */
function extendWhileFits(
  text: string,
  boundaries: number[],
  startIdx: number,
  maxTokens: number,
): number {
  let end = startIdx + 1;
  while (end + 1 < boundaries.length) {
    const candidate = boundaries[end + 1];
    const start = boundaries[startIdx];
    if (candidate === undefined || start === undefined) break;
    if (countTokens(text.slice(start, candidate)) > maxTokens) break;
    end++;
  }
  return end;
}

/**
 * Hard cut inside one oversized unit: start from a generous char window and
 * shrink geometrically until it fits. countTokens is linear-time (tamed BPE),
 * so the whole loop is a handful of cheap encodes.
 */
function hardCut(text: string, from: number, to: number, maxTokens: number): number {
  let cut = Math.min(to, from + maxTokens * 4);
  while (cut > from + 16 && countTokens(text.slice(from, cut)) > maxTokens) {
    cut = from + Math.floor((cut - from) * 0.75);
  }
  return Math.max(cut, from + 1);
}

export function chunkClause(
  clauseText: string,
  clauseCharStart: number,
  opts: ChunkOptions = {},
): ClauseChunk[] {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX;
  const overlapTokens = opts.overlapTokens ?? DEFAULT_OVERLAP;

  const total = countTokens(clauseText);
  if (total <= maxTokens) {
    return [
      {
        chunkIndex: 0,
        text: clauseText,
        charStart: clauseCharStart,
        charEnd: clauseCharStart + clauseText.length,
        tokenCount: total,
      },
    ];
  }

  const boundaries = unitBoundaries(clauseText);
  const chunks: ClauseChunk[] = [];
  let startIdx = 0;

  while (true) {
    const start = boundaries[startIdx];
    if (start === undefined || start >= clauseText.length) break;

    const endIdx = extendWhileFits(clauseText, boundaries, startIdx, maxTokens);
    let end = boundaries[endIdx];
    if (end === undefined) break;

    // No token can approach 32 chars in real text: spans past this bound are
    // over budget without paying for an encode of the whole (possibly
    // adversarial) unit.
    const definitelyOver = end - start > maxTokens * 32;
    if (end <= start || definitelyOver || countTokens(clauseText.slice(start, end)) > maxTokens) {
      // The single unit [start, nextBoundary) alone exceeds the budget.
      const cut = hardCut(clauseText, start, end <= start ? clauseText.length : end, maxTokens);
      boundaries.splice(endIdx, 0, cut);
      end = cut;
    }

    const text = clauseText.slice(start, end);
    chunks.push({
      chunkIndex: chunks.length,
      text,
      charStart: clauseCharStart + start,
      charEnd: clauseCharStart + end,
      tokenCount: countTokens(text),
    });

    if (end >= clauseText.length) break;

    // Overlap: next chunk starts at the earliest boundary inside the emitted
    // chunk whose suffix fits the overlap budget; fall back to no overlap
    // rather than failing to make progress.
    let nextIdx = endIdx;
    for (let b = startIdx + 1; b < endIdx; b++) {
      const pos = boundaries[b];
      if (pos === undefined) continue;
      if (countTokens(clauseText.slice(pos, end)) <= overlapTokens) {
        nextIdx = b;
        break;
      }
    }
    startIdx = nextIdx > startIdx ? nextIdx : endIdx;
  }

  return chunks;
}
