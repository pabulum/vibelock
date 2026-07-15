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
  /** Mean excess over every purchase the hero makes ≈ wins above what their soul lead implies.
   * NOTE: tracks plain hero WR closely (r≈0.93) — mostly "good heroes win". */
  closing: number;
  /** The hero's plain win rate over the window, for context next to `closing`. */
  wr?: number;
  /** Closing power beyond what the hero's WR predicts — the stable style axis (split-half
   * r≈0.97): positive converts even games, negative wins via soul leads (snowballer). */
  resid?: number;
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
  /** Percentile grid the {@link farmNorms} arrays correspond to, e.g. [10,25,50,75,90]. */
  farmPcts?: number[];
  /** Soul-economy norms for match analysis: per `"heroId:tier"`, each source id maps to that
   * source's gold-per-minute at {@link farmPcts}. Populated from the harvester's economy subsample;
   * a missing cell or source just means no population benchmark there yet (day-one, rare hero/rank).
   * Source ids: 1 kills, 2 lane, 3 camps, 4 boss, 5 urn, 6 assists, 7 denies, 12 breakables. */
  farmNorms?: Record<string, { n: number; src: Record<string, number[]> }>;
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
