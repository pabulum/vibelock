import { flushSync } from "react-dom";

/** Runs a hero/rank switch inside a view transition, so the identity swap (portrait, phase
 * columns — the elements carrying `view-transition-name`s) cross-fades instead of popping.
 * This *composes with* the settle veil rather than replacing it: the transition covers the
 * instant, synchronous part of the switch (the ~250ms snapshot cross-fade), while the veil
 * still arms afterwards for the async part (the re-bake) and pulses when the data lands.
 * Straight call-through when unsupported or when the user prefers reduced motion. */
export function switchTransition(update: () => void) {
  if (
    !document.startViewTransition ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    update();
    return;
  }
  // flushSync so the DOM is fully updated inside the transition's capture callback.
  document.startViewTransition(() => flushSync(update));
}
