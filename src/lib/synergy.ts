// #5 + #6 (merged): pairwise item *synergy* — do two items win more together than their solo effects
// predict? A full per-item regression isn't possible (no match-level data), so we estimate the build-level
// analog of Statlocker's WPA pairwise, from the item-permutation-stats endpoint (joint win rates of item
// sets):
//
//   synergy(A,B) = WR(A∧B) − WR(A) − WR(B) + baseline
//
// This is the additive interaction (difference-in-differences, a.k.a. "lift" on the win-rate scale). If the
// two items' effects were independent, a build with both would win at baseline + A's edge + B's edge; the
// synergy is how far the *actual* joint win rate beats (positive ⇒ they complement) or trails (negative ⇒
// redundant / anti-synergistic, e.g. two items granting the same stat) that prediction.
//
// The output feeds the build generator (lib/buildGenerator.ts): a discretionary pick's core/situational
// ranking gets a bonus for its net synergy with the already-committed build, so the build leans toward
// items that reinforce each other — not just independently-good items. Read it as association, not proof:
// the rates are raw (un-adjusted), and a residual depth bias may survive the centering below.

import type { ItemFlowStats, ItemPermutationStats } from '../types';

const MIN_PAIR_SAMPLE = 100; // unordered joint games a pair needs before we'll judge its synergy
const SYN_SHRINK_K = 400; // shrink a pair's synergy toward 0 by its joint sample (synergy·n/(n+K)) so a
// thin-pair fluke barely nudges item selection while a well-sampled one counts in full.

interface WL {
  wins: number;
  losses: number;
}
const winRate = (x: WL): number => {
  const n = x.wins + x.losses;
  return n > 0 ? x.wins / n : 0;
};
const decided = (x: WL): number => x.wins + x.losses;

/**
 * Single-item raw records for a hero, summed across the flow's phase columns (a player buys an item once,
 * in one column, so summing columns = all games that built it). Used as WR(A)/WR(B) in the interaction.
 * Pass the *unconditioned* ("all") flow so the single rates match the permutation pairs' population.
 */
export function singleRecordsFromFlow(flow: ItemFlowStats): Map<number, WL> {
  const out = new Map<number, WL>();
  for (const n of flow.nodes) {
    const cur = out.get(n.item_id) ?? { wins: 0, losses: 0 };
    cur.wins += n.wins;
    cur.losses += n.losses;
    out.set(n.item_id, cur);
  }
  return out;
}

/** Collapse the endpoint's *ordered* permutation rows into one *unordered* joint record per pair. */
function unorderedPairs(rows: ItemPermutationStats[]): Array<{ ids: [number, number]; wl: WL }> {
  const out = new Map<string, { ids: [number, number]; wl: WL }>();
  for (const r of rows) {
    if (r.item_ids.length !== 2) continue;
    const lo = Math.min(r.item_ids[0], r.item_ids[1]);
    const hi = Math.max(r.item_ids[0], r.item_ids[1]);
    const key = `${lo}-${hi}`;
    const cur = out.get(key) ?? { ids: [lo, hi] as [number, number], wl: { wins: 0, losses: 0 } };
    cur.wl.wins += r.wins;
    cur.wl.losses += r.losses;
    out.set(key, cur);
  }
  return [...out.values()];
}

const pairKey = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);

/**
 * A function `(a, b) → synergy` for use inside the build fill: each eligible pair's additive interaction,
 * **centered on the mean interaction** then **shrunk toward 0** by its joint sample. Returns 0 for unknown
 * or identical pairs. Build it once per hero from the permutation pairs + unconditioned singles + baseline
 * (same population), then pass into `generateBuild` via `BuildOptions.synergyOf`.
 *
 * Centering removes a systematic bias: conditioning on "built *both* items" selects for games that ran long
 * / were ahead, so WR(A∧B) is inflated for *every* pair by roughly the same amount — the raw interaction is
 * positive across the board (≈ co-occurrence, not synergy). Subtracting the sample-weighted mean (the same
 * de-leaning trick counters.ts uses for the matchup shift) cancels that offset, leaving relative synergy:
 * positive = combos better than a *typical* pairing, negative = worse.
 */
export function buildSynergyLookup(
  pairRows: ItemPermutationStats[],
  singles: Map<number, WL>,
  baselineWinRate: number,
): (a: number, b: number) => number {
  // Pass 1: raw interaction per eligible pair.
  const raw: Array<{ ids: [number, number]; synergy: number; jointSample: number }> = [];
  for (const { ids, wl } of unorderedPairs(pairRows)) {
    const nJoint = decided(wl);
    if (nJoint < MIN_PAIR_SAMPLE) continue;
    const sa = singles.get(ids[0]);
    const sb = singles.get(ids[1]);
    if (!sa || !sb || decided(sa) <= 0 || decided(sb) <= 0) continue;
    const synergy = winRate(wl) - winRate(sa) - winRate(sb) + baselineWinRate;
    raw.push({ ids, synergy, jointSample: nJoint });
  }

  // Sample-weighted mean interaction = the selection-bias offset shared by all pairs. Center on it.
  let wsum = 0;
  let w = 0;
  for (const r of raw) {
    wsum += r.synergy * r.jointSample;
    w += r.jointSample;
  }
  const mean = w > 0 ? wsum / w : 0;

  const map = new Map<string, number>();
  for (const r of raw) {
    const centered = r.synergy - mean;
    const shrunk = centered * (r.jointSample / (r.jointSample + SYN_SHRINK_K));
    map.set(pairKey(r.ids[0], r.ids[1]), shrunk);
  }
  return (a, b) => (a === b ? 0 : map.get(pairKey(a, b)) ?? 0);
}
