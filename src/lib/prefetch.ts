// Speculative fetches fired on *intent* rather than commitment — a hover on a hero chip, a pause on
// a palette row — so the data a click would need is already moving, or already home, by the time it
// lands. A hero switch is a ~12-request fan-out where the slowest calls take seconds; the hover
// before it is the head start.
//
// There is no second cache to keep in sync. The analytics layer is keyed by URL (api/deadlock), so
// a prefetch simply resolves the exact cache entry the real query will ask for: same call, same
// key, one round trip whether or not the guess was right. A repeated hover is free for the same
// reason.
//
// Everything here goes out at prefetch priority — capped concurrency of its own, always behind work
// the player actually asked for — so a wrong guess costs bandwidth but never latency. That's also
// why each function issues its requests in one synchronous batch: priority is fixed at enqueue
// time, and awaiting mid-batch would leak the rest back to user priority.

import {
  atPrefetchPriority,
  getItemFlowStats,
  getItemPermutationStats,
  getItemStats,
  type ItemStatsQuery,
  type RankWindow,
  type TimeWindow,
} from "../api/deadlock";

/** A prefetch must never surface anything: a failed guess just leaves the real query to do the
 * work it would have done anyway (an errored analytics query holds no data, so it refetches). */
const swallow = () => {};

/** The rank + patch slice a build is generated from — everything a query needs beyond the hero. */
export interface DataSlice extends RankWindow {
  dataWindow: TimeWindow;
  priorWin: TimeWindow;
  canBackfill: boolean;
}

/**
 * The item-stats requests behind one counter slice: the enemy-filtered population (or the base
 * population, with `enemyHeroIds` omitted), once per window the blend reads.
 *
 * Shared with features/useCounters — and matching what the build query asks for, which is the same
 * pair — so the hover prefetch fires *identical* URLs. A near-miss wouldn't be visible; it would
 * just quietly do the work twice, which is the failure mode worth designing out.
 */
export function counterSliceQueries(
  heroId: number,
  slice: DataSlice,
  enemyHeroIds?: number[],
): ItemStatsQuery[] {
  const { minBadge, maxBadge, dataWindow, priorWin, canBackfill } = slice;
  const base = { heroId, minBadge, maxBadge, enemyHeroIds };
  // Backfill drops the server-side floor on the fresh window (most nodes are under it on a young
  // patch) and adds the pre-patch window as the prior; off, it's the selected window at the
  // endpoint's own default.
  return canBackfill
    ? [{ ...base, ...dataWindow, minMatches: 5 }, { ...base, ...priorWin }]
    : [{ ...base, ...dataWindow }];
}

/**
 * The heavy half of a hero's build fan-out: the population flow for each window, the item-stats
 * behind buy times and patch movers, and the item-pair permutations.
 *
 * Not the archetype flows — those condition on signature items read *out of* the base flow, so
 * they can't be known until it lands. The permutation payload is the one megabyte-scale request
 * here; it's included because it's also the single biggest contributor to how long a hero switch
 * feels, and the concurrency cap keeps a wrong guess from crowding anything out.
 */
export function prefetchBuild(heroId: number, slice: DataSlice): void {
  const { minBadge, maxBadge, dataWindow, priorWin, canBackfill } = slice;
  atPrefetchPriority(() => {
    getItemFlowStats({
      heroId,
      minBadge,
      maxBadge,
      ...dataWindow,
      ...(canBackfill ? { minMatches: 10 } : {}),
    }).catch(swallow);
    if (canBackfill)
      getItemFlowStats({ heroId, minBadge, maxBadge, ...priorWin }).catch(
        swallow,
      );
    for (const q of counterSliceQueries(heroId, slice))
      getItemStats(q).catch(swallow);
    getItemPermutationStats({
      heroId,
      minBadge,
      maxBadge,
      // One fetch spanning both windows — synergy is a centered, shrunk tiebreak, so the mixed
      // window is fine and the payload is too big to double (matches features/useBuildData).
      ...(canBackfill
        ? {
            minUnixTimestamp: priorWin.minUnixTimestamp,
            maxUnixTimestamp: dataWindow.maxUnixTimestamp,
          }
        : dataWindow),
    }).catch(swallow);
  });
}

/** The item-stats slices one enemy contributes to the counters query. Two requests, against chips
 * whose whole purpose is to be clicked ("click a hero to add it below"), so the guess is cheap and
 * usually right. */
export function prefetchEnemy(
  heroId: number,
  enemyHeroId: number,
  slice: DataSlice,
): void {
  atPrefetchPriority(() => {
    for (const q of counterSliceQueries(heroId, slice, [enemyHeroId]))
      getItemStats(q).catch(swallow);
  });
}
