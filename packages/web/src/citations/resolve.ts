/**
 * Resolves a citation to rectangles on a page.
 *
 * This is the piece the whole citation promise rests on, so it is worth being
 * explicit about what it does and does not do.
 *
 * It never touches text. Every operation is integer arithmetic on the character
 * offsets frozen at parse time, or float arithmetic on rectangles. ADR-0005
 * permits downstream code to *slice* canonical text and nothing else; this does
 * not even slice. `verbatimAnchor` is carried for display and is never used to
 * find anything - searching a rendered text layer for the anchor is precisely
 * the quote-matching ADR-0006 and ADR-0007 exist to forbid, and its failure
 * mode is highlighting a different occurrence of the same phrase, which is
 * worse than highlighting nothing.
 *
 * The sidecar carries geometry at block granularity. When a citation covers
 * whole blocks - which is every flag citation, because clauses are segmented on
 * block boundaries - the rectangles are exact. When it covers part of a block,
 * they are interpolated from the block's own geometry and *labelled* as
 * approximate, because the alternative would be re-deriving per-line offsets by
 * repeating the parser's transforms on text we do not have. A visibly
 * approximate highlight next to an exact clause-text panel is honest; a
 * confidently wrong one is not.
 */
import { type DocumentLayout, type LayoutBlock } from "@contractix/shared/schemas";

import { type CitationTarget } from "./types.js";

export interface PointRect {
  /** PDF points, page-box relative, y increasing downwards (as the parser stores them). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** False when the rectangle was interpolated inside a block. */
  exact: boolean;
}

export interface HighlightPage {
  page: number;
  rects: PointRect[];
}

export type HighlightStatus =
  /** Rectangles resolved. */
  | "ok"
  /** A whole-clause citation whose clause has not been loaded yet. */
  | "loading"
  /** DOCX, or a document ingested before the sidecar existed. */
  | "no-geometry"
  /** The document has geometry, but not for this span - a page that failed to parse. */
  | "no-geometry-for-span"
  /** A degenerate span. */
  | "empty";

export interface HighlightPlan {
  status: HighlightStatus;
  /** True when any rectangle was interpolated rather than taken from a block. */
  approximate: boolean;
  pages: HighlightPage[];
  /** Where the viewer should scroll; null unless status is "ok". */
  primaryPage: number | null;
  span: { start: number; end: number } | null;
}

export interface ResolveOptions {
  /**
   * `"line"` interpolates within a partially covered block; `"block"` highlights
   * the whole block instead. One switch, both behaviours pinned by tests, so the
   * estimator can be turned off in one place if it ever misbehaves.
   */
  granularity?: "line" | "block";
}

/** A clause, for the whole-clause case where the citation carries no sub-span. */
export interface ClauseSpan {
  charStart: number;
  charEnd: number;
}

const MIN_LINE_HEIGHT_PT = 6;
const MAX_LINE_HEIGHT_PT = 30;
const MAX_LINES_PER_BLOCK = 60;
/** Rectangles closer than this on both axes are merged. */
const MERGE_TOLERANCE_PT = 1;

function plan(status: HighlightStatus, span: { start: number; end: number } | null): HighlightPlan {
  return { status, approximate: false, pages: [], primaryPage: null, span };
}

/**
 * A robust stand-in for the line height on a page: the 20th percentile of block
 * heights, so one tall title block cannot drag the estimate up. Falls back to
 * the block's own height when a page has too few blocks to say anything.
 */
function estimateLineHeight(layout: DocumentLayout, page: number, fallback: number): number {
  const heights = layout.blocks
    .filter((b) => b.page === page)
    .map((b) => b.height)
    .sort((a, b) => a - b);

  if (heights.length < 3) return fallback;
  const value = heights[Math.min(Math.floor(heights.length * 0.2), heights.length - 1)];
  if (value === undefined) return fallback;
  return Math.min(MAX_LINE_HEIGHT_PT, Math.max(MIN_LINE_HEIGHT_PT, value));
}

/** Rectangles for the part of `block` between `from` and `to` (absolute offsets). */
function rectsForPartialBlock(
  block: LayoutBlock,
  from: number,
  to: number,
  layout: DocumentLayout,
  granularity: "line" | "block",
): PointRect[] {
  if (granularity === "block") {
    return [{ x: block.x, y: block.y, width: block.width, height: block.height, exact: false }];
  }

  const length = block.charEnd - block.charStart;
  if (length <= 0) {
    return [{ x: block.x, y: block.y, width: block.width, height: block.height, exact: false }];
  }

  const startFraction = (from - block.charStart) / length;
  const endFraction = (to - block.charStart) / length;

  const lineHeight = estimateLineHeight(layout, block.page, block.height);
  const lines = Math.min(MAX_LINES_PER_BLOCK, Math.max(1, Math.round(block.height / lineHeight)));

  if (lines === 1) {
    // Proportional along a single line. Off by a character or two with a
    // proportional font, but never off the line.
    return [
      {
        x: block.x + startFraction * block.width,
        y: block.y,
        width: (endFraction - startFraction) * block.width,
        height: block.height,
        exact: false,
      },
    ];
  }

  const bandHeight = block.height / lines;
  const firstLine = Math.floor(startFraction * lines);
  const lastLine = Math.min(lines - 1, Math.ceil(endFraction * lines) - 1);

  if (firstLine >= lastLine) {
    return [
      {
        x: block.x + startFraction * block.width,
        y: block.y + firstLine * bandHeight,
        width: Math.max(0, (endFraction - startFraction) * block.width),
        height: bandHeight,
        exact: false,
      },
    ];
  }

  const rects: PointRect[] = [];
  const startOffset = (startFraction * lines - firstLine) * block.width;
  rects.push({
    x: block.x + startOffset,
    y: block.y + firstLine * bandHeight,
    width: block.width - startOffset,
    height: bandHeight,
    exact: false,
  });

  for (let line = firstLine + 1; line < lastLine; line += 1) {
    rects.push({
      x: block.x,
      y: block.y + line * bandHeight,
      width: block.width,
      height: bandHeight,
      exact: false,
    });
  }

  rects.push({
    x: block.x,
    y: block.y + lastLine * bandHeight,
    width: (endFraction * lines - lastLine) * block.width,
    height: bandHeight,
    exact: false,
  });

  return rects;
}

/**
 * Unions vertically adjacent rectangles that occupy the same column, so a
 * multi-block clause does not render as a stack of stripes.
 *
 * Same column is required, not merely overlapping: a partial first line starts
 * part-way across, and unioning it with the full-width line below would extend
 * the highlight over text the citation does not cover. A merge that adds area
 * is not a merge, it is a wrong answer.
 */
function merge(rects: PointRect[]): PointRect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: PointRect[] = [];

  for (const rect of sorted) {
    const previous = out[out.length - 1];
    if (previous === undefined) {
      out.push({ ...rect });
      continue;
    }

    const mergeable =
      previous.exact === rect.exact &&
      // Same column, not merely overlapping.
      Math.abs(previous.x - rect.x) <= MERGE_TOLERANCE_PT &&
      Math.abs(previous.width - rect.width) <= MERGE_TOLERANCE_PT &&
      // Vertically adjacent or touching.
      rect.y <= previous.y + previous.height + MERGE_TOLERANCE_PT &&
      rect.y + rect.height >= previous.y - MERGE_TOLERANCE_PT;

    if (!mergeable) {
      out.push({ ...rect });
      continue;
    }

    const bottom = Math.max(previous.y + previous.height, rect.y + rect.height);
    previous.y = Math.min(previous.y, rect.y);
    previous.height = bottom - previous.y;
  }

  return out;
}

export function resolveHighlights(
  target: CitationTarget,
  layout: DocumentLayout,
  clause?: ClauseSpan,
  options: ResolveOptions = {},
): HighlightPlan {
  // Step 0 - the span. An extraction citation resolved a verbatim anchor to an
  // exact sub-range; a flag cites a whole clause and carries none, so the
  // clause's own frozen offsets are the span.
  let span: { start: number; end: number } | null = null;
  if (target.charStart !== null && target.charEnd !== null) {
    span = { start: target.charStart, end: target.charEnd };
  } else if (clause) {
    span = { start: clause.charStart, end: clause.charEnd };
  } else {
    return plan("loading", null);
  }

  if (span.end <= span.start) return plan("empty", span);
  if (!layout.geometry) return plan("no-geometry", span);

  // Step 1 - blocks overlapping the span, half-open. Blocks are disjoint and
  // monotone by construction, and the newline joining them belongs to no block,
  // so a clause-wide span selects exactly its own blocks.
  const hits = layout.blocks
    .filter((block) => block.charEnd > span.start && block.charStart < span.end)
    .map((block) => ({
      block,
      from: Math.max(span.start, block.charStart),
      to: Math.min(span.end, block.charEnd),
    }))
    .filter((hit) => hit.to > hit.from)
    .sort((a, b) => a.block.page - b.block.page || a.block.charStart - b.block.charStart);

  if (hits.length === 0) return plan("no-geometry-for-span", span);

  // Step 2 - rectangles, exact where the span covers a whole block.
  const byPage = new Map<number, PointRect[]>();
  let approximate = false;

  for (const { block, from, to } of hits) {
    const whole = from === block.charStart && to === block.charEnd;
    const rects = whole
      ? [{ x: block.x, y: block.y, width: block.width, height: block.height, exact: true }]
      : rectsForPartialBlock(block, from, to, layout, options.granularity ?? "line");

    if (!whole) approximate = true;
    const existing = byPage.get(block.page);
    if (existing) existing.push(...rects);
    else byPage.set(block.page, [...rects]);
  }

  // Step 3 - group by page; a span crossing a page break is ordinary for a clause.
  const pages: HighlightPage[] = [...byPage.entries()]
    .map(([page, rects]) => ({ page, rects: merge(rects) }))
    .sort((a, b) => a.page - b.page);

  const primaryPage = pages[0]?.page ?? null;
  return { status: "ok", approximate, pages, primaryPage, span };
}
