// UPSTREAM WORKAROUND, added 2026-08-02. DELETE THIS FILE, and its three call sites, once
// deadlock-api repopulates the match-level average badge. Nothing here is a design decision we
// would otherwise make.
//
// WHAT BROKE. At the 2026-07-30 matchmaking update the API stopped populating
// `average_badge_team0`/`average_badge_team1` on match records. Counted straight off the ingested
// database via /v1/sql: 100% of matches carried a badge every day through 2026-07-29, 60.5% on
// 07-30, and 0% every day since. The analytics endpoints' `min_average_badge`/`max_average_badge`
// filter reads exactly those fields — the docs call it "the average badge level of *both* teams" —
// so on a window inside the outage a rank floor matches no games at all.
//
// IT IS NOT OUR USAGE, checked before writing this:
//  - We send `tier*10`: an integer inside the documented 0-116 range, in the documented encoding
//    (tier = leading digits, subtier = last digit).
//  - The identical request over a pre-outage window answers correctly — /v1/analytics/item-stats
//    for one hero returns 151 items at badge 80 there, and 0 items at badge 40 *or* 80 for a
//    window starting 07-31, where badge 0 returns 152.
//  - It is not the Standard/Ranked split either: the filter returns nothing for `match_mode=ranked`,
//    `match_mode=unranked`, and the default alike.
//
// WHAT THIS DOES. A query whose window reaches into the outage sends no badge filter at all, and
// the UI says so. The two alternatives are both worse: leaving the filter on renders an empty app,
// and silently clamping the window back to pre-outage answers a question about *this* patch with
// last patch's games. Showing every rank and labelling it is the only option that doesn't lie.
//
// HOW TO TELL WHEN IT'S FIXED. Compare a recent window at two floors — if these disagree the
// outage is over and this file should go:
//   /v1/analytics/item-stats?hero_id=15&min_unix_timestamp=<recent>&min_average_badge=0
//   /v1/analytics/item-stats?hero_id=15&min_unix_timestamp=<recent>&min_average_badge=80
// A per-player `average_badge` does survive in the /v1/sql `match_player` table (Ranked matches
// only), so the fix is available to them; worth re-checking after any deadlock-api deploy.

/** 2026-07-31T00:00:00Z — the first full day on which no match reported a team average badge. */
export const BADGE_OUTAGE_FROM_S = Date.UTC(2026, 6, 31) / 1000;

/**
 * Whether a rank floor still selects anything over this window.
 *
 * False as soon as the window *touches* the outage, not only when it lies entirely inside it. A
 * straddling window is the subtler failure: the filter still returns rows, but only the pre-outage
 * ones, so the answer silently describes a shorter period than the one that was asked about.
 * An open-ended window runs to now, which is inside the outage.
 */
export function rankFilterUsable(window: {
  maxUnixTimestamp?: number;
}): boolean {
  return (window.maxUnixTimestamp ?? Infinity) <= BADGE_OUTAGE_FROM_S;
}
