// Turns the hero-vs-hero counter matrix into the selected hero's notable matchups.
//
// hero-counter-stats returns the full matrix (every hero vs every enemy), so we
// filter to the selected hero, take each enemy's win rate, and compare it to that
// hero's overall win rate. Enemies well below baseline counter you (build against
// them); well above, you're favoured. These feed the counters panel: one click
// adds a tough hero to the enemy list and the build-vs-them items appear.
//
// Note: the win rate is whole-game "this hero was on the enemy team", not lane-only
// (the API's same_lane_filter is a no-op here). `laneCsDelta` is a separate lane hint.

import type { HeroCounterRow, HeroMatchups, Matchup } from '../types';

const MIN_SAMPLE = 300; // matchups thinner than this are too noisy to surface (raw mode)
const MIN_DELTA = 0.02; // only show matchups that move win rate by ≥ 2 pts
const TOP = 5;

// --- Bradley-Terry de-noising (the "De-noise" toggle) ---
// Raw matchup deltas mix two different things: "this enemy counters me" and "this enemy is simply
// strong right now" — a meta hero drags EVERY matchup against it below baseline, and the raw list
// happily calls that a counter. Bradley-Terry separates them: fit one strength number per hero
// from the whole matrix at once (P(i beats j) = πᵢ/(πᵢ+πⱼ), the same family as Elo), which pins
// down what each cell is *expected* to be from strengths alone. The matchup signal is then the
// RESIDUAL — how much worse/better this cell is than the strengths predict — shrunk toward zero by
// its sample. Strength effects cancel out; what's left is genuine rock-paper-scissors structure.
const BT_MIN_SAMPLE = 50; // shrinkage handles thin cells, so the floor only drops junk
const BT_RESIDUAL_K = 300; // games of "the strengths are right" prior a cell must overcome
// Residuals live on a smaller scale than raw deltas — strengths explain the live matrix to within
// ~1pt RMSE — so the surfacing floor is lower than raw mode's: a 1pt strength-adjusted edge at
// these samples (tens of thousands of games per cell) is ~3 sampling errors, i.e. real.
const BT_MIN_DELTA = 0.01;
const BT_ITERS = 200;
const BT_TOL = 1e-9;

/**
 * Bradley-Terry strengths π (hero id → strength) fitted on the full matrix with Hunter's MM
 * updates: πᵢ ← (total wins of i) / Σⱼ nᵢⱼ/(πᵢ+πⱼ), iterated to convergence, normalized to
 * geometric mean 1. The matrix has each pair twice (i-vs-j and j-vs-i, complementary views of the
 * same games), so both rows just contribute their own wins — no symmetrization needed.
 */
export function fitBradleyTerry(matrix: HeroCounterRow[]): Map<number, number> {
  const heroIds = [...new Set(matrix.flatMap((r) => [r.hero_id, r.enemy_hero_id]))];
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
      for (const p of pairs.get(id) ?? []) denom += p.n / (cur + pi.get(p.other)!);
      const next = denom > 0 ? Math.max(1e-6, w / denom) : cur;
      maxDelta = Math.max(maxDelta, Math.abs(next - cur));
      pi.set(id, next);
    }
    // Normalize to geometric mean 1 so strengths stay comparable across iterations.
    const logMean = heroIds.reduce((s, id) => s + Math.log(pi.get(id)!), 0) / heroIds.length;
    const scale = Math.exp(logMean);
    for (const id of heroIds) pi.set(id, pi.get(id)! / scale);
    if (maxDelta < BT_TOL) break;
  }
  return pi;
}

/**
 * The selected hero's notable matchups. With `denoise` on, deltas are Bradley-Terry residuals
 * (see above): `winRate` stays the observed rate, `expectedWinRate` carries what strengths alone
 * predict, and `delta` = shrunk(observed) − expected — so "Tough" means *counters you*, not
 * "is currently meta".
 */
export function heroMatchups(
  matrix: HeroCounterRow[],
  heroId: number,
  denoise = false,
): HeroMatchups {
  const minSample = denoise ? BT_MIN_SAMPLE : MIN_SAMPLE;
  const rows = matrix.filter((r) => r.hero_id === heroId && r.matches_played >= minSample);

  const totals = rows.reduce(
    (a, r) => ({ wins: a.wins + r.wins, matches: a.matches + r.matches_played }),
    { wins: 0, matches: 0 },
  );
  const baseline = totals.matches > 0 ? totals.wins / totals.matches : 0.5;

  const pi = denoise ? fitBradleyTerry(matrix) : null;
  const all: Matchup[] = rows.map((r) => {
    const n = r.matches_played;
    const observed = r.wins / n;
    let delta = observed - baseline;
    let expectedWinRate: number | undefined;
    if (pi) {
      const mine = pi.get(r.hero_id) ?? 1;
      const theirs = pi.get(r.enemy_hero_id) ?? 1;
      expectedWinRate = mine / (mine + theirs);
      // Shrink the observed rate toward the BT expectation, then read the leftover: a thin cell
      // reports ~no counter effect; a big one keeps its genuine residual.
      delta = (r.wins + BT_RESIDUAL_K * expectedWinRate) / (n + BT_RESIDUAL_K) - expectedWinRate;
    }
    return {
      enemyHeroId: r.enemy_hero_id,
      winRate: observed,
      delta,
      expectedWinRate,
      sample: n,
      laneCsDelta: (r.last_hits - r.enemy_last_hits) / n,
    };
  });

  const minDelta = denoise ? BT_MIN_DELTA : MIN_DELTA;
  const tough = all
    .filter((m) => m.delta <= -minDelta)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, TOP);
  const favorable = all
    .filter((m) => m.delta >= minDelta)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, TOP);

  return { baseline, tough, favorable };
}
