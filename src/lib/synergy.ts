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
// redundant / anti-synergistic, e.g. two items granting the same stat) that prediction. Shared confounds
// (who plays the hero, game length) largely cancel in the difference — but the rates are raw (un-adjusted),
// so read it as association, not proof.
//
// Noise control reuses the toolkit: each pair's interaction has a sampling error; we keep only the ones
// significant under Benjamini-Hochberg FDR across the build's pairs (#3/#4), and require a minimum
// magnitude so a significant-but-trivial interaction doesn't surface.

import type { Item, ItemFlowStats, ItemPermutationStats } from '../types';
import { benjaminiHochberg, normalCdf, winRateSE } from './stats';

const MIN_PAIR_SAMPLE = 100; // unordered joint games a pair needs before we'll judge its synergy
const MIN_SYNERGY = 0.015; // |interaction| must be ≥1.5pt to be worth *surfacing* (panel effect-size floor)
const SYNERGY_FDR = 0.1; // Benjamini-Hochberg target FDR across the build's pairs (panel)
const SYNERGY_MAX = 8; // cap each panel list (synergies / anti-synergies)
const SYN_SHRINK_K = 400; // for the *build-fill* lookup: shrink a pair's synergy toward 0 by its joint
// sample (synergy·n/(n+K)) so a thin-pair interaction barely nudges item selection while a well-sampled
// one counts in full. No hard significance gate here — the fill wants a continuous signal, not a yes/no.

export interface Synergy {
  a: Item;
  b: Item;
  /** WR(A∧B) − WR(A) − WR(B) + baseline. >0 ⇒ better together, <0 ⇒ redundant. */
  synergy: number;
  jointWinRate: number;
  jointSample: number; // unordered matches that built both items
}

export interface SynergyResult {
  synergies: Synergy[]; // significant positive, strongest first
  antiSynergies: Synergy[]; // significant negative, strongest first
}

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

/** One pair's raw interaction: unordered ids, the synergy, joint win rate/sample, and a two-sided p-value
 * that the interaction is real (vs the null of zero interaction). Shared by the panel (BH-gated discoveries)
 * and the build-fill lookup (continuous, shrunk). */
interface PairSynergy {
  ids: [number, number];
  synergy: number;
  jointWinRate: number;
  jointSample: number;
  p: number;
}

/**
 * Per-pair synergies over *all* pairs with both singles present and ≥ MIN_PAIR_SAMPLE joint games, each
 * **centered on the mean interaction** to remove a systematic bias: conditioning on "built *both* items"
 * selects for games that ran long / were ahead, so WR(A∧B) is inflated for *every* pair by roughly the
 * same amount. The raw interaction is therefore positive across the board (≈ co-occurrence, not synergy).
 * Subtracting the sample-weighted mean (the same de-leaning trick counters.ts uses for the matchup shift)
 * cancels that offset, leaving relative synergy: positive = combos better than a *typical* pairing, negative
 * = worse. (Residual depth-dependent bias may remain — read as association, not proof.) No restriction and
 * no multiple-comparisons gate here — callers add those as needed (the panel does).
 */
function allPairSynergies(
  pairRows: ItemPermutationStats[],
  singles: Map<number, WL>,
  baselineWinRate: number,
): PairSynergy[] {
  // Pass 1: raw interaction per eligible pair.
  const raw: Array<{ ids: [number, number]; synergy: number; se: number; jointWinRate: number; jointSample: number }> = [];
  for (const { ids, wl } of unorderedPairs(pairRows)) {
    const nJoint = decided(wl);
    if (nJoint < MIN_PAIR_SAMPLE) continue;
    const sa = singles.get(ids[0]);
    const sb = singles.get(ids[1]);
    if (!sa || !sb) continue;
    const na = decided(sa);
    const nb = decided(sb);
    if (na <= 0 || nb <= 0) continue;
    const wrAB = winRate(wl);
    const synergy = wrAB - winRate(sa) - winRate(sb) + baselineWinRate;
    // SE of the interaction ≈ quadrature sum of the three rates' SEs (baseline's is negligible — whole pop).
    const se = Math.hypot(winRateSE(wrAB, nJoint), winRateSE(winRate(sa), na), winRateSE(winRate(sb), nb));
    raw.push({ ids, synergy, se, jointWinRate: wrAB, jointSample: nJoint });
  }

  // Sample-weighted mean interaction = the selection-bias offset shared by all pairs. Center on it.
  let wsum = 0;
  let w = 0;
  for (const r of raw) {
    wsum += r.synergy * r.jointSample;
    w += r.jointSample;
  }
  const mean = w > 0 ? wsum / w : 0;

  return raw.map((r) => {
    const synergy = r.synergy - mean;
    const p = r.se > 0 ? 2 * (1 - normalCdf(Math.abs(synergy) / r.se)) : 1; // two-sided: + and − both matter
    return { ids: r.ids, synergy, jointWinRate: r.jointWinRate, jointSample: r.jointSample, p };
  });
}

const pairKey = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** A function `(a, b) → synergy` for use *inside the build fill*: each pair's interaction shrunk toward 0
 * by its joint sample ({@link SYN_SHRINK_K}), so a thin-pair fluke barely nudges item selection. Returns 0
 * for unknown/own pairs. Build it once per hero from the permutation pairs + unconditioned singles +
 * baseline (same population), then pass into {@link generateBuild}. */
export function buildSynergyLookup(
  pairRows: ItemPermutationStats[],
  singles: Map<number, WL>,
  baselineWinRate: number,
): (a: number, b: number) => number {
  const map = new Map<string, number>();
  for (const c of allPairSynergies(pairRows, singles, baselineWinRate)) {
    const shrunk = c.synergy * (c.jointSample / (c.jointSample + SYN_SHRINK_K));
    map.set(pairKey(c.ids[0], c.ids[1]), shrunk);
  }
  return (a, b) => (a === b ? 0 : map.get(pairKey(a, b)) ?? 0);
}

/**
 * Significant pairwise synergies/anti-synergies among `restrictTo` items (e.g. the build's items), from the
 * permutation pairs, per-item singles, and the hero baseline win rate. Pure. For correctness `singles` and
 * `baselineWinRate` must describe the same (unconditioned) population as `pairRows`. (Display/panel use.)
 */
export function computeSynergies(
  pairRows: ItemPermutationStats[],
  singles: Map<number, WL>,
  baselineWinRate: number,
  items: Map<number, Item>,
  restrictTo: Set<number>,
): SynergyResult {
  const cands = allPairSynergies(pairRows, singles, baselineWinRate).filter(
    (c) => restrictTo.has(c.ids[0]) && restrictTo.has(c.ids[1]),
  );

  // FDR control across all the build's pairs (66 for a 12-item build), then an effect-size floor.
  const accept = benjaminiHochberg(cands.map((c) => c.p), SYNERGY_FDR);
  const keep = cands.filter((c, i) => accept[i] && Math.abs(c.synergy) >= MIN_SYNERGY);

  const toSyn = (c: PairSynergy): Synergy | null => {
    const a = items.get(c.ids[0]);
    const b = items.get(c.ids[1]);
    return a && b ? { a, b, synergy: c.synergy, jointWinRate: c.jointWinRate, jointSample: c.jointSample } : null;
  };
  const named = (cs: PairSynergy[]) => cs.map(toSyn).filter((s): s is Synergy => s !== null);
  return {
    synergies: named(keep.filter((c) => c.synergy > 0).sort((p, q) => q.synergy - p.synergy)).slice(0, SYNERGY_MAX),
    antiSynergies: named(keep.filter((c) => c.synergy < 0).sort((p, q) => p.synergy - q.synergy)).slice(0, SYNERGY_MAX),
  };
}
