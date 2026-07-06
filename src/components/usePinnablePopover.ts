// Hover-or-tap popover wiring shared by the item shop card and the community-build preview.

import { useEffect, useState } from "react";

// Touch/coarse-pointer devices can't hover, so the portaled popovers — the shop card and the
// community-build preview, which together are the *learning* layer (what an item does, its stats
// and build paths, how a build overlaps ours) — would be unreachable on a phone. We detect that
// once: hover-capable devices keep the pure-hover tooltip; touch devices open on a *tap* instead.
// matchMedia's comma is an OR, so this is "no hover OR a coarse primary pointer".
export const CAN_HOVER =
  typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? true
    : !window.matchMedia("(hover: none), (pointer: coarse)").matches;

// Selectors of the portaled popovers, so the touch dismissal below doesn't treat a tap (or scroll)
// *inside* an open popover as a tap outside it.
const POPOVER_SEL = ".itemcard, .buildprev";

/** Gap between a popover and the element it's anchored to, in px. */
export const CARD_GAP = 10;

/**
 * Hover-or-tap popover wiring, shared by the item card and the community-build preview. Hover
 * devices open on mouseenter and close on mouseleave — the original pure tooltip, unchanged. Touch
 * devices ({@link CAN_HOVER} false) can't do that, so they open on a *tap* and pin it open until a
 * tap outside the trigger and popover, a page scroll, or Escape. `sticky` (true only on touch) lets
 * the popover become a real tappable/scrollable surface instead of a pass-through tooltip. Spread
 * `handlers` onto the trigger element (which `ref` must point at) and render the popover when
 * `anchor` is set, passing it `sticky`.
 */
export function usePinnablePopover<T extends HTMLElement>(ref: {
  current: T | null;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const open = () =>
    ref.current && setAnchor(ref.current.getBoundingClientRect());
  const close = () => setAnchor(null);

  useEffect(() => {
    if (CAN_HOVER || !anchor) return; // hover devices dismiss via mouseleave; nothing global to wire
    const inPopover = (t: EventTarget | null) =>
      t instanceof Element && !!t.closest(POPOVER_SEL);
    const onDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node) || inPopover(e.target))
        return;
      setAnchor(null);
    };
    const onScroll = (e: Event) => {
      if (!inPopover(e.target)) setAnchor(null); // scrolling within a tall popover keeps it open
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setAnchor(null);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, ref]);

  const handlers = CAN_HOVER
    ? { onMouseEnter: open, onMouseLeave: close }
    : { onClick: () => (anchor ? close() : open()) };
  return { anchor, handlers, sticky: !CAN_HOVER };
}
