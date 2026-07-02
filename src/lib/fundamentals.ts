// "Your fundamentals vs the ladder" — the research-backed climbing card. Across MOBA analytics the
// stats that actually separate rank tiers are the boring, controllable ones: farm efficiency and
// death avoidance first, then damage output — not kills (contested) or KDA flourishes. So the card
// benchmarks a handful of those levers: the player's typical game on this hero against the
// distribution of games at the selected rank floor.
//
// Method: percentile-on-ladder, not z-scores — these metrics are skewed (healing, damage), so "you
// are at the 38th percentile" is honest where "0.6 SD below mean" would mislead. The API hands us a
// fixed percentile grid (p1…p99) per metric; the player's average is placed on it by piecewise-
// linear interpolation. Deaths invert (lower is better) so every row reads "higher = better".

import type { MetricDistribution, PlayerMetrics } from "../types";

const GRID: Array<[number, keyof MetricDistribution]> = [
  [1, "percentile1"],
  [5, "percentile5"],
  [10, "percentile10"],
  [25, "percentile25"],
  [50, "percentile50"],
  [75, "percentile75"],
  [90, "percentile90"],
  [95, "percentile95"],
  [99, "percentile99"],
];

/** Where `value` sits in `dist`, as a percentile in [1, 99], by piecewise-linear interpolation on
 * the API's percentile grid. Clamped at the grid's edges — beyond p99 we can't resolve further. */
export function percentileOf(value: number, dist: MetricDistribution): number {
  const first = dist[GRID[0][1]];
  if (value <= first) return GRID[0][0];
  for (let i = 1; i < GRID.length; i++) {
    const [pLo, kLo] = GRID[i - 1];
    const [pHi, kHi] = GRID[i];
    const lo = dist[kLo];
    const hi = dist[kHi];
    if (value <= hi) {
      if (hi === lo) return pHi; // flat segment (degenerate metric)
      return pLo + ((value - lo) / (hi - lo)) * (pHi - pLo);
    }
  }
  return GRID[GRID.length - 1][0];
}

/** The fundamentals we benchmark, in display order. `betterLow` inverts the percentile so every
 * row reads "higher = better". `fmt` renders the player's raw value. */
export const FUNDAMENTALS: Array<{
  key: string;
  label: string;
  betterLow?: boolean;
  fmt: (v: number) => string;
}> = [
  { key: "net_worth_per_min", label: "Souls/min", fmt: (v) => String(Math.round(v)) },
  { key: "deaths", label: "Deaths/game", betterLow: true, fmt: (v) => v.toFixed(1) },
  { key: "last_hits", label: "Last hits", fmt: (v) => String(Math.round(v)) },
  { key: "denies", label: "Denies", fmt: (v) => String(Math.round(v)) },
  { key: "player_damage_per_min", label: "Damage/min", fmt: (v) => String(Math.round(v)) },
  { key: "accuracy", label: "Accuracy", fmt: (v) => `${Math.round(v * 100)}%` },
];

export interface FundamentalRow {
  key: string;
  label: string;
  /** The player's typical (average) value, formatted for display. */
  value: string;
  /** "Goodness" percentile in [1, 99]: already inverted for better-low metrics, so higher is
   * always better and the bar/color read uniformly. */
  percentile: number;
  /** The ladder's median, formatted — the "what average looks like here" anchor. */
  ladderMedian: string;
}

/**
 * Benchmark rows: the player's average per fundamental placed on the ladder's distribution.
 * Metrics missing from either side are skipped; returns [] when nothing overlaps (no games on this
 * hero, empty ladder slice) so the card can simply hide.
 */
export function fundamentalsRows(
  player: PlayerMetrics,
  ladder: PlayerMetrics,
): FundamentalRow[] {
  const out: FundamentalRow[] = [];
  for (const f of FUNDAMENTALS) {
    const mine = player[f.key];
    const dist = ladder[f.key];
    if (!mine || !dist || !(dist.percentile99 > dist.percentile1)) continue;
    const p = percentileOf(mine.avg, dist);
    out.push({
      key: f.key,
      label: f.label,
      value: f.fmt(mine.avg),
      percentile: Math.round(f.betterLow ? 100 - p : p),
      ladderMedian: f.fmt(dist.percentile50),
    });
  }
  return out;
}
