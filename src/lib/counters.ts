// "Raw top movers": items whose win rate climbs the most when you face a chosen
// enemy set, vs. that same hero+rank's baseline. item-stats has no adjusted rate,
// but the *delta* (with-enemy minus without) cancels much of the shared confound.
//
// We sort by the raw delta — what "top movers" means — and only *filter* by a hard
// sample floor so pure flukes don't appear. Thin-but-passing rows are flagged
// (lowSample) so the user can discount them; nothing is silently reordered.

import type { CounterItem, Item, ItemStat } from '../types';

const PHASE_BOUNDS_S = [540, 1200, 1800]; // 9m / 20m / 30m
const PHASE_LABELS = ['Lane', 'Early mid', 'Mid', 'Late'];

const MIN_SAMPLE = 80; // below this, too noisy to show at all
const LOW_SAMPLE = 150; // below this, show but flag as shaky
const TOP = 12;

export function computeCounters(
  baseline: ItemStat[],
  vsEnemies: ItemStat[],
  items: Map<number, Item>,
): CounterItem[] {
  const baseWr = new Map<number, number>();
  for (const r of baseline) {
    const n = r.wins + r.losses;
    if (n > 0) baseWr.set(r.item_id, r.wins / n);
  }

  const out: CounterItem[] = [];
  for (const r of vsEnemies) {
    const n = r.wins + r.losses;
    if (n < MIN_SAMPLE) continue;
    const item = items.get(r.item_id);
    const base = baseWr.get(r.item_id);
    if (!item || base === undefined) continue;

    const winRate = r.wins / n;
    const delta = winRate - base;
    if (delta <= 0) continue; // only surface items that *gain* vs this comp
    out.push({
      item,
      winRate,
      delta,
      sample: n,
      lowSample: n < LOW_SAMPLE,
      phaseLabel: phaseForTime(r.avg_buy_time_s),
    });
  }

  return out.sort((a, b) => b.delta - a.delta).slice(0, TOP);
}

function phaseForTime(s: number): string {
  let i = 0;
  while (i < PHASE_BOUNDS_S.length && s >= PHASE_BOUNDS_S[i]) i++;
  return PHASE_LABELS[i];
}
