// Measured co-purchase counts between item pairs, from the item-permutation-stats endpoint —
// the same payload the synergy lookup reads, viewed through a different lens. Synergy asks "do
// these two items WIN more together than their solo rates predict"; this asks the plainer
// question "are these two items actually BOUGHT together", which the build generator needs in
// two places where it previously had to guess:
//
//   - Substitutes: two same-slot staples share one core slot only when their buyers are largely
//     disjoint camps. The old test was the inclusion–exclusion worst-case bound (pick rates
//     summing under 1 ⇒ "could be disjoint") — a bound, not a measurement. The joint count is
//     the measurement (Paradox @ Emissary+: Monster Rounds ∧ High-Velocity Rounds share only
//     24% of the smaller camp — substitutes; Echo Shard ∧ Superior Duration share 87% — co-buys).
//
//   - Line continuity: what a cheap component's buyers actually do with it. item-stats'
//     avg_sell_time_s counts an upgrade absorbing the component as a "sell", so the old
//     "often sold ~13:14" label misread upgrade lines as placeholders (83% of Headshot Booster
//     buyers finish Headhunter; its "sell" time is Headhunter's buy time).

import type { ItemPermutationStats } from "../types";

/**
 * Unordered joint decided-game count per item pair, collapsed from the endpoint's *ordered*
 * permutation rows (a pair appears once per buy order; the orders partition the joint games, so
 * summing them is the pair's total). Returns 0 for pairs the endpoint didn't report — for two
 * well-sampled items that genuinely means "below the server's noise floor", i.e. effectively
 * never bought together; callers gate on the singles' sample size before reading it that way.
 */
export function buildJointGamesLookup(
  rows: ItemPermutationStats[],
): (a: number, b: number) => number {
  const joint = new Map<string, number>();
  for (const r of rows) {
    if (r.item_ids.length !== 2) continue;
    const lo = Math.min(r.item_ids[0], r.item_ids[1]);
    const hi = Math.max(r.item_ids[0], r.item_ids[1]);
    const key = `${lo}-${hi}`;
    joint.set(key, (joint.get(key) ?? 0) + r.wins + r.losses);
  }
  return (a, b) => joint.get(a < b ? `${a}-${b}` : `${b}-${a}`) ?? 0;
}
