import { describe, expect, it } from "vitest";

import {
  geometryIsTrustworthy,
  MAX_SCALE_DISAGREEMENT,
  pageScale,
  scaleDisagreement,
  toCssRect,
} from "./geometry.js";
import { type PointRect } from "./resolve.js";

/** A4 in points, which is what the demo corpus reports. */
const A4 = { page: 1, width: 595.92, height: 842.88 };

const rect: PointRect = { x: 62, y: 326, width: 478, height: 9, exact: false };

describe("pageScale", () => {
  it("derives the factor from the width actually rendered", () => {
    expect(pageScale(1191.84, A4)).toBeCloseTo(2, 6);
    expect(pageScale(595.92, A4)).toBeCloseTo(1, 6);
  });

  it("returns zero rather than Infinity for a degenerate page", () => {
    expect(pageScale(800, { page: 1, width: 0, height: 800 })).toBe(0);
  });
});

describe("toCssRect", () => {
  it("scales a point rectangle into pixels", () => {
    expect(toCssRect(rect, 2)).toEqual({ left: 124, top: 652, width: 956, height: 18 });
  });

  it("is a pure re-multiply, so zoom never needs a re-resolve", () => {
    const atOne = toCssRect(rect, 1);
    const atThree = toCssRect(rect, 3);

    expect(atThree.left / atOne.left).toBeCloseTo(3, 6);
    expect(atThree.height / atOne.height).toBeCloseTo(3, 6);
  });
});

describe("scaleDisagreement", () => {
  it("is zero when the renderer and the parser agree about the page box", () => {
    // mupdf's getBounds() and pdf.js's viewport both apply /Rotate, so on a
    // well-formed document these already agree and no rotation matrix is needed.
    expect(scaleDisagreement({ width: 1191.84, height: 1685.76 }, A4)).toBeCloseTo(0, 6);
  });

  it("catches a page box the two sides disagree about", () => {
    // e.g. a CropBox/MediaBox mismatch, or a rotation only one side applied.
    expect(scaleDisagreement({ width: 1191.84, height: 1191.84 }, A4)).toBeGreaterThan(
      MAX_SCALE_DISAGREEMENT,
    );
  });

  it("tolerates sub-pixel rounding in the rendered size", () => {
    expect(geometryIsTrustworthy({ width: 595.92, height: 843.1 }, A4)).toBe(true);
  });

  it("refuses to vouch for a degenerate page", () => {
    expect(
      geometryIsTrustworthy({ width: 100, height: 100 }, { page: 1, width: 0, height: 0 }),
    ).toBe(false);
  });
});
