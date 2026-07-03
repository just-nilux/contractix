import { type Block, buildClauseRef } from "@contractix/shared";

import { matchHeading, type HeadingMatch } from "./patterns.js";

export interface SegmentedClause {
  clausePath: string;
  clauseRef: string;
  heading: string | null;
  headingPath: string[];
  page: number;
  charStart: number;
  charEnd: number;
  text: string;
  seq: number;
}

/** Blocks that may open a clause. Long paragraphs still qualify: inline-numbered
 *  clauses ("2.1 Liquidation Preference. In the event ...") are the norm in
 *  term sheets. Table cells and list items never open clauses (FR-1.3: clause
 *  granularity stops at numbered headings). */
function candidateMatch(block: Block): HeadingMatch | null {
  if (block.type === "table_cell" || block.type === "list_item" || block.type === "footer") {
    return null;
  }
  return matchHeading(block.text);
}

interface Boundary {
  blockIndex: number;
  match: HeadingMatch | null; // null only for the synthetic fallback boundaries
  syntheticPath?: string;
}

function dedupePath(path: string, used: Set<string>): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  let n = 2;
  while (used.has(`${path}-${n}`)) n++;
  const deduped = `${path}-${n}`;
  used.add(deduped);
  return deduped;
}

/**
 * Pure segmentation: (blocks, canonical) -> clauses tiling the canonical text.
 * Invariant (tested): clauses cover every character exactly once, in order.
 */
export function segmentClauses(blocks: readonly Block[], canonical: string): SegmentedClause[] {
  if (blocks.length === 0) return [];

  let boundaries: Boundary[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) continue;
    const match = candidateMatch(block);
    if (match) boundaries.push({ blockIndex: i, match });
  }

  if (boundaries.length === 0) {
    boundaries = fallbackBoundaries(blocks);
  }

  const clauses: SegmentedClause[] = [];
  const used = new Set<string>();

  // Scope handling: an annex opens a fresh numbering scope; heading stack is
  // (depth, label) within the scope for heading_path construction.
  let scopePrefix = "";
  let scopeHeading: string | null = null;
  let stack: { depth: number; label: string }[] = [];

  const pushClause = (
    startBlock: Block,
    endChar: number,
    path: string,
    heading: string | null,
    headingPath: string[],
  ) => {
    const clausePath = dedupePath(path, used);
    clauses.push({
      clausePath,
      clauseRef: buildClauseRef(startBlock.page, clausePath),
      heading,
      headingPath,
      page: startBlock.page,
      charStart: startBlock.charStart,
      charEnd: endChar,
      text: canonical.slice(startBlock.charStart, endChar),
      seq: clauses.length,
    });
  };

  const first = boundaries[0];
  if (first) {
    const firstBlock = blocks[first.blockIndex];
    if (firstBlock && firstBlock.charStart > 0) {
      const frontEnd = firstBlock.charStart - 1; // exclude the joining \n
      const frontBlock = blocks[0];
      if (frontBlock) pushClause(frontBlock, frontEnd, "front-matter", null, []);
    }
  }

  for (let b = 0; b < boundaries.length; b++) {
    const boundary = boundaries[b];
    if (!boundary) continue;
    const startBlock = blocks[boundary.blockIndex];
    if (!startBlock) continue;
    const next = boundaries[b + 1];
    const nextBlock = next ? blocks[next.blockIndex] : undefined;
    const endChar = nextBlock ? nextBlock.charStart - 1 : canonical.length;

    const m = boundary.match;
    if (!m) {
      pushClause(startBlock, endChar, boundary.syntheticPath ?? `seq-${b + 1}`, null, []);
      continue;
    }

    if (m.opensScope) {
      scopePrefix = `${m.path}/`;
      scopeHeading = m.heading;
      stack = [];
      pushClause(startBlock, endChar, m.path, m.heading, [m.heading]);
      continue;
    }

    while (stack.length > 0 && (stack.at(-1)?.depth ?? 0) >= m.depth) stack.pop();
    stack.push({ depth: m.depth, label: m.heading });

    const headingPath = [...(scopeHeading ? [scopeHeading] : []), ...stack.map((s) => s.label)];
    pushClause(startBlock, endChar, `${scopePrefix}${m.path}`, m.heading, headingPath);
  }

  return clauses;
}

/**
 * Degraded-but-honest fallback (no legal numbering found): segment on
 * heading-typed blocks; failing that, windows of ~4 paragraphs. Synthetic
 * seq-N paths are deterministic from content order and stay citable.
 */
function fallbackBoundaries(blocks: readonly Block[]): Boundary[] {
  const headingIdx = blocks.flatMap((b, i) => (b.type === "heading" ? [i] : []));
  if (headingIdx.length > 0) {
    return headingIdx.map((blockIndex, n) => ({
      blockIndex,
      match: null,
      syntheticPath: `seq-${n + 1}`,
    }));
  }
  const WINDOW = 4;
  const out: Boundary[] = [];
  for (let i = 0, n = 1; i < blocks.length; i += WINDOW, n++) {
    out.push({ blockIndex: i, match: null, syntheticPath: `seq-${n}` });
  }
  return out;
}
