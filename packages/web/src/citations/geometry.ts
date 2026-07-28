/**
 * PDF points to rendered CSS pixels.
 *
 * The scale is derived from what was *actually rendered*, not from the viewer's
 * `scale` prop: the prop is an input to rendering, while the overlay has to line
 * up with its output, and the two diverge the moment a container resizes or the
 * device pixel ratio changes.
 *
 * Rotation needs no matrix here, and that is a checked claim rather than a
 * hopeful one. mupdf's `page.getBounds()` returns the *rotated* page box and its
 * structured-text coordinates live in that same space; pdf.js applies `/Rotate`
 * to its viewport too. So both sides already agree, and `scaleDisagreement`
 * exists to catch the case where they do not - a CropBox/MediaBox mismatch, an
 * unusual rotation, or a future parser change - so the viewer can fall back to
 * the exact clause-text panel instead of drawing a rectangle in the wrong place.
 */
import { type LayoutPage } from "@contractix/shared/schemas";

import { type PointRect } from "./resolve.js";

export interface CssRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Uniform points-to-pixels factor for a page rendered at `renderedWidthPx`. */
export function pageScale(renderedWidthPx: number, page: LayoutPage): number {
  if (page.width <= 0) return 0;
  return renderedWidthPx / page.width;
}

export function toCssRect(rect: PointRect, scale: number): CssRect {
  return {
    left: rect.x * scale,
    top: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/**
 * Relative difference between the horizontal and vertical scales implied by a
 * rendered viewport. Zero when the parser and the renderer agree about the page
 * box; anything above a couple of percent means they do not, and the caller
 * should stop trusting the rectangles.
 */
export function scaleDisagreement(
  viewport: { width: number; height: number },
  page: LayoutPage,
): number {
  if (page.width <= 0 || page.height <= 0) return Infinity;
  const sx = viewport.width / page.width;
  const sy = viewport.height / page.height;
  if (sx === 0) return Infinity;
  return Math.abs(sx - sy) / sx;
}

/** Above this, the overlay is suppressed in favour of the clause-text panel. */
export const MAX_SCALE_DISAGREEMENT = 0.02;

export function geometryIsTrustworthy(
  viewport: { width: number; height: number },
  page: LayoutPage,
): boolean {
  return scaleDisagreement(viewport, page) <= MAX_SCALE_DISAGREEMENT;
}
