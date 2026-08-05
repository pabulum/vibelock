// Hero-vs-hero matchups, de-confounded.
//
// hero-counter-stats returns the full matrix (every hero vs every enemy), so we fit it once and
// filter to the selected hero. The naive read — this enemy's win rate against you, minus your own
// overall rate — is what this file used to ship, and it does not measure matchups at all. It
// measures *who is strong right now*: a meta hero drags every cell against it below every hero's
// baseline, so it lands in everybody's "Tough vs" list. Measured on the live matrix (38 heroes,
// 89M cell-games), the raw read put Graves in 37 of 38 heroes' tough lists, Victor in 36 and Seven
// in 35 — five chips that were the same five chips no matter which hero you had selected.
//
// Bradley-Terry separates the two. One strength number per hero is fitted from the whole matrix at
// once (P(i beats j) = πᵢ/(πᵢ+πⱼ), the same family as Elo), which pins down what each cell should be
// from strengths alone. The matchup is the RESIDUAL — how far the cell sits from that — shrunk
// toward zero by its sample. Strength cancels; genuine rock-paper-scissors is what's left. On the
// same matrix the most frequent residual counter appears in 9 lists of 38, which is what a real
// matchup structure looks like.
//
// The residuals are small and real. Strengths explain the matrix to 0.49pt RMSE and the residual sd
// is 0.50pt, so a "counter" in Deadlock is worth about a point of win rate, not the five points the
// raw delta advertised. Two checks say the point is really there:
//
//   - Split-half across two disjoint 21-day windows: residuals replicate at r = 0.76. (The raw
//     delta replicates at r = 0.945 — but that is the confound reproducing itself, since "Graves is
//     strong" is perfectly stable and tells you nothing about your matchup.)
//   - Ground truth over 15.6M match_player rows (/v1/sql): for each of 12 heroes, win rate against
//     its three residual-identified counters was compared with its win rate against three
//     STRENGTH-MATCHED placebo enemies (mean π 1.036 vs 1.026, mean residual −1.15pt vs −0.01pt).
//     All 12 heroes lost more win rate to the counters than to the strength-matched placebos, and
//     the loss did not saturate as more of them appeared (−2.04pt for the first, −2.60pt for the
//     second), which is what licenses treating a comp as the sum of its parts in lib/draft.
//
// Note: the win rate is whole-game "this hero was on the enemy team", not lane-only. That holds
// only because api/deadlock.ts sends same_lane_filter=false explicitly — the API's default is TRUE.
// A whole-game matchup and a lane matchup are different questions with opposite answers, and the
// lane one is measured separately in lib/laneMatchups. `laneCsDelta` is a crude lane hint only.

import type { HeroCounterRow, HeroMatchups, Matchup } from "../types";

/** Cells thinner than this are dropped as junk. The floor is deliberately low because shrinkage,
 * not exclusion, is what polices thin cells — a 200-game cell is pulled most of the way back to the
 * strength prediction and cannot clear the surfacing floor below without being wildly extreme. */
const MIN_SAMPLE = 100;

/** Games of "the strengths are right" prior each cell must overcome. Inert at live sample sizes
 * (the median cell holds ~39,000 games) and decisive on the thin rank-and-patch slices, which is
 * the whole point of having it. */
const RESIDUAL_K = 300;

/** Residual a matchup must clear to be shown, in win-rate points.
 *
 * Calibrated on the two disjoint windows above rather than picked: of the cells clearing 0.5pt in
 * one window, 93.6% carry the same sign in the other, and every hero on the roster gets a populated
 * list (4.6 entries on average). Tightening to 0.75pt buys 96.3% agreement but empties the panel
 * for 6 heroes; 1.0pt reaches 100% and leaves 17 heroes with nothing to show. 0.5pt is the point
 * where the list is both trustworthy and complete. */
const MIN_RESID = 0.005;

const TOP = 5;

const BT_ITERS = 200;
const BT_TOL = 1e-9;

/** A residual as signed win-rate points — the currency the matchup chips and the draft panel are
 * both in, formatted once so they cannot drift apart. Uses the typographic minus, like every other
 * signed number on the page. */
export function signedPt(resid: number): string {
  return `${resid > 0 ? "+" : resid < 0 ? "−" : "±"}${Math.abs(resid * 100).toFixed(1)}`;
}

/** Fitted Bradley-Terry strengths — the shared basis for the matchup chips and the draft panel, so
 * the two can never disagree about what a cell was expected to be. */
export interface MatchupTable {
  /** Hero id → strength π, normalized to geometric mean 1. */
  strengths: Map<number, number>;
  /** "heroId:enemyHeroId" → the shrunk residual, in win-rate fraction. */
  resid: Map<string, number>;
}

/**
 * Bradley-Terry strengths π (hero id → strength) fitted on the full matrix with Hunter's MM
 * updates: πᵢ ← (total wins of i) / Σⱼ nᵢⱼ/(πᵢ+πⱼ), iterated to convergence, normalized to
 * geometric mean 1. The matrix carries each pair twice (i-vs-j and j-vs-i, complementary views of
 * the same games), so both rows just contribute their own wins — no symmetrization needed.
 */
export function fitBradleyTerry(matrix: HeroCounterRow[]): Map<number, number> {
  const heroIds = [
    ...new Set(matrix.flatMap((r) => [r.hero_id, r.enemy_hero_id])),
  ];
  const pi = new Map(heroIds.map((id) => [id, 1]));
  const winsOf = new Map<number, number>();
  const pairs = new Map<number, Array<{ other: number; n: number }>>();
  for (const r of matrix) {
    winsOf.set(r.hero_id, (winsOf.get(r.hero_id) ?? 0) + r.wins);
    let arr = pairs.get(r.hero_id);
    if (!arr) pairs.set(r.hero_id, (arr = []));
    arr.push({ other: r.enemy_hero_id, n: r.matches_played });
  }

  for (let it = 0; it < BT_ITERS; it++) {
    let maxDelta = 0;
    for (const id of heroIds) {
      const w = winsOf.get(id) ?? 0;
      const cur = pi.get(id)!;
      let denom = 0;
      for (const p of pairs.get(id) ?? [])
        denom += p.n / (cur + pi.get(p.other)!);
      const next = denom > 0 ? Math.max(1e-6, w / denom) : cur;
      maxDelta = Math.max(maxDelta, Math.abs(next - cur));
      pi.set(id, next);
    }
    // Normalize to geometric mean 1 so strengths stay comparable across iterations.
    const logMean =
      heroIds.reduce((s, id) => s + Math.log(pi.get(id)!), 0) / heroIds.length;
    const scale = Math.exp(logMean);
    for (const id of heroIds) pi.set(id, pi.get(id)! / scale);
    if (maxDelta < BT_TOL) break;
  }
  return pi;
}

/** Fit the matrix once: strengths, and every cell's sample-shrunk residual against them. */
export function matchupTable(matrix: HeroCounterRow[]): MatchupTable {
  const strengths = fitBradleyTerry(matrix);
  const resid = new Map<string, number>();
  for (const r of matrix) {
    if (r.matches_played < MIN_SAMPLE) continue;
    const mine = strengths.get(r.hero_id) ?? 1;
    const theirs = strengths.get(r.enemy_hero_id) ?? 1;
    const expected = mine / (mine + theirs);
    // Shrink the observed rate toward the strength prediction, then read the leftover: a thin cell
    // reports ~no matchup, a big one keeps its residual intact.
    const shrunk =
      (r.wins + RESIDUAL_K * expected) / (r.matches_played + RESIDUAL_K);
    resid.set(`${r.hero_id}:${r.enemy_hero_id}`, shrunk - expected);
  }
  return { strengths, resid };
}

/** One cell's shrunk residual, or 0 when the pair was never measured — the neutral answer, which is
 * also the right one to sum into a comp edge for a hero the matrix has nothing to say about. */
export function residualFor(
  table: MatchupTable,
  heroId: number,
  enemyHeroId: number,
): number {
  return table.resid.get(`${heroId}:${enemyHeroId}`) ?? 0;
}

/**
 * The selected hero's notable matchups: enemies whose residual against it clears the surfacing
 * floor, worst first. "Tough" here means *counters you*, not "is currently strong" — the strength
 * component is exactly what the fit removed.
 */
export function heroMatchups(
  matrix: HeroCounterRow[],
  heroId: number,
  table = matchupTable(matrix),
): HeroMatchups {
  const rows = matrix.filter(
    (r) => r.hero_id === heroId && r.matches_played >= MIN_SAMPLE,
  );

  const totals = rows.reduce(
    (a, r) => ({
      wins: a.wins + r.wins,
      matches: a.matches + r.matches_played,
    }),
    { wins: 0, matches: 0 },
  );
  const baseline = totals.matches > 0 ? totals.wins / totals.matches : 0.5;

  const all: Matchup[] = rows.map((r) => {
    const n = r.matches_played;
    const mine = table.strengths.get(r.hero_id) ?? 1;
    const theirs = table.strengths.get(r.enemy_hero_id) ?? 1;
    return {
      enemyHeroId: r.enemy_hero_id,
      winRate: r.wins / n,
      expected: mine / (mine + theirs),
      resid: residualFor(table, heroId, r.enemy_hero_id),
      sample: n,
      laneCsDelta: (r.last_hits - r.enemy_last_hits) / n,
    };
  });

  const tough = all
    .filter((m) => m.resid <= -MIN_RESID)
    .sort((a, b) => a.resid - b.resid)
    .slice(0, TOP);
  const favorable = all
    .filter((m) => m.resid >= MIN_RESID)
    .sort((a, b) => b.resid - a.resid)
    .slice(0, TOP);

  return { baseline, tough, favorable };
}
