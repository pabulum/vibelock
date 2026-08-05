// Draft: which hero to pick against the comp you can already see.
//
// This is the one decision the rest of the app skipped. Everything else here starts from "you are
// playing hero X" — the build, the skill order, the counters, the pace read all condition on a hero
// that has already been chosen. But at hero select the enemy picks land first, and the question is
// the other way round: given THAT comp, which of the heroes I can actually play is the best pick?
//
// The answer has two parts and they are not the same size:
//
//   base       your expected win rate on the hero regardless of opponent — your own record on it,
//              shrunk toward its current ladder rate at this rank and patch (the same number the
//              "Your heroes" strip orders by).
//   compEdge   the sum of the hero's matchup residuals against each enemy in the comp
//              (lib/matchups — Bradley-Terry, so this is rock-paper-scissors with hero strength
//              already removed).
//
// Measured on the live matrix, compEdge spreads about 2.5pt across a realistic five-hero pool
// (p90 4.0pt), while the same player's base spreads far wider than that between their main and
// their fifth-best hero. So the honest headline is usually "play your best hero" — and saying that
// out loud is the point. A tool that always finds a counter-pick talks people into heroes they
// cannot play, which loses more win rate than any matchup on the board is worth. `reorders` exists
// so the UI can tell the two cases apart.
//
// Summing residuals across the comp is the additive model, and it was checked rather than assumed:
// over 15.6M match_player rows, win rate kept falling at the same rate as more of a hero's
// residual-identified counters appeared on the enemy team (−2.04pt for the first, −2.60pt for the
// second), with no saturation. See the note at the top of lib/matchups for the full design.

import { residualFor, type MatchupTable } from "./matchups";
import type { Hero } from "../types";

/** Ladder games of evidence the hero's current rate is worth against your own record. A 20-game
 * dabble still reads mostly as the ladder; a 300-game main mostly as you. Same constant the
 * "Your heroes" strip uses, and deliberately so — the two orderings must agree when no comp is
 * selected, or the draft panel looks like it disagrees with the header about your own pool. */
const PROFILE_PRIOR_GAMES = 20;

/** Residual big enough to name the enemy it came from. Matches the surfacing floor in lib/matchups,
 * so a matchup that is worth a chip up in "Tough vs" is exactly one worth a mark down here. */
const MARK_FLOOR = 0.005;

/** How much the comp edge has to move things before the panel claims the comp changed the answer.
 * Below this the ordering is the pool's own ordering with noise on top, and the panel says so. */
const REORDER_EPS = 0.002;

export interface DraftMark {
  enemyHeroId: number;
  /** Signed residual against that enemy (positive = you are the problem for them). */
  resid: number;
}

export interface DraftCandidate {
  hero: Hero;
  /** Your games on this hero. 0 ⇒ an off-pool suggestion. */
  matches: number;
  /** Comp-blind expected win rate, already carrying the new-hero tax when off-pool. */
  base: number;
  /** Summed matchup residual against every enemy in the comp. */
  compEdge: number;
  /** base + compEdge — the ordering key. */
  expected: number;
  /** The enemies that actually move this hero, biggest absolute residual first. */
  marks: DraftMark[];
  /** Worst lane residual in the comp, in souls at the 10-minute tick. Souls are not win-rate points
   * and are never folded into `expected`; this is a caution about the first ten minutes, shown
   * beside the number rather than inside it. */
  worstLane: { enemyHeroId: number; resid: number } | null;
  offPool: boolean;
}

export interface DraftRanking {
  candidates: DraftCandidate[];
  /** Off-pool heroes worth knowing about, already taxed. Empty when nothing clears your pool. */
  offPool: DraftCandidate[];
  /** True when the comp edge changes which of your own heroes comes first. False ⇒ the comp does
   * not move your order and the panel should say to play your best hero. */
  reorders: boolean;
  /** How many enemies the ranking was computed against. */
  enemyCount: number;
}

export interface PoolEntry {
  hero: Hero;
  matches: number;
  wins: number;
}

/** A hero's overall win rate and games across the whole counter matrix — the ladder rate at the
 * selected rank and patch, for free, out of data the counters panel already fetched. Deriving it
 * here rather than taking heroMeta keeps the draft panel alive for visitors with no Steam id
 * linked, who are exactly the ones with no other way to judge an unfamiliar hero. */
export function ladderRates(
  matrix: Array<{ hero_id: number; wins: number; matches_played: number }>,
): Map<number, { winRate: number; games: number }> {
  const acc = new Map<number, { wins: number; games: number }>();
  for (const r of matrix) {
    const cur = acc.get(r.hero_id) ?? { wins: 0, games: 0 };
    cur.wins += r.wins;
    cur.games += r.matches_played;
    acc.set(r.hero_id, cur);
  }
  const out = new Map<number, { winRate: number; games: number }>();
  for (const [id, a] of acc)
    out.set(id, {
      winRate: a.games > 0 ? a.wins / a.games : 0.5,
      games: a.games,
    });
  return out;
}

function marksFor(
  table: MatchupTable,
  heroId: number,
  enemies: number[],
): { compEdge: number; marks: DraftMark[] } {
  let compEdge = 0;
  const marks: DraftMark[] = [];
  for (const e of enemies) {
    const resid = residualFor(table, heroId, e);
    compEdge += resid;
    if (Math.abs(resid) >= MARK_FLOOR) marks.push({ enemyHeroId: e, resid });
  }
  marks.sort((a, b) => Math.abs(b.resid) - Math.abs(a.resid));
  return { compEdge, marks };
}

/** Lane read for the worst enemy in the comp, from the bake's residual matrix (lib/laneMatchups
 * owns the display thresholds; this only needs the numbers). */
function worstLaneIn(
  laneMatchups: Record<string, Record<string, [number, number, number]>> | null,
  heroId: number,
  enemies: number[],
): { enemyHeroId: number; resid: number } | null {
  const row = laneMatchups?.[String(heroId)];
  if (!row) return null;
  let worst: { enemyHeroId: number; resid: number } | null = null;
  for (const e of enemies) {
    const tuple = row[String(e)];
    if (!tuple) continue;
    const resid = tuple[2];
    if (!worst || resid < worst.resid) worst = { enemyHeroId: e, resid };
  }
  return worst;
}

/**
 * Rank the heroes you could pick against this comp.
 *
 * `pool` is your most-played heroes when a profile is linked. Without one the ranking falls back to
 * the ladder's own strongest heroes at this rank — still a real answer to "who beats this comp",
 * just without the half of it that is about you.
 */
export function draftRanking(opts: {
  table: MatchupTable;
  /** The enemy comp, live — no fetch depends on it, so the panel re-ranks on every pick. */
  enemies: number[];
  heroes: Hero[];
  /** Your most-played heroes, or null when no profile is linked. */
  pool: PoolEntry[] | null;
  /** Ladder win rate and games per hero (see `ladderRates`). */
  ladder: Map<number, { winRate: number; games: number }>;
  /** The bake's lane residual matrix (wpStats.lane.matchups), or null before a bake emits one. */
  laneMatchups: Record<string, Record<string, [number, number, number]>> | null;
  /** Win rate surrendered while learning a hero you don't play (features/useProfile). */
  newHeroTax: number;
  /** Ladder games a hero needs before it can be suggested off-pool. */
  minLadderGames?: number;
  /** How many off-pool suggestions to return. */
  offPoolCount?: number;
}): DraftRanking {
  const {
    table,
    enemies,
    heroes,
    pool,
    ladder,
    laneMatchups,
    newHeroTax,
    minLadderGames = 2000,
    offPoolCount = 3,
  } = opts;

  const enemySet = new Set(enemies);
  const build = (
    hero: Hero,
    matches: number,
    wins: number,
    offPool: boolean,
  ): DraftCandidate => {
    const meta = ladder.get(hero.id);
    const ladderWr = meta?.winRate ?? 0.5;
    // Your record shrunk toward the ladder rate; with no record at all this collapses to the
    // ladder rate, which is the right prior for a hero you have never touched.
    const own =
      matches > 0
        ? (wins + PROFILE_PRIOR_GAMES * ladderWr) /
          (matches + PROFILE_PRIOR_GAMES)
        : ladderWr;
    const base = offPool ? own - newHeroTax : own;
    const { compEdge, marks } = marksFor(table, hero.id, enemies);
    return {
      hero,
      matches,
      base,
      compEdge,
      expected: base + compEdge,
      marks,
      worstLane: worstLaneIn(laneMatchups, hero.id, enemies),
      offPool,
    };
  };

  const poolRows = (pool ?? [])
    .filter((p) => !enemySet.has(p.hero.id))
    .map((p) => build(p.hero, p.matches, p.wins, false));

  const playedIds = new Set(poolRows.map((r) => r.hero.id));
  const offPoolRows = heroes
    .filter(
      (h) =>
        !playedIds.has(h.id) &&
        !enemySet.has(h.id) &&
        (ladder.get(h.id)?.games ?? 0) >= minLadderGames,
    )
    .map((h) => build(h, 0, 0, poolRows.length > 0))
    .sort((a, b) => b.expected - a.expected);

  // With a pool, the off-pool list is a short tail of "and this would have been better" — taxed,
  // and only worth showing when it actually beats the pool's own best. Without one it IS the list.
  const candidates = poolRows.length
    ? poolRows.sort((a, b) => b.expected - a.expected)
    : offPoolRows.slice(0, 6);
  const bestPool = candidates[0]?.expected ?? -Infinity;
  const offPool = poolRows.length
    ? offPoolRows.filter((r) => r.expected > bestPool).slice(0, offPoolCount)
    : [];

  // Does the comp actually change the answer? Compare the comp-aware winner with the comp-blind
  // one; ties inside REORDER_EPS count as "no", since that is noise, not a recommendation.
  const blindBest = [...candidates].sort((a, b) => b.base - a.base)[0];
  const reorders =
    candidates.length > 1 &&
    blindBest !== undefined &&
    candidates[0].hero.id !== blindBest.hero.id &&
    candidates[0].expected - blindBest.expected >= REORDER_EPS;

  return { candidates, offPool, reorders, enemyCount: enemies.length };
}
