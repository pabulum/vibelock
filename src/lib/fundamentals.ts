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

import type {
  MatchHistoryRow,
  MetricDistribution,
  PlayerMetrics,
} from "../types";

// --- Recency: "my last N games on this hero" as a timestamp window ---

/** How many recent games the benchmark reads by default. One, to match the rest of the page: the
 * Economy panel overlays your *last game* per source, so the combat card reading the same game
 * makes the whole dashboard one coherent post-game story rather than two windows side by side. A
 * single game is noisy — the card says so, and the selector widens it to 5/10/20 in one click. */
export const RECENT_GAMES_DEFAULT = 1;

export interface RecentWindow {
  /** Pass to the metrics endpoint to scope it to exactly these games. */
  minUnixTimestamp: number;
  /** How many games actually matched (≤ the requested count). */
  games: number;
  /** Calendar days the window spans — the honest "over what period" label. */
  spanDays: number;
}

/**
 * Turns "my last N games on this hero" into the timestamp window the metrics endpoint understands,
 * by reading the start time of the Nth-most-recent game.
 *
 * Why not just pass a fixed time window: the analytics endpoints default to the last 30 days, which
 * on a hero you play occasionally is two or three games — a percentile built on that is noise. And a
 * player returning from a long break (one real account here has games 654 days old) does not want a
 * year-old self dragged into the average. Counting *games* rather than days fixes both: the window
 * is always a real sample, and it can never reach back past the games it counted.
 *
 * Returns null only when the hero has *no* games — the caller falls back to the account's all-hero
 * history. With at least one game it returns a window over however many are available (up to
 * `maxGames`), so an explicit "last game" request is honored rather than silently widened.
 */
export function recentWindow(
  history: MatchHistoryRow[],
  heroId: number | null,
  maxGames: number = RECENT_GAMES_DEFAULT,
): RecentWindow | null {
  const games = (
    heroId === null ? history : history.filter((m) => m.hero_id === heroId)
  )
    .slice()
    .sort((a, b) => b.start_time - a.start_time)
    .slice(0, maxGames);
  if (games.length === 0) return null;
  const oldest = games[games.length - 1].start_time;
  return {
    // One second before the oldest counted game, so it's inclusive of that game.
    minUnixTimestamp: oldest - 1,
    games: games.length,
    spanDays: Math.max(1, Math.round((Date.now() / 1000 - oldest) / 86400)),
  };
}

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
  {
    key: "net_worth_per_min",
    label: "Souls/min",
    fmt: (v) => String(Math.round(v)),
  },
  {
    key: "deaths",
    label: "Deaths/game",
    betterLow: true,
    fmt: (v) => v.toFixed(1),
  },
  { key: "last_hits", label: "Last hits", fmt: (v) => String(Math.round(v)) },
  {
    // Jungle damage/min is the cleanest camp-farm proxy the metrics endpoint exposes (the endpoint
    // has no gold-by-source split). Higher = clearing more neutral camps.
    key: "neutral_damage_per_min",
    label: "Jungle/min",
    fmt: (v) => String(Math.round(v)),
  },
  { key: "denies", label: "Denies", fmt: (v) => String(Math.round(v)) },
  {
    key: "player_damage_per_min",
    label: "Damage/min",
    fmt: (v) => String(Math.round(v)),
  },
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
    // The endpoint reports an empty slice (no games on this hero, no games at this rank) as
    // metrics with null fields, not missing keys — treat those as absent or the card renders
    // p1 bars over "0" values instead of falling back to the all-heroes history.
    if (
      !mine ||
      !dist ||
      mine.avg == null ||
      dist.percentile50 == null ||
      !(dist.percentile99 > dist.percentile1)
    )
      continue;
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

// --- Climb advice: turn the weakest controllable levers into concrete actions ---

/** A lever the player can act on next game, keyed to a fundamentals metric. Only *controllable*
 * inputs appear (farm, denies, survival) — not outcomes like kills, which a support can't force and
 * which mostly follow from the game going well. `betterLow` levers (deaths) invert. `priority`
 * breaks ties when several are equally weak: survival and farm are the biggest measured climb
 * levers, so they outrank aim. */
interface Lever {
  key: string;
  /** Imperative advice, e.g. "Soak more lane". Kept short — it's a chip, not a paragraph. */
  action: string;
  /** One-line why, shown under the action. `{hero}` is substituted with the hero name. */
  detail: string;
  priority: number;
}

const LEVERS: Lever[] = [
  {
    key: "deaths",
    action: "Die less",
    detail: "Fewer deaths is the single biggest climb lever at any rank.",
    priority: 3,
  },
  {
    // NOT "soak more lane": soaking is the *proximity* half of trooper souls and needs no last hit
    // at all — you get it by being within 45m of the orb (or 30m of the killer) when souls
    // distribute. A trooper drops two orbs worth 50% of the bounty each: the ground orb can't be
    // denied, while the floating one is contested — shoot it to secure, or an enemy shoots it and
    // takes those souls themselves. So a low count here is *contested* souls being lost, never
    // "free souls on the table" (deadlock.wiki/Souls).
    key: "last_hits",
    action: "Secure your orbs",
    detail:
      "You confirm fewer soul orbs than most {hero} players — half a trooper's souls ride on the floating orb, and the enemy takes them if they shoot it first.",
    priority: 2,
  },
  {
    key: "neutral_damage_per_min",
    action: "Farm more jungle",
    detail: "Clear camps between waves — your neutral farm trails the ladder.",
    priority: 2,
  },
  {
    key: "net_worth_per_min",
    action: "Prioritize farm",
    detail:
      "Your souls/min is behind the ladder — take uncontested farm over risky plays.",
    priority: 1,
  },
  {
    // A deny isn't only starvation: hitting the enemy's floating orb grants those souls to you and
    // nearby allies, so it's a swing — they lose the orb's half, you gain it.
    key: "denies",
    action: "Deny more",
    detail:
      "You deny less than the ladder — shooting the enemy's floating orb takes that half of the trooper for yourself instead.",
    priority: 1,
  },
  {
    key: "player_damage_per_min",
    action: "Do more in fights",
    detail: "Your fight damage trails the ladder — look for more engagements.",
    priority: 1,
  },
];

export interface ClimbTip {
  key: string;
  action: string;
  detail: string;
  /** The player's percentile on this lever (higher = better) — how far below the ladder they sit. */
  percentile: number;
}

/**
 * The 1–2 weakest controllable levers, as actionable climb tips. A lever qualifies when the player
 * sits below {@link WEAK_PERCENTILE} on it; the furthest-below levers come first, with `priority`
 * breaking ties. Returns [] when nothing is clearly weak (the player's controllables are at or above
 * the ladder) so the UI can show a "play your game" note instead of inventing a flaw.
 */
export const WEAK_PERCENTILE = 35;

export function climbAdvice(
  rows: FundamentalRow[],
  heroName: string,
  max = 2,
): ClimbTip[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const weak: Array<ClimbTip & { priority: number }> = [];
  for (const lever of LEVERS) {
    const row = byKey.get(lever.key);
    if (!row || row.percentile >= WEAK_PERCENTILE) continue;
    weak.push({
      key: lever.key,
      action: lever.action,
      detail: lever.detail.replace("{hero}", heroName),
      percentile: row.percentile,
      priority: lever.priority,
    });
  }
  // Weakest first; priority breaks ties so survival/farm advice outranks a marginally-lower aim stat.
  weak.sort((a, b) => a.percentile - b.percentile || b.priority - a.priority);
  return weak.slice(0, max).map((w) => ({
    key: w.key,
    action: w.action,
    detail: w.detail,
    percentile: w.percentile,
  }));
}
