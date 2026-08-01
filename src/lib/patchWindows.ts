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

/**
 * How far back a window looking *before* a patch may reach: never past the start of the ranked
 * season that patch ran under (lib/patchFeed).
 *
 * The two windows below both borrow from before the patch, and both would otherwise reach across a
 * ranked reset. That reset re-scales `average_badge`, so the borrowed half of a rank-filtered query
 * answers about a different population than the fresh half — a blend that reads as patch drift and
 * isn't. Where a patch changes what an item *does*, a reset changes who the sample is; the blend's
 * contradiction discount is built for the first and blind to the second.
 *
 * Returns -Infinity for a patch predating the first season, i.e. no clamp at all.
 */
function seasonFloor(patch: Patch): number {
  return patch.season?.startTs ?? Number.NEGATIVE_INFINITY;
}

/** True when a window covers a non-zero span of time. A season boundary collapses the windows
 * below to nothing (there is no admissible time before it), and the caller has to switch the
 * borrowing off rather than issue the query: `{}` would silently mean the API's default last-30-
 * days, and min === max means an empty result dressed up as data. */
export function hasSpan(w: TimeWindow): boolean {
  return (
    w.minUnixTimestamp !== undefined &&
    (w.maxUnixTimestamp === undefined ||
      w.maxUnixTimestamp > w.minUnixTimestamp)
  );
}

/** The borrow window that backfills a young patch: the month *before* the patch dropped, clamped
 * at the season start (see {@link seasonFloor}). This is where the old "Last 30 days" default went
 * — instead of mixing patches at full weight, the pre-patch month enters the build as a capped,
 * drift-discounted prior (see lib/patchBlend). */
export function priorWindowFor(patches: Patch[], idx: number): TimeWindow {
  const patch = patches[idx];
  if (!patch) return {};
  return {
    minUnixTimestamp: Math.max(patch.ts - PRIOR_WINDOW_S, seasonFloor(patch)),
    maxUnixTimestamp: patch.ts,
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
 * stale, and a comparator from two months ago measures drift rather than the patch — and clamped
 * at the season start for the reason in {@link seasonFloor}, which costs the two sides their equal
 * length in the same way the monthly cap already can.
 */
export function moversWindowFor(
  patches: Patch[],
  idx: number,
  nowSec: number,
): TimeWindow {
  const patch = patches[idx];
  if (!patch) return {};
  const end = idx > 0 ? patches[idx - 1].ts : nowSec;
  const span = Math.min(
    PRIOR_WINDOW_S,
    Math.max(0, end - patch.ts),
    patch.ts - seasonFloor(patch),
  );
  return {
    minUnixTimestamp: patch.ts - span,
    maxUnixTimestamp: patch.ts,
  };
}
