// Post-game analysis of a single match: what the win-probability trajectory looked like, how the
// focus player's fundamentals compare to their ladder, and where their souls actually came from.
//
// Reads /v1/matches/{id}/metadata (see api/deadlock.getMatchMetadata) plus two things the app
// already has: the Lab's baked WP surface (wp-stats.json) to price a soul lead into a win
// probability, and the ladder's per-metric percentile distributions to benchmark this game.
//
// Two data honesty rules, both measured:
//  - `net_worth_at_buy` on item events is NEVER read — it's corrupt upstream (a player's first
//    ~4-5 purchases report their FINAL net worth). Timing comes from `game_time_s` only.
//  - Per-source souls are shown grouped by how *controllable* the source is (camps/boxes are
//    levers you can pull next game; kills/bosses/urn largely follow from winning fights), and the
//    lane soak is presented neutrally — its raw volume inverts on roamers, so it's context, not a
//    grade. There is no per-source ladder benchmark: the analytics API can't slice gold by source.

import type {
  MatchDeath,
  MatchGoldSource,
  MatchInfo,
  MatchPlayer,
  MatchStatSample,
  PlayerMetrics,
} from "../types";
import type { WpStats } from "../api/wpStats";
import { FUNDAMENTALS, percentileOf } from "./fundamentals";
import type { FundamentalRow } from "./fundamentals";

// --- Team & interpolation helpers ---

/** Proto enum names, not numbers: "Team0" / "Team1". */
const isTeam = (p: MatchPlayer, team: string) => p.team === team;

/** A player's net worth at `t`, linearly interpolated between stat samples (0 souls at t=0). */
function playerNwAt(p: MatchPlayer, t: number): number {
  const s = p.stats ?? [];
  if (!s.length) return 0;
  let prevT = 0;
  let prevNw = 0;
  for (const sample of s) {
    if (sample.time_stamp_s >= t) {
      const span = sample.time_stamp_s - prevT || 1;
      return prevNw + ((t - prevT) / span) * (sample.net_worth - prevNw);
    }
    prevT = sample.time_stamp_s;
    prevNw = sample.net_worth;
  }
  return s[s.length - 1].net_worth;
}

/** The focus team's soul lead at `t` (positive = ahead). */
function teamLeadAt(match: MatchInfo, team: string, t: number): number {
  let lead = 0;
  for (const p of match.players)
    lead += (isTeam(p, team) ? 1 : -1) * playerNwAt(p, t);
  return lead;
}

// --- Win probability from the Lab's baked surface ---

/** WP for a soul lead at time `t`, from the baked per-time-bin logistic (same formula the build
 * header uses: σ(w0 + w1·lead/sigma)). Null when the surface has no bin for `t`. */
export function winProbability(
  wp: WpStats,
  t: number,
  lead: number,
): number | null {
  const bin = wp.wpModel.find(
    (b) => t >= b.fromS && (b.toS === null || t < b.toS),
  );
  if (!bin || !(bin.sigma > 0)) return null;
  return 1 / (1 + Math.exp(-(bin.w0 + (bin.w1 * lead) / bin.sigma)));
}

export interface WpPoint {
  /** Game time, seconds. */
  t: number;
  /** Focus team's soul lead (souls, signed). */
  lead: number;
  /** Win probability for the focus team, [0,1]. */
  wp: number;
}

export interface WpSwing {
  /** Interval during which the swing happened. */
  fromT: number;
  toT: number;
  /** Signed WP change over the interval, from the focus team's perspective. */
  delta: number;
}

/**
 * The focus team's WP trajectory, evaluated at the match's own stat-sample timestamps (~every
 * 3–4 minutes — evaluating between samples would only interpolate, not add information), plus the
 * biggest inter-sample swings. Empty when the WP surface is unavailable.
 */
export function wpTimeline(
  match: MatchInfo,
  team: string,
  wp: WpStats | null,
): { points: WpPoint[]; swings: WpSwing[] } {
  if (!wp) return { points: [], swings: [] };
  // Sample cadence is shared across players; take the densest player's timestamps as the grid.
  const grid = match.players
    .map((p) => (p.stats ?? []).map((s) => s.time_stamp_s))
    .reduce((best, ts) => (ts.length > best.length ? ts : best), [] as number[])
    .filter((t) => t > 0);
  const points: WpPoint[] = [];
  for (const t of [0, ...grid]) {
    const lead = t === 0 ? 0 : teamLeadAt(match, team, t);
    const p = winProbability(wp, t, lead);
    if (p !== null) points.push({ t, lead, wp: p });
  }
  const swings: WpSwing[] = [];
  for (let i = 1; i < points.length; i++)
    swings.push({
      fromT: points[i - 1].t,
      toT: points[i].t,
      delta: points[i].wp - points[i - 1].wp,
    });
  swings.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { points, swings: swings.slice(0, 3) };
}

// --- Fundamentals: this game vs the ladder ---

/** The focus player's per-game stats in the same units as the analytics metrics endpoint. */
function matchMetricValues(
  p: MatchPlayer,
  durationS: number,
): Record<string, number | undefined> {
  const last: MatchStatSample | undefined = p.stats?.[p.stats.length - 1];
  const mins = Math.max(1, durationS / 60);
  const shots = (last?.shots_hit ?? 0) + (last?.shots_missed ?? 0);
  return {
    net_worth_per_min: p.net_worth / mins,
    deaths: p.deaths,
    last_hits: p.last_hits ?? last?.last_hits,
    denies: p.denies ?? last?.denies,
    player_damage_per_min:
      last?.player_damage !== undefined ? last.player_damage / mins : undefined,
    accuracy: shots > 0 ? (last?.shots_hit ?? 0) / shots : undefined,
  };
}

/**
 * This game's fundamentals placed on the ladder's percentile distributions — the same rows and
 * method as the profile card (lib/fundamentals), but for ONE match instead of the account average.
 * A single game is noisy; the row exists to locate the game ("your farm this game was a p20 game
 * at this rank"), not to grade the player. Rows missing on either side are skipped.
 */
export function matchFundamentals(
  p: MatchPlayer,
  durationS: number,
  ladder: PlayerMetrics,
): FundamentalRow[] {
  const values = matchMetricValues(p, durationS);
  const out: FundamentalRow[] = [];
  for (const f of FUNDAMENTALS) {
    const v = values[f.key];
    const dist = ladder[f.key];
    if (
      v === undefined ||
      !dist ||
      dist.percentile50 == null ||
      !(dist.percentile99 > dist.percentile1)
    )
      continue;
    const pct = percentileOf(v, dist);
    out.push({
      key: f.key,
      label: f.label,
      value: f.fmt(v),
      percentile: Math.round(f.betterLow ? 100 - pct : pct),
      ladderMedian: f.fmt(dist.percentile50),
    });
  }
  return out;
}

// --- Soul economy: where the souls came from ---

/** EGoldSource ids, verified numerically against the flat gold_* fields (each source's total
 * reconciles exactly: src2 == gold_lane_creep, src3 == gold_neutral_creep, src4 == gold_boss,
 * src5 == gold_treasure, src7 == gold_denied, src1+src6 == gold_player). */
const SRC = {
  kills: 1,
  laneCreeps: 2,
  neutralCamps: 3,
  bosses: 4,
  urn: 5,
  assists: 6,
  denies: 7,
  teamBonus: 8,
  itemGenerated: [10, 11],
  breakables: 12,
} as const;

/** How *reliable* a soul source is, not how controllable — every source is a choice (you pick
 * whether to soak lane, contest a camp, deny an orb, take a fight). The axis the wiki and our WPA
 * confound both draw is steadiness: `steady` farm (lane, camps, breakables, denies) is map income
 * that arrives whether or not fights go your way — lane is in fact the *least* win-correlated source;
 * `swingy` souls (kills, bosses, urn) are contested and ride on the game going your way; `passive`
 * is item/team trickle. Drives the framing group, never a grade. */
export type EconomyKind = "steady" | "swingy" | "passive";

export interface EconomyRow {
  key: string;
  label: string;
  /** Total souls from this source (incl. orbs where the source pays them). */
  gold: number;
  perMin: number;
  share: number;
  /** Which reliability group the source falls in — drives the framing chip, not a grade. */
  kind: EconomyKind;
  /** EGoldSource id when the row is a single source (so it can be benchmarked vs population);
   * undefined for grouped rows (kills+assists, passive) that don't map 1:1 to a baked norm. */
  src?: number;
  /** Percentile [1,99] of this game's per-minute rate vs the population at this hero+rank, when a
   * baked norm exists for the source. Higher = more than most. undefined ⇒ no benchmark available. */
  percentile?: number;
}

const gold = (g: MatchGoldSource | undefined) =>
  (g?.gold ?? 0) + (g?.gold_orbs ?? 0);

/**
 * How gold sources are grouped into the displayed rows, shared by the per-game economy view
 * ({@link economyRows}) and the per-hero farm profile ({@link heroFarmProfile}) so both read one
 * source of truth. `kind` is the reliability group (see {@link EconomyKind}): lane/camps/breakables/
 * denies are `steady` map farm, kills/bosses/urn are `swingy` contested souls, item/team trickle is
 * `passive`. `benchSrc` is the single EGoldSource id a row can be benchmarked against — set only for
 * one-source rows (grouped rows like kills+assists map to no single norm).
 */
interface SourceGroup {
  key: string;
  label: string;
  kind: EconomyKind;
  srcs: number[];
  benchSrc?: number;
}
const SOURCE_GROUPS: SourceGroup[] = [
  {
    key: "lane",
    label: "Lane soak",
    kind: "steady",
    srcs: [SRC.laneCreeps],
    benchSrc: SRC.laneCreeps,
  },
  {
    key: "camps",
    label: "Neutral camps",
    kind: "steady",
    srcs: [SRC.neutralCamps],
    benchSrc: SRC.neutralCamps,
  },
  {
    key: "boxes",
    label: "Breakables",
    kind: "steady",
    srcs: [SRC.breakables],
    benchSrc: SRC.breakables,
  },
  {
    key: "denies",
    label: "Denies",
    kind: "steady",
    srcs: [SRC.denies],
    benchSrc: SRC.denies,
  },
  {
    key: "kills",
    label: "Kills & assists",
    kind: "swingy",
    srcs: [SRC.kills, SRC.assists],
  },
  {
    key: "bosses",
    label: "Bosses & objectives",
    kind: "swingy",
    srcs: [SRC.bosses],
    benchSrc: SRC.bosses,
  },
  {
    key: "urn",
    label: "Urn",
    kind: "swingy",
    srcs: [SRC.urn],
    benchSrc: SRC.urn,
  },
  {
    key: "passive",
    label: "Passive & items",
    kind: "passive",
    srcs: [SRC.teamBonus, ...SRC.itemGenerated],
  },
];

/**
 * The focus player's souls by source, largest first — see {@link SOURCE_GROUPS} for the grouping and
 * the confound spectrum the `kind` tags encode.
 */
export function economyRows(p: MatchPlayer, durationS: number): EconomyRow[] {
  const last = p.stats?.[p.stats.length - 1];
  const by = new Map<number, MatchGoldSource>();
  for (const g of last?.gold_sources ?? []) by.set(g.source, g);

  const mins = Math.max(1, durationS / 60);
  const total =
    SOURCE_GROUPS.reduce(
      (s, grp) => s + grp.srcs.reduce((t, id) => t + gold(by.get(id)), 0),
      0,
    ) || 1;
  return SOURCE_GROUPS.map((grp) => {
    const g = grp.srcs.reduce((t, id) => t + gold(by.get(id)), 0);
    return {
      key: grp.key,
      label: grp.label,
      kind: grp.kind,
      gold: g,
      src: grp.benchSrc,
      perMin: g / mins,
      share: g / total,
    };
  })
    .filter((r) => r.gold > 0)
    .sort((a, b) => b.gold - a.gold);
}

// --- Per-hero farm profile: the population's soul-income mix for a (hero, rank), forward-looking ---

export interface FarmProfileRow {
  key: string;
  label: string;
  kind: EconomyKind;
  /** Population median souls/min from this (group of) source(s) at the hero + rank. */
  perMin: number;
  /** This row's share of the summed-median mix (a shape, not an exact budget: the median of a sum
   * isn't the sum of medians, so shares are approximate by construction). */
  share: number;
}

export interface HeroFarmProfile {
  /** Rank tier the norms are actually drawn from — may differ from the requested tier when the exact
   * cell isn't baked and a nearby one was substituted (see {@link heroFarmProfile}). */
  tier: number;
  /** True when {@link tier} is a fallback (nearest baked tier), so the UI can say "nearest data: …". */
  substituted: boolean;
  /** Sample size of the underlying cell (games). */
  n: number;
  /** Rows largest-median first. */
  rows: FarmProfileRow[];
  /** Combined median share from the steady farm sources (lane + camps + breakables + denies) — the
   * headline: how much of this hero's income arrives whether or not fights go your way. */
  steadyShare: number;
}

/** Tier offsets searched for a baked cell, nearest first (ties break toward the climb, i.e. up).
 * Capped at ±2 because farm norms drift across ranks — borrowing tier 10 data for a tier 4 player
 * would mislead, so beyond two tiers we show nothing rather than a wrong shape. */
const TIER_FALLBACK_OFFSETS = [0, 1, -1, 2, -2];

/**
 * The soul-income *shape* of a hero at a rank, from the baked farm norms (wp-stats.json) — the
 * forward-looking counterpart to the per-game {@link economyRows}. Descriptive only: it says how the
 * population's souls split across sources (and how much is steady farm), NOT that farming more of any
 * source causes wins — that gradient is ~0 once total net worth is held fixed, so no win-rate number
 * is attached.
 *
 * `tier` is the *preferred* tier; when its cell isn't baked (thin economy data, a rare hero/rank, or
 * a band whose centre tier simply has no cell) the nearest baked tier within ±2 is used and flagged
 * via `substituted`. Returns null only when nothing baked is within range, so the UI hides the card.
 */
export function heroFarmProfile(
  wp: WpStats | null,
  heroId: number,
  tier: number,
): HeroFarmProfile | null {
  const pcts = wp?.farmPcts;
  if (!wp?.farmNorms || !pcts) return null;
  const p50 = pcts.indexOf(50);
  if (p50 < 0) return null;

  let usedTier = tier;
  let cell: NonNullable<WpStats["farmNorms"]>[string] | undefined;
  for (const off of TIER_FALLBACK_OFFSETS) {
    const t = tier + off;
    if (t < 0 || t > 11) continue;
    const c = wp.farmNorms[`${heroId}:${t}`];
    if (c) {
      cell = c;
      usedTier = t;
      break;
    }
  }
  if (!cell) return null;

  const cellSrc = cell.src;
  const median = (src: number): number | null => {
    const vals = cellSrc[String(src)];
    return vals && vals.length === pcts.length ? vals[p50] : null;
  };
  const raw = SOURCE_GROUPS.flatMap((grp) => {
    const parts = grp.srcs.map(median);
    // A group contributes only when every member source is baked, so the mix stays self-consistent.
    if (parts.some((v) => v === null)) return [];
    const perMin = (parts as number[]).reduce((s, v) => s + v, 0);
    return perMin > 0
      ? [{ key: grp.key, label: grp.label, kind: grp.kind, perMin }]
      : [];
  });
  const total = raw.reduce((s, r) => s + r.perMin, 0) || 1;
  const rows = raw
    .map((r) => ({ ...r, share: r.perMin / total }))
    .sort((a, b) => b.perMin - a.perMin);
  const steadyShare = rows
    .filter((r) => r.kind === "steady")
    .reduce((s, r) => s + r.share, 0);
  return {
    tier: usedTier,
    substituted: usedTier !== tier,
    n: cell.n,
    rows,
    steadyShare,
  };
}

/** Place `value` on a percentile grid (e.g. [10,25,50,75,90] → [v10,v25,v50,v75,v90]) by piecewise-
 * linear interpolation, clamped to [pcts[0], pcts.at(-1)] at the ends. */
function placeOnGrid(value: number, pcts: number[], vals: number[]): number {
  if (value <= vals[0]) return pcts[0];
  for (let i = 1; i < vals.length; i++) {
    if (value <= vals[i]) {
      const span = vals[i] - vals[i - 1] || 1;
      return (
        pcts[i - 1] + ((value - vals[i - 1]) / span) * (pcts[i] - pcts[i - 1])
      );
    }
  }
  return pcts[pcts.length - 1];
}

/**
 * Annotate economy rows with a population percentile from the baked farm norms (wp-stats.json),
 * for the single-source rows at this hero + rank tier. Rows without a source or without a baked
 * cell are returned unchanged (no benchmark), so the UI degrades cleanly on day-one data or a rare
 * hero/rank. Exported for tests.
 */
export function benchmarkEconomy(
  rows: EconomyRow[],
  heroId: number,
  tier: number,
  wp: WpStats | null,
): EconomyRow[] {
  const cell = wp?.farmNorms?.[`${heroId}:${tier}`];
  const pcts = wp?.farmPcts;
  if (!cell || !pcts) return rows;
  return rows.map((r) => {
    if (r.src === undefined) return r;
    const vals = cell.src[String(r.src)];
    if (!vals || vals.length !== pcts.length) return r;
    return { ...r, percentile: Math.round(placeOnGrid(r.perMin, pcts, vals)) };
  });
}

// --- Deaths by phase ---

/** Phase buckets matching the build columns (Lane 0–9, Early mid 9–20, Mid 20–30, Late 30+). */
const PHASES: Array<{ label: string; toS: number }> = [
  { label: "Lane", toS: 9 * 60 },
  { label: "Early mid", toS: 20 * 60 },
  { label: "Mid", toS: 30 * 60 },
  { label: "Late", toS: Infinity },
];

/** A teammate dying this close in time means you died in a *fight*, not as an isolated pick. */
const SOLO_WINDOW_S = 15;
/** Killed this fast = caught with no time to react. Measured p25 of time-to-kill is ~7s, so 5s is
 * genuinely the burst tail rather than the low end of a normal engagement. */
const BURST_S = 5;
/** A repeat killer needs both an absolute count and a real share of your deaths before it's a
 * pattern rather than a coincidence of a long game. */
const NEMESIS_MIN_COUNT = 3;
const NEMESIS_MIN_SHARE = 0.3;

export interface DeathsSummary {
  total: number;
  /** Count per build phase, in phase order; same length as labels. */
  byPhase: Array<{ label: string; count: number }>;
  /** Souls lost to deaths (from the final sample's ledger), when recorded. */
  goldLost?: number;
  /** The enemy who killed you disproportionately often — the read that most often has a build
   * answer (see the counters engine). Absent unless it's a real pattern. */
  nemesis?: { heroId: number; count: number; share: number };
  /** Deaths with no teammate dying within {@link SOLO_WINDOW_S} — you were picked off alone, which
   * is a positioning error rather than a lost fight. */
  soloPicks: number;
  /** Deaths that took under {@link BURST_S} to land — caught out with no time to react. */
  burst: number;
  /** Median engagement length across your deaths, or undefined when the API reported none. */
  medianTimeToKillS?: number;
}

/**
 * The post-game death read. Beyond counting, it separates the three things deaths actually tell you:
 * *who* keeps killing you (a build problem — pair it with the counters engine), whether you die
 * *alone* (a positioning problem), and whether you die *instantly* (caught with no escape) or in
 * long fights you should have left.
 *
 * `teammates` are the focus player's living squad — their death times are what distinguish a solo
 * pick from a team fight.
 */
export function deathsSummary(
  p: MatchPlayer,
  teammates: MatchPlayer[] = [],
  enemyBySlot: Map<number, number> = new Map(),
): DeathsSummary {
  const deaths: MatchDeath[] = p.death_details ?? [];
  const byPhase = PHASES.map((ph) => ({ label: ph.label, count: 0 }));
  const mateDeathTimes = teammates.flatMap((t) =>
    (t.death_details ?? []).map((d) => d.game_time_s),
  );

  const killerCounts = new Map<number, number>();
  const ttks: number[] = [];
  let soloPicks = 0;
  let burst = 0;

  for (const d of deaths) {
    const i = PHASES.findIndex((ph) => d.game_time_s < ph.toS);
    byPhase[i === -1 ? PHASES.length - 1 : i].count++;

    const heroId =
      d.killer_player_slot === undefined
        ? undefined
        : enemyBySlot.get(d.killer_player_slot);
    if (heroId !== undefined)
      killerCounts.set(heroId, (killerCounts.get(heroId) ?? 0) + 1);

    if (
      !mateDeathTimes.some((t) => Math.abs(t - d.game_time_s) <= SOLO_WINDOW_S)
    )
      soloPicks++;

    // -1 is the API's "unknown" sentinel — never let it read as an instant death.
    const ttk = d.time_to_kill_s;
    if (ttk !== undefined && ttk >= 0) {
      ttks.push(ttk);
      if (ttk < BURST_S) burst++;
    }
  }

  let nemesis: DeathsSummary["nemesis"];
  const total = deaths.length;
  for (const [heroId, count] of killerCounts) {
    const share = total > 0 ? count / total : 0;
    if (count < NEMESIS_MIN_COUNT || share < NEMESIS_MIN_SHARE) continue;
    if (!nemesis || count > nemesis.count) nemesis = { heroId, count, share };
  }

  ttks.sort((a, b) => a - b);
  return {
    total: total || p.deaths,
    byPhase,
    goldLost: p.stats?.[p.stats.length - 1]?.gold_death_loss,
    nemesis,
    soloPicks,
    burst,
    medianTimeToKillS: ttks.length
      ? ttks[Math.floor(ttks.length / 2)]
      : undefined,
  };
}

/**
 * Plain-language reads drawn from the death summary — only the ones the data actually supports.
 * Deliberately NOT included: death map positions. The coordinates are there, but naming a zone
 * ("enemy jungle", "mid") would require a verified map reference we don't have, and inventing zone
 * names is worse than staying quiet.
 */
export function deathInsights(d: DeathsSummary, heroName?: string): string[] {
  const out: string[] = [];
  if (d.total === 0) return out;

  if (d.nemesis && heroName)
    out.push(
      `${heroName} killed you ${d.nemesis.count} of ${d.total} times — that's a matchup to build against, not bad luck.`,
    );

  // Only call out solo picks when they're the majority AND there were enough deaths to mean it.
  if (d.total >= 4 && d.soloPicks / d.total > 0.5)
    out.push(
      `${d.soloPicks} of ${d.total} deaths came with no teammate dying nearby — you're getting picked off alone, not losing fights.`,
    );

  if (d.burst >= 2 && d.burst / d.total >= 0.3)
    out.push(
      `${d.burst} deaths landed in under ${BURST_S}s — caught with no time to react, which is a positioning read rather than a mechanics one.`,
    );
  else if (d.medianTimeToKillS !== undefined && d.medianTimeToKillS >= 20)
    out.push(
      `Your deaths took a median ${Math.round(d.medianTimeToKillS)}s — you're staying in fights that are already lost. Leave earlier.`,
    );

  return out;
}

// --- Top-level assembly ---

export interface MatchAnalysis {
  matchId: number;
  durationS: number;
  focus: MatchPlayer;
  won: boolean;
  /** Average badge of the focus player's own team (rank context for the benchmark). */
  averageBadge?: number;
  wp: { points: WpPoint[]; swings: WpSwing[] };
  fundamentals: FundamentalRow[];
  economy: EconomyRow[];
  deaths: DeathsSummary;
}

/**
 * Analyze one match from `accountId`'s seat. Returns null when the account isn't in the match —
 * the caller should let the user pick a seat instead. `wpStats`/`ladder` are optional: without
 * them the respective section is empty and the UI hides it.
 */
export function analyzeMatch(
  match: MatchInfo,
  accountId: number,
  wpStats: WpStats | null,
  ladder: PlayerMetrics | null,
): MatchAnalysis | null {
  const focus = match.players.find((p) => p.account_id === accountId);
  if (!focus) return null;
  const teammates = match.players.filter(
    (p) => p.team === focus.team && p.player_slot !== focus.player_slot,
  );
  // Killers can only be enemies; mapping slot → hero lets a repeat killer be named (and countered).
  const enemyBySlot = new Map(
    match.players
      .filter((p) => p.team !== focus.team)
      .map((p) => [p.player_slot, p.hero_id]),
  );
  return {
    matchId: match.match_id,
    durationS: match.duration_s,
    focus,
    won: match.winning_team === focus.team,
    averageBadge:
      focus.team === "Team0"
        ? match.average_badge_team0
        : match.average_badge_team1,
    wp: wpTimeline(match, focus.team, wpStats),
    fundamentals: ladder
      ? matchFundamentals(focus, match.duration_s, ladder)
      : [],
    economy: benchmarkEconomy(
      economyRows(focus, match.duration_s),
      focus.hero_id,
      // Benchmark farm against one rank UP (the climb target), matching the fundamentals card.
      Math.min(
        11,
        Math.floor(
          ((focus.team === "Team0"
            ? match.average_badge_team0
            : match.average_badge_team1) ?? 0) / 10,
        ) + 1,
      ),
      wpStats,
    ),
    deaths: deathsSummary(focus, teammates, enemyBySlot),
  };
}
