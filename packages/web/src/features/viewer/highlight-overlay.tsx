import { type CssRect } from "../../citations/geometry.js";
import { toCssRect } from "../../citations/geometry.js";
import { type PointRect } from "../../citations/resolve.js";

/**
 * The cited span, drawn over the rendered page.
 *
 * A sibling of the canvas rather than something painted into it, so a zoom or a
 * container resize is a re-multiply of `scale` and never a re-resolve. Marked
 * `aria-hidden`: the accessible rendering of a citation is the clause text
 * beside it, not a positioned rectangle.
 *
 * Approximate rectangles are drawn differently on purpose. A dashed edge and a
 * lighter fill say "about here" - which is true, and is what makes it safe to
 * interpolate inside a block at all.
 */
export function HighlightOverlay({ rects, scale }: { rects: readonly PointRect[]; scale: number }) {
  if (rects.length === 0 || scale <= 0) return null;

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {rects.map((rect, index) => {
        const css: CssRect = toCssRect(rect, scale);
        return (
          <span
            key={`${String(rect.x)}:${String(rect.y)}:${String(index)}`}
            data-testid="citation-highlight"
            data-exact={rect.exact ? "true" : "false"}
            title={
              rect.exact
                ? undefined
                : "Approximate position within the line. The clause text beside it is exact."
            }
            className={
              rect.exact
                ? "absolute rounded-[2px] bg-citation/35 ring-1 ring-citation"
                : "absolute rounded-[2px] bg-citation/20 ring-1 ring-citation/70 ring-dashed"
            }
            style={{
              left: `${String(css.left)}px`,
              top: `${String(css.top)}px`,
              width: `${String(css.width)}px`,
              height: `${String(css.height)}px`,
            }}
          />
        );
      })}
    </div>
  );
}
