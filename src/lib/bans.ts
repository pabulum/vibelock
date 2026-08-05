// Which hero to ban — the decision that comes before the one lib/draft answers.
//
// The measured quantity is NOT "who is strongest" and not "who gets banned most". It is: how much
// win rate does this hero cost the heroes *you* play, and how often do you actually meet it. A hero
// that wrecks your pool but appears in one game in twenty is a worse ban than a mild problem you
// face every other game. So the ranking key is
//
//     expectedCost = presence × meanCost
//
// where `meanCost` is the average Bradley-Terry residual of that hero against your pool (lib/matchups
// — hero strength already fitted out, so this is the matchup and not the meta) and `presence` is the
// chance it shows up on the enemy team at this rank and patch.
//
// Three things this deliberately does not do, because they would each overstate the case:
//
//  - It does not claim a ban removes the hero. A ban lowers how often you meet it; it does not zero
//    it out. `expectedCost` is therefore labelled as the cost the hero imposes, and the gain from
//    banning is some fraction of it — the fraction is a matchmaking property we cannot measure from
//    here, so we don't invent a number for it.
//  - It does not hide that banning can cost you. A hero in your own pool is one you can no longer
//    pick, and for most ban systems that is a real loss of a good option. Flagged, never netted off
//    silently.
//  - It does not treat community ban counts as evidence. hero-ban-stats measures what players fear,
//    which is a different thing from what beats you; it rides along as context only.

import { residualFor, type MatchupTable } from "./matchups";
import type { Hero } from "../types";

/** Enemy hero slots per match — how many chances a given game has to contain the hero you're
 * considering banning. Shared with lib/draft's reading of the same matrix. */
const ENEMY_SLOTS = 6;

/** Residual worth naming a pool hero over, matching the surfacing floor in lib/matchups. */
const MARK_FLOOR = 0.005;

/** Expected cost, in win-rate points per queued game, below which a ban isn't worth discussing.
 *
 * A tenth of a point sounds severe against live values that top out near 0.16pt, and it is meant to:
 * `meanCost` averages roughly six residuals of sd 0.5pt, so its own sd is about 0.5/√6 ≈ 0.2pt, and
 * at a typical 16% presence the noise on `expectedCost` is around 0.03pt. The floor is therefore
 * about three standard errors, and it is why this list is usually two or three heroes long rather
 * than a ranked roster. A short list of real ones beats a long list with a tail of noise. */
const MIN_EXPECTED_COST = 0.001;

export interface BanCandidate {
  hero: Hero;
  /** Mean matchup residual against your pool, signed as a COST (positive = it beats your heroes). */
  meanCost: number;
  /** Chance this hero is on the enemy team in a given game, at this rank and patch. */
  presence: number;
  /** presence × meanCost — expected win-rate points it costs you per queued game. */
  expectedCost: number;
  /** The heroes in your pool it hurts most, worst first. */
  hits: Array<{ heroId: number; resid: number }>;
  /** You play this hero: banning it takes one of your own options off the board too. */
  inYourPool: boolean;
  /** Share of all bans this hero receives, when the ban stats are loaded. Context, never a reason. */
  banShare?: number;
}

export interface BanAdvice {
  candidates: BanCandidate[];
  /** Pool size the costs were averaged over — the honest denominator for the header. */
  poolSize: number;
}

/**
 * How often each hero turns up on the enemy team, from the counter matrix alone.
 *
 * The matrix is keyed (hero, enemy), so a hero's row sums to its games once per opponent faced.
 * That constant cancels in a share, which is why this needs no de-duplication: a hero's share of all
 * row-sums is its share of all hero slots, and multiplying by the six enemy slots turns it into the
 * expected number of copies on the enemy team. The result sums to 6 across the roster by
 * construction, which is the check that it means what it says.
 */
export function enemyPresence(
  matrix: Array<{ hero_id: number; matches_played: number }>,
): Map<number, number> {
  const perHero = new Map<number, number>();
  let total = 0;
  for (const r of matrix) {
    perHero.set(r.hero_id, (perHero.get(r.hero_id) ?? 0) + r.matches_played);
    total += r.matches_played;
  }
  const out = new Map<number, number>();
  if (total === 0) return out;
  for (const [id, n] of perHero)
    out.set(id, Math.min(1, (ENEMY_SLOTS * n) / total));
  return out;
}

/**
 * Rank the heroes worth banning for this player's pool.
 *
 * Requires a pool: "which hero costs me the most" is only a question once there is a *me*. Without
 * one the honest answer is the roster's strongest hero, which is not a ban recommendation — it's the
 * meta, and banning the meta is exactly the reflex the residuals exist to correct.
 */
export function banAdvice(opts: {
  table: MatchupTable;
  /** Your most-played heroes — what the cost is averaged over. */
  pool: Hero[];
  heroes: Hero[];
  presence: Map<number, number>;
  /** Total bans per hero id (hero-ban-stats), if loaded. Context only. */
  bansByHero?: Map<number, number> | null;
  /** How many candidates to return. */
  top?: number;
}): BanAdvice | null {
  const { table, pool, heroes, presence, bansByHero, top = 4 } = opts;
  if (pool.length === 0) return null;

  const totalBans = bansByHero
    ? [...bansByHero.values()].reduce((s, n) => s + n, 0)
    : 0;
  const poolIds = new Set(pool.map((h) => h.id));

  const candidates: BanCandidate[] = [];
  for (const enemy of heroes) {
    // Facing your own hero is a matchup like any other, but you cannot be on both teams — and more
    // to the point, a hero you play is one you'd rather keep available than remove.
    const hits: Array<{ heroId: number; resid: number }> = [];
    let sum = 0;
    for (const mine of pool) {
      if (mine.id === enemy.id) continue;
      const resid = residualFor(table, mine.id, enemy.id);
      sum += resid;
      if (resid <= -MARK_FLOOR) hits.push({ heroId: mine.id, resid });
    }
    const against = pool.filter((h) => h.id !== enemy.id).length;
    if (against === 0) continue;
    // Flip the sign: a residual is what the matchup does to YOU, a cost is what it takes FROM you.
    const meanCost = -(sum / against);
    const p = presence.get(enemy.id) ?? 0;
    const expectedCost = meanCost * p;
    if (expectedCost < MIN_EXPECTED_COST) continue;
    hits.sort((a, b) => a.resid - b.resid);
    candidates.push({
      hero: enemy,
      meanCost,
      presence: p,
      expectedCost,
      hits,
      inYourPool: poolIds.has(enemy.id),
      banShare:
        bansByHero && totalBans > 0
          ? (bansByHero.get(enemy.id) ?? 0) / totalBans
          : undefined,
    });
  }

  candidates.sort((a, b) => b.expectedCost - a.expectedCost);
  return { candidates: candidates.slice(0, top), poolSize: pool.length };
}
