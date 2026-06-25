// Per-enemy "true counters": items whose win rate climbs more than the matchup as a whole
// when you face a chosen enemy. We query one enemy at a time (the caller passes per-enemy
// stats), so each item keeps a per-enemy breakdown — an item can answer Seven hard and
// Lash barely, and we show exactly that instead of blending the comp into one muddy number.
//
// Crucially we *center* each item's gain on the general matchup lean: if the hero is just
// favored vs an enemy, every item's win rate floats up by roughly the same amount, and
// tagging all of them is noise. The signal is the item that beats that lean — so we
// subtract the sample-weighted mean shift and keep the item's *centered* edge.
//
// Ranking the centered edge — recall over precision. This is a build *recommender*: hiding a
// plausibly-good counter (a false negative) costs the player more than surfacing a marginal one,
// so we mirror the build generator's machinery (empirical-Bayes shrinkage + lower-confidence-bound,
// see buildGenerator.ts) rather than a hard significance gate. Two reasons this beats the old
// whole-grid Benjamini-Hochberg FDR gate it replaces:
//   1. FDR is precision-oriented — it controls the *share of fluke marks*, the opposite trade from
//      the rest of this app (which deliberately runs a loose z = 1.28 bar to favor recall). On a big
//      grid of mostly-null tests, a lone real counter needed a ~13-pt edge at n≈150 to clear it, so
//      almost nothing surfaced.
//   2. It didn't even help the common case. When you select a single tough enemy, the "whole grid"
//      *is* just that one enemy's items — per-enemy FDR families would change nothing there. The gate
//      itself was the problem, not the family size.
// The shrink+lower-bound is still honest about noise: a thin sample has a wide interval and a low
// bound, so it self-rejects — we get recall without minting flukes. Thin marks are flagged for the UI.

import type { ItemCounters, Item, ItemStat } from '../types';
import { GATE_Z } from './stats';

const PHASE_BOUNDS_S = [540, 1200, 1800]; // 9m / 20m / 30m
const PHASE_LABELS = ['Lane', 'Early mid', 'Mid', 'Late'];

const MIN_SAMPLE = 50; // candidacy floor: below this a cell can't inform the lean or earn a mark. Kept low
// because the shrink + lower-bound below does the real noise control — it's not a hard significance cutoff.
const LOW_SAMPLE = 150; // below this, show but flag as shaky
const MIN_EDGE = 0.015; // effect floor: the *shrunk* edge must still clear ~1.5 pts to be worth surfacing
// (a confident-but-trivial edge isn't a counter). Half the old 3-pt floor — the lower bound, not a fat
// fixed cutoff, now guards against noise.
const COUNTER_PRIOR_K = 60; // empirical-Bayes prior strength, in "equivalent games", for shrinking each
// centered edge toward 0 (the null "no counter"). ~60 games of evidence before we trust an edge: thin
// cells get pulled to ~no-edge, well-sampled ones keep theirs. Lower ⇒ more recall (trust small samples
// sooner); higher ⇒ more caution. Modest on purpose — the lower-confidence bound is the main guard.

/** Join per-enemy item stats to the baseline. Returns:
 *  - `counters`: one entry per item that genuinely over-performs vs ≥1 enemy (above that
 *    enemy's matchup lean), with per-enemy marks (strongest first) — for the build tags.
 *  - `edgeByItem`: every item's *signed* comp edge (shrunk sample-weighted mean of its per-enemy
 *    centered edges, so it can be negative) — used to re-rank the build for the comp. */
export function computeItemCounters(
  baseline: ItemStat[],
  perEnemy: Array<{ enemyHeroId: number; stats: ItemStat[] }>,
  items: Map<number, Item>,
): { counters: ItemCounters[]; edgeByItem: Map<number, number> } {
  const baseWr = new Map<number, number>();
  for (const r of baseline) {
    const n = r.wins + r.losses;
    if (n > 0) baseWr.set(r.item_id, r.wins / n);
  }

  const byItem = new Map<number, ItemCounters>();
  const edgeSum = new Map<number, number>(); // Σ edge·n, for the signed average
  const edgeWeight = new Map<number, number>(); // Σ n
  for (const { enemyHeroId, stats } of perEnemy) {
    // Pass 1: raw deltas for every item over the sample floor, plus the matchup lean
    // (sample-weighted mean shift) — what an "average" item does vs this enemy.
    const raw: Array<{ item: Item; winRate: number; rawDelta: number; n: number; buyT: number }> =
      [];
    let shiftSum = 0;
    let shiftWeight = 0;
    for (const r of stats) {
      const n = r.wins + r.losses;
      if (n < MIN_SAMPLE) continue;
      const item = items.get(r.item_id);
      const base = baseWr.get(r.item_id);
      if (!item || base === undefined) continue;
      const winRate = r.wins / n;
      const rawDelta = winRate - base;
      raw.push({ item, winRate, rawDelta, n, buyT: r.avg_buy_time_s });
      shiftSum += rawDelta * n;
      shiftWeight += n;
    }
    const lean = shiftWeight > 0 ? shiftSum / shiftWeight : 0;

    // Pass 2: the centered edge per item. Accumulate the signed average (all items, for the build
    // re-rank), then shrink each edge toward the "no counter" null and keep it only if we're confident
    // (lower bound positive) *and* it's practically meaningful (shrunk edge ≥ MIN_EDGE).
    for (const x of raw) {
      const edge = x.rawDelta - lean;
      edgeSum.set(x.item.id, (edgeSum.get(x.item.id) ?? 0) + edge * x.n);
      edgeWeight.set(x.item.id, (edgeWeight.get(x.item.id) ?? 0) + x.n);

      // Empirical-Bayes shrink toward 0 (prior = no counter, worth COUNTER_PRIOR_K games), then a
      // lower-confidence bound on the edge: shrunk mean − GATE_Z posterior SDs. The edge's noise is the
      // per-enemy mark's binomial SE (the reference — item's overall WR + the lean — is a large aggregate,
      // so its own noise is negligible), regularized by the prior to concentration n + K. Mirrors
      // buildGenerator's shrinkToBaseline / lowerConfidenceWinRate, but on the centered edge.
      const shrunkEdge = (x.n * edge) / (x.n + COUNTER_PRIOR_K);
      const sd = Math.sqrt((x.winRate * (1 - x.winRate)) / (x.n + COUNTER_PRIOR_K + 1));
      // Effect floor *and* confidence in one bar (the significantlyHigher idiom): a small sample needs a
      // bigger observed edge to clear GATE_Z·sd, a large one only needs to clear the effect floor.
      if (shrunkEdge < Math.max(MIN_EDGE, GATE_Z * sd)) continue;

      let entry = byItem.get(x.item.id);
      if (!entry) {
        entry = { item: x.item, phaseLabel: phaseForTime(x.buyT), marks: [], topDelta: 0 };
        byItem.set(x.item.id, entry);
      }
      entry.marks.push({ enemyHeroId, winRate: x.winRate, delta: shrunkEdge, sample: x.n, lowSample: x.n < LOW_SAMPLE });
      entry.topDelta = Math.max(entry.topDelta, shrunkEdge);
    }
  }

  // Shrink the per-item comp edge toward 0 too (prior = no edge, worth COUNTER_PRIOR_K games), so a thin
  // item doesn't swing the build re-rank: Σedge·n / (Σn + K).
  const edgeByItem = new Map<number, number>();
  for (const [id, w] of edgeWeight) edgeByItem.set(id, (edgeSum.get(id) ?? 0) / (w + COUNTER_PRIOR_K));

  const counters = [...byItem.values()];
  for (const e of counters) e.marks.sort((a, b) => b.delta - a.delta);
  counters.sort((a, b) => b.topDelta - a.topDelta);
  return { counters, edgeByItem };
}

function phaseForTime(s: number): string {
  let i = 0;
  while (i < PHASE_BOUNDS_S.length && s >= PHASE_BOUNDS_S[i]) i++;
  return PHASE_LABELS[i];
}
