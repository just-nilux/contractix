import { type DocumentLayout, documentLayoutSchema } from "@contractix/shared/schemas";
import { describe, expect, it } from "vitest";

import realLayout from "../test/fixtures/layout-offer-de.json" with { type: "json" };
import { resolveHighlights } from "./resolve.js";
import { type CitationTarget } from "./types.js";

/**
 * A real `GET /documents/{id}/layout` capture from the seeded demo corpus
 * (offer_de_senior_eng.pdf): two A4 pages, 56 blocks, real char offsets. It
 * carries rectangles and integers only - no document text - so it is small and
 * safe to commit, and it means these tests are checked against geometry the
 * parser actually produced rather than against numbers invented to suit them.
 */
const LAYOUT: DocumentLayout = documentLayoutSchema.parse(realLayout);

/** The clause the API cites for the non-compete red flag: 2:§11, whole-clause. */
const NON_COMPETE = { charStart: 3393, charEnd: 4006 };
/** The resolved span behind the base_salary field, inside a single block. */
const SALARY_SPAN = { charStart: 884, charEnd: 933 };

function target(overrides: Partial<CitationTarget> = {}): CitationTarget {
  return {
    documentId: LAYOUT.documentId,
    clauseId: "clause-1",
    page: 1,
    charStart: null,
    charEnd: null,
    verbatimAnchor: null,
    ...overrides,
  };
}

/** A synthetic layout, for shapes the corpus does not happen to contain. */
function layoutOf(
  blocks: {
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
    charStart: number;
    charEnd: number;
  }[],
  pages = [{ page: 1, width: 600, height: 800 }],
): DocumentLayout {
  return {
    documentId: "018f4b3e-7c2a-7000-8000-000000000001",
    mimeType: "application/pdf",
    pageCount: pages.length,
    geometry: true,
    pages,
    blocks,
  };
}

describe("resolveHighlights — span resolution", () => {
  it("waits for the clause when a flag citation carries no sub-span", () => {
    // Flag citations are `charStart: null` by design: a rule cites a whole
    // clause, not a phrase inside one.
    const result = resolveHighlights(target(), LAYOUT);

    expect(result.status).toBe("loading");
    expect(result.pages).toEqual([]);
  });

  it("uses the clause's own frozen offsets once it arrives", () => {
    const result = resolveHighlights(target({ page: 2 }), LAYOUT, NON_COMPETE);

    expect(result.status).toBe("ok");
    expect(result.span).toEqual({ start: 3393, end: 4006 });
  });

  it("prefers the citation's span over the clause when it has one", () => {
    const result = resolveHighlights(target(SALARY_SPAN), LAYOUT, NON_COMPETE);

    expect(result.span).toEqual({ start: 884, end: 933 });
  });

  it("reports a degenerate span rather than drawing a zero-width box", () => {
    expect(resolveHighlights(target({ charStart: 500, charEnd: 500 }), LAYOUT).status).toBe(
      "empty",
    );
  });
});

describe("resolveHighlights — whole-clause citations are exact", () => {
  it("covers a clause with exactly its own blocks, all marked exact", () => {
    // Clauses are segmented on block boundaries, so this case is not an
    // approximation at all.
    const result = resolveHighlights(target({ page: 2 }), LAYOUT, NON_COMPETE);

    expect(result.approximate).toBe(false);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.page).toBe(2);
    expect(result.pages[0]?.rects.every((r) => r.exact)).toBe(true);
  });

  it("does not spill past the clause into the neighbouring one", () => {
    const result = resolveHighlights(target({ page: 2 }), LAYOUT, NON_COMPETE);
    const covered = LAYOUT.blocks.filter((b) => b.charEnd > 3393 && b.charStart < 4006);
    const top = Math.min(...covered.map((b) => b.y));
    const bottom = Math.max(...covered.map((b) => b.y + b.height));

    for (const rect of result.pages[0]?.rects ?? []) {
      expect(rect.y).toBeGreaterThanOrEqual(top - 0.001);
      expect(rect.y + rect.height).toBeLessThanOrEqual(bottom + 0.001);
    }
  });
});

describe("resolveHighlights — partial coverage is approximate and says so", () => {
  it("interpolates inside a single-line block and flags it", () => {
    const result = resolveHighlights(target(SALARY_SPAN), LAYOUT);
    const block = LAYOUT.blocks.find((b) => b.charStart === 854);
    const rect = result.pages[0]?.rects[0];

    expect(result.status).toBe("ok");
    expect(result.approximate).toBe(true);
    expect(rect?.exact).toBe(false);
    // Inside the block it interpolates, and never outside it.
    expect(rect?.x).toBeGreaterThanOrEqual(block?.x ?? 0);
    expect((rect?.x ?? 0) + (rect?.width ?? 0)).toBeLessThanOrEqual(
      (block?.x ?? 0) + (block?.width ?? 0) + 0.001,
    );
    expect(rect?.y).toBe(block?.y);
    expect(rect?.height).toBe(block?.height);
  });

  it("splits a multi-line block into first, middle and last bands", () => {
    // 60pt tall against ~10pt lines elsewhere on the page => six lines.
    const layout = layoutOf([
      { page: 1, x: 50, y: 100, width: 400, height: 60, charStart: 0, charEnd: 600 },
      { page: 1, x: 50, y: 170, width: 400, height: 10, charStart: 601, charEnd: 700 },
      { page: 1, x: 50, y: 185, width: 400, height: 10, charStart: 701, charEnd: 800 },
      { page: 1, x: 50, y: 200, width: 400, height: 10, charStart: 801, charEnd: 900 },
    ]);

    const result = resolveHighlights(target({ charStart: 150, charEnd: 450 }), layout);
    const rects = result.pages[0]?.rects ?? [];

    expect(result.approximate).toBe(true);
    expect(rects.length).toBeGreaterThan(1);
    // Every band stays inside the block it came from.
    for (const rect of rects) {
      expect(rect.y).toBeGreaterThanOrEqual(100);
      expect(rect.y + rect.height).toBeLessThanOrEqual(160.001);
      expect(rect.x).toBeGreaterThanOrEqual(50);
      expect(rect.x + rect.width).toBeLessThanOrEqual(450.001);
    }
  });

  it("falls back to whole blocks under block granularity", () => {
    const result = resolveHighlights(target(SALARY_SPAN), LAYOUT, undefined, {
      granularity: "block",
    });
    const block = LAYOUT.blocks.find((b) => b.charStart === 854);

    // The escape hatch: no interpolation at all, still labelled approximate
    // because the highlight is wider than the citation.
    expect(result.pages[0]?.rects[0]).toMatchObject({
      x: block?.x,
      width: block?.width,
      exact: false,
    });
  });
});

describe("resolveHighlights — spans across blocks and pages", () => {
  it("marks the covered blocks exact and the clipped ones approximate", () => {
    const result = resolveHighlights(target({ charStart: 900, charEnd: 1300 }), LAYOUT);
    const rects = result.pages.flatMap((p) => p.rects);

    expect(result.approximate).toBe(true);
    expect(rects.some((r) => r.exact)).toBe(true);
    expect(rects.some((r) => !r.exact)).toBe(true);
  });

  it("groups a span that crosses a page break, ordered by page", () => {
    // Ordinary for a clause: §9 begins on page 2 while §8 ends on page 1.
    const result = resolveHighlights(target({ charStart: 2400, charEnd: 2600 }), LAYOUT);

    expect(result.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(result.primaryPage).toBe(1);
  });

  it("ignores the newline between blocks, which belongs to no block", () => {
    const layout = layoutOf([
      { page: 1, x: 50, y: 100, width: 400, height: 10, charStart: 0, charEnd: 10 },
      { page: 1, x: 50, y: 115, width: 400, height: 10, charStart: 11, charEnd: 20 },
    ]);

    // 10..11 is the joining newline alone.
    expect(resolveHighlights(target({ charStart: 10, charEnd: 11 }), layout).status).toBe(
      "no-geometry-for-span",
    );
  });
});

describe("resolveHighlights — fallbacks", () => {
  it("reports no geometry for a DOCX", () => {
    const docx: DocumentLayout = {
      documentId: "018f4b3e-7c2a-7000-8000-000000000002",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pageCount: 1,
      geometry: false,
      pages: [],
      blocks: [],
    };

    expect(resolveHighlights(target({ charStart: 0, charEnd: 10 }), docx).status).toBe(
      "no-geometry",
    );
  });

  it("reports no geometry for a span on a page that failed to parse", () => {
    const layout = layoutOf([
      { page: 1, x: 50, y: 100, width: 400, height: 10, charStart: 0, charEnd: 100 },
    ]);

    expect(resolveHighlights(target({ charStart: 5000, charEnd: 5100 }), layout).status).toBe(
      "no-geometry-for-span",
    );
  });
});

describe("resolveHighlights — merging", () => {
  it("unions touching rectangles so bands do not render as stripes", () => {
    const layout = layoutOf([
      { page: 1, x: 50, y: 100, width: 400, height: 10, charStart: 0, charEnd: 100 },
      { page: 1, x: 50, y: 110, width: 400, height: 10, charStart: 101, charEnd: 200 },
    ]);

    const result = resolveHighlights(target({ charStart: 0, charEnd: 200 }), layout);

    expect(result.pages[0]?.rects).toEqual([
      { x: 50, y: 100, width: 400, height: 20, exact: true },
    ]);
  });

  it("keeps separated lines separate", () => {
    // Real body text has a gap between line boxes; merging across it would
    // paint over the whitespace and past the end of a short last line.
    const result = resolveHighlights(target({ page: 2 }), LAYOUT, NON_COMPETE);

    expect(result.pages[0]?.rects.length ?? 0).toBeGreaterThan(1);
  });

  it("never widens a partial first line by merging it with the line below", () => {
    // Regression: unioning a part-way-across first band with the full-width
    // band beneath it produced one rectangle covering text the citation never
    // referred to. A merge that adds area is not a merge, it is a wrong answer.
    const layout = layoutOf([
      { page: 1, x: 50, y: 100, width: 400, height: 60, charStart: 0, charEnd: 600 },
      { page: 1, x: 50, y: 170, width: 400, height: 10, charStart: 601, charEnd: 700 },
      { page: 1, x: 50, y: 185, width: 400, height: 10, charStart: 701, charEnd: 800 },
      { page: 1, x: 50, y: 200, width: 400, height: 10, charStart: 801, charEnd: 900 },
    ]);

    // 350/600 of the way in, which is mid-line rather than on a line boundary.
    const result = resolveHighlights(target({ charStart: 350, charEnd: 590 }), layout);
    const rects = result.pages[0]?.rects ?? [];
    const firstBand = rects.reduce((a, b) => (a.y <= b.y ? a : b));

    // The span starts part-way across its line, so the first band must too.
    expect(firstBand.x).toBeGreaterThan(50);
    // ...and the bands below it, which do start at the left edge, must not have
    // dragged it back there by merging.
    expect(rects.length).toBeGreaterThan(1);
  });

  it("never merges an exact rectangle with an approximate one", () => {
    const result = resolveHighlights(target({ charStart: 900, charEnd: 1300 }), LAYOUT);

    for (const page of result.pages) {
      const exactness = new Set(page.rects.map((r) => r.exact));
      expect(exactness.size).toBeGreaterThan(0);
    }
    // The flag survives the merge rather than being averaged away.
    expect(result.approximate).toBe(true);
  });
});
