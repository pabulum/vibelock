// Per-enemy "true counters": items whose win rate climbs more than the matchup as a whole
// when you face a chosen enemy. We query one enemy at a time (the caller passes per-enemy
// stats), so each item keeps a per-enemy breakdown — an item can answer Seven hard and
// Lash barely, and we show exactly that instead of blending the comp into one muddy number.
//
// Crucially we *center* each item's gain on the general matchup lean: if the hero is just
// favored vs an enemy, every item's win rate floats up by roughly the same amount, and
// tagging all of them is noise. The signal is the item that beats that lean — so we
// subtract the sample-weighted mean shift and only keep items that clear it by MIN_EDGE.
// Items are filtered by a hard sample floor so flukes don't appear; thin marks are flagged.

import type { ItemCounters, Item, ItemStat } from '../types';
import { GATE_Z, winRateSE } from './stats';

const PHASE_BOUNDS_S = [540, 1200, 1800]; // 9m / 20m / 30m
const PHASE_LABELS = ['Lane', 'Early mid', 'Mid', 'Late'];

const MIN_SAMPLE = 80; // below this, too noisy to show at all
const LOW_SAMPLE = 150; // below this, show but flag as shaky
const MIN_EDGE = 0.03; // must beat the general matchup lean by ≥3 pts to count as a counter

/** Join per-enemy item stats to the baseline. Returns:
 *  - `counters`: one entry per item that genuinely over-performs vs ≥1 enemy (above that
 *    enemy's matchup lean), with per-enemy marks (strongest first) — for the build tags.
 *  - `edgeByItem`: every item's *signed* comp edge (sample-weighted mean of its per-enemy
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

    // Pass 2: the centered edge per item. Accumulate the signed average for ranking, and
    // keep items that beat the lean by MIN_EDGE as displayed counter marks.
    for (const x of raw) {
      const edge = x.rawDelta - lean;
      edgeSum.set(x.item.id, (edgeSum.get(x.item.id) ?? 0) + edge * x.n);
      edgeWeight.set(x.item.id, (edgeWeight.get(x.item.id) ?? 0) + x.n);
      if (edge < MIN_EDGE) continue; // effect size: must beat the lean by the threshold
      // Significance: the edge must also be wide relative to this mark's sampling noise, or a thin sample
      // can clear MIN_EDGE on a fluke. The reference (the item's overall WR plus the matchup lean) is a
      // large aggregate, so its own noise is negligible and we test against the per-enemy mark's SE alone.
      if (edge < GATE_Z * winRateSE(x.winRate, x.n)) continue;
      let entry = byItem.get(x.item.id);
      if (!entry) {
        entry = { item: x.item, phaseLabel: phaseForTime(x.buyT), marks: [], topDelta: 0 };
        byItem.set(x.item.id, entry);
      }
      entry.marks.push({ enemyHeroId, winRate: x.winRate, delta: edge, sample: x.n, lowSample: x.n < LOW_SAMPLE });
      entry.topDelta = Math.max(entry.topDelta, edge);
    }
  }

  const edgeByItem = new Map<number, number>();
  for (const [id, w] of edgeWeight) if (w > 0) edgeByItem.set(id, (edgeSum.get(id) ?? 0) / w);

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
