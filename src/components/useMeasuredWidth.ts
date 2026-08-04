import { useEffect, useRef, useState } from "react";

/**
 * The element's width in CSS pixels, tracked with a ResizeObserver.
 *
 * For an SVG chart that has to fill a container of unknown width. The tempting alternative —
 * `preserveAspectRatio="none"` — is wrong in three ways at once: it stretches text glyphs, turns
 * circles into ellipses, and rescales the x axis independently of y, so the same data draws a
 * different slope in a narrow column than in a wide one. The last is a claim about the data, not a
 * matter of taste. Measuring instead keeps the viewBox at 1:1 with the viewport, so nothing scales
 * at all and the geometry means what it says at every width.
 *
 * Returns `fallback` until the first measurement lands (and forever without a ResizeObserver), so
 * the first paint is a sensibly-sized chart rather than a collapsed one.
 */
export function useMeasuredWidth<T extends Element>(fallback: number) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      // A hidden or not-yet-laid-out element measures 0; keeping the last good width avoids
      // rebuilding every path against a degenerate viewBox.
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}
