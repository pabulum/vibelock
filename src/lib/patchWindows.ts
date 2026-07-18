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
