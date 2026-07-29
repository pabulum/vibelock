import type { TimeWindow } from "../api/deadlock";
import { PRIOR_WINDOW_S } from "./patchBlend";
import type { Patch } from "../types";

/** Time window for a chosen patch index. Patches are newest-first. */
export function windowFor(patches: Patch[], idx: number): TimeWindow {
  if (!patches[idx]) return {};
  return {
    minUnixTimestamp: patches[idx].ts,
    maxUnixTimestamp: idx > 0 ? patches[idx - 1].ts : undefined,
  };
}

/** The borrow window that backfills a young patch: the month *before* the patch dropped. This is
 * where the old "Last 30 days" default went — instead of mixing patches at full weight, the
 * pre-patch month enters the build as a capped, drift-discounted prior (see lib/patchBlend). */
export function priorWindowFor(patches: Patch[], idx: number): TimeWindow {
  if (!patches[idx]) return {};
  return {
    minUnixTimestamp: patches[idx].ts - PRIOR_WINDOW_S,
    maxUnixTimestamp: patches[idx].ts,
  };
}

/** Wall clock at page load. The comparator window below is defined against "now", and "now" has to
 * hold still: it lands in a query key, so a live clock would re-key the whole build fan-out on
 * every render. Reading it once a session is enough — a session left open for days ends up with a
 * comparator slightly shorter than the post-patch window, which costs a little power but keeps the
 * property that matters, that the comparison is against the time immediately before the patch. */
export const SESSION_NOW_S = Math.floor(Date.now() / 1000);

/**
 * The comparator window for the patch movers (lib/patchMovers): the same span of time immediately
 * *before* the patch as the patch has covered so far.
 *
 * The borrow window above is the wrong comparator for "did this patch change it", and measurably so
 * — it is a *mean over a month*, so anything already trending reads as a patch jump. Measured on
 * 07-28-2026: Abrams' Weighted Shots showed 17% pick over the prior 30 days against 27% after the
 * patch, which looks like a decisive breakout until you notice it was already at 27% in the three
 * days *before* the patch. Pick rates drift far too much over a month to be compared against their
 * own monthly average. Equal spans also give the two sides comparable power, which is what the
 * two-proportion tests downstream assume, and they keep the comparison honest as the patch ages:
 * the window grows with the patch instead of staying a fixed month.
 *
 * `nowSec` decides the span only for the newest patch — the one still running; every older patch
 * ends where the next one begins. Capped at the borrow window because past a month the question is
 * stale, and a comparator from two months ago measures drift rather than the patch.
 */
export function moversWindowFor(
  patches: Patch[],
  idx: number,
  nowSec: number,
): TimeWindow {
  const patch = patches[idx];
  if (!patch) return {};
  const end = idx > 0 ? patches[idx - 1].ts : nowSec;
  const span = Math.min(PRIOR_WINDOW_S, Math.max(0, end - patch.ts));
  return {
    minUnixTimestamp: patch.ts - span,
    maxUnixTimestamp: patch.ts,
  };
}
