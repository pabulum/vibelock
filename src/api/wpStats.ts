// The Lab's data file: wp-stats.json, baked nightly by the harvest workflow (scripts/
// bake-wp-stats.mjs) over the rolling ~30-day match window on the repo's `data` branch.
// Unlike everything in deadlock.ts this is not a live analytics query — it's a static
// artifact refit once per day, so one fetch per session is plenty.

export interface WpModelBin {
  fromS: number;
  toS: number | null;
  /** Std-dev of the team soul lead within this time bin (souls). */
  sigma: number;
  w0: number;
  w1: number;
}

export interface LabItem {
  id: number;
  name: string;
  tier: number;
  n: number;
  /** Mean win probability at the moment this item is bought — the situations it's bought in. */
  wpBuy: number;
  /** Raw win rate of matches where it was bought. */
  wr: number;
  /** wr − wpBuy: performance vs what the game state at purchase already predicted. */
  excess: number;
}

export interface LabHero {
  id: number;
  name: string;
  n: number;
  /** Mean excess over every purchase the hero makes ≈ wins above what their soul lead implies. */
  closing: number;
  se: number;
}

export interface WpStats {
  generatedAt: string;
  window: {
    fromDay: string;
    toDay: string;
    matches: number;
    purchases: number;
  };
  meanExcess: number;
  wpModel: WpModelBin[];
  /** WPA-readiness gauge: hero-item cells past the stabilization point k — when `cellsPastK`
   * stops being a rounding error, hero-specific item values become worth revisiting. */
  readiness?: {
    k: number;
    cellsTracked: number;
    cellsPastK: number;
    medianCellN: number;
  };
  items: LabItem[];
  heroes: LabHero[];
}

const URL =
  "https://raw.githubusercontent.com/pabulum/vibelock/data/wp-stats.json";

let cached: Promise<WpStats> | null = null;

export function getWpStats(): Promise<WpStats> {
  cached ??= fetch(URL).then((r) => {
    if (!r.ok) throw new Error(`wp-stats fetch failed (${r.status})`);
    return r.json() as Promise<WpStats>;
  });
  // A failed fetch shouldn't poison the session — let a reopen retry.
  cached.catch(() => (cached = null));
  return cached;
}
