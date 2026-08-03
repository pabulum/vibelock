// Which windows can be answered from Ranked games alone.
//
// The 2026-07-30 matchmaking update split queueing in two: Standard, explicitly lower-stakes with
// *no restrictions on party size or skill spread*, and Ranked. Every analytics endpoint defaults to
// `ranked,unranked`, so a query that doesn't say otherwise pools a matched ladder with an unmatched
// one — a confound underneath every win rate the app prints. Anything describing the ladder should
// therefore ask for Ranked.
//
// It can't be applied unconditionally, which is the whole reason this module exists. Counted off
// the ingested database via /v1/sql, `match_mode='Ranked'` exists in exactly two eras:
//
//   2024-10-15 .. 2024-11-22   the original ranked mode (~13k matches/day)
//   2026-07-30 .. now          the matchmaking update's Ranked (17-24k/day)
//
// and nothing at all in the twenty months between. Every patch before the update therefore has
// zero ranked games, and asking for them returns an empty view — verified: item-stats for one hero
// over 2026-07-20..27 gives 153 items pooled and 0 items ranked-only. That would blank every
// historical patch AND the young-patch backfill window, which borrows from the 30 days *before*
// the current patch.
//
// So: Ranked when the window lies inside the current era, pooled otherwise — where "pooled" is not
// a compromise, since before the update unranked was simply the whole game.

/**
 * 2026-07-30T19:14:37Z — the matchmaking update's Steam announcement, which is also when the first
 * Ranked matches of this era appear. Patch windows are cut on these announcements, so the current
 * patch's window starts exactly here and qualifies.
 */
export const RANKED_MODE_FROM_S = Date.UTC(2026, 6, 30, 19, 14, 37) / 1000;

/**
 * Whether `match_mode=ranked` describes this window's games rather than emptying it.
 *
 * Keyed on the window's START: a window beginning before the update contains games that could not
 * have been ranked, so scoping it would silently answer for a shorter period than was asked about.
 * A window with no start reaches back indefinitely and so fails for the same reason.
 */
export function rankedOnlyUsable(window: {
  minUnixTimestamp?: number;
}): boolean {
  return (window.minUnixTimestamp ?? 0) >= RANKED_MODE_FROM_S;
}
