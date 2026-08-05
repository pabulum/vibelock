import { describe, expect, it } from "vitest";
import type { HeroCounterRow } from "../types";
import { fitBradleyTerry, heroMatchups, matchupTable } from "./matchups";

/** Build the full symmetric matrix for heroes with given true strengths π and optional per-pair
 * counter effects (added to hero 1's win rate vs that enemy). Big n so sampling noise ≈ 0. */
function makeMatrix(
  strengths: Record<number, number>,
  counterVs1: Record<number, number> = {},
  n = 100000,
): HeroCounterRow[] {
  const ids = Object.keys(strengths).map(Number);
  const rows: HeroCounterRow[] = [];
  for (const i of ids)
    for (const j of ids) {
      if (i === j) continue;
      let p = strengths[i] / (strengths[i] + strengths[j]);
      if (i === 1 && counterVs1[j]) p += counterVs1[j];
      if (j === 1 && counterVs1[i]) p -= counterVs1[i];
      rows.push({
        hero_id: i,
        enemy_hero_id: j,
        wins: Math.round(n * p),
        matches_played: n,
        last_hits: 150 * n,
        enemy_last_hits: 150 * n,
      });
    }
  return rows;
}

describe("fitBradleyTerry", () => {
  it("recovers the strengths that generated the matrix, up to scale", () => {
    const truth = { 1: 1, 2: 1.5, 3: 0.6, 4: 1.2, 5: 0.9 };
    const pi = fitBradleyTerry(makeMatrix(truth));
    // Normalized to geometric mean 1, so compare ratios against the same normalization.
    const ids = Object.keys(truth).map(Number);
    const gm = Math.exp(
      ids.reduce((s, i) => s + Math.log(truth[i as keyof typeof truth]), 0) /
        ids.length,
    );
    for (const i of ids)
      expect(pi.get(i)!).toBeCloseTo(truth[i as keyof typeof truth] / gm, 3);
  });
});

describe("heroMatchups", () => {
  // The regression this whole file exists for. Hero 2 is simply STRONG — no counter structure
  // anywhere — and the raw "win rate minus my baseline" read put a hero like it in 37 of 38 real
  // heroes' tough lists. Under the fit its strength is explained, so it counters nobody.
  it("does not call a merely-strong hero a counter", () => {
    const matrix = makeMatrix({ 1: 1, 2: 1.6, 3: 0.7, 4: 1, 5: 1, 6: 0.9 });
    for (const heroId of [1, 3, 4, 5, 6]) {
      const m = heroMatchups(matrix, heroId);
      expect(m.tough.map((x) => x.enemyHeroId)).not.toContain(2);
      // …and with no real matchups in the data, both lists stay empty.
      expect(m.tough).toHaveLength(0);
      expect(m.favorable).toHaveLength(0);
    }
  });

  it("surfaces a genuine counter that strength does not explain", () => {
    // Hero 3 is WEAK (π 0.7) yet takes 3pt off hero 1 beyond what strength predicts; hero 2 is
    // strong and takes nothing. Only hero 3 is a counter.
    const matrix = makeMatrix(
      { 1: 1, 2: 1.6, 3: 0.7, 4: 1, 5: 1 },
      { 3: -0.03 },
    );
    const m = heroMatchups(matrix, 1);
    expect(m.tough.map((x) => x.enemyHeroId)).toEqual([3]);
    expect(m.tough[0].resid).toBeLessThan(-0.015);
    // The observed rate against hero 3 is still well ABOVE 50% — hero 3 is weak — which is exactly
    // why the raw read missed it and why the chip shows the residual instead.
    expect(m.tough[0].winRate).toBeGreaterThan(0.5);
    expect(m.tough[0].expected).toBeGreaterThan(m.tough[0].winRate);
  });

  it("reads the mirror cell as favourable for the counter's victim", () => {
    const matrix = makeMatrix(
      { 1: 1, 2: 1.6, 3: 0.7, 4: 1, 5: 1 },
      { 3: -0.03 },
    );
    const m = heroMatchups(matrix, 3);
    expect(m.favorable.map((x) => x.enemyHeroId)).toEqual([1]);
    expect(m.favorable[0].resid).toBeGreaterThan(0.015);
  });

  // A property of the global fit worth stating, because it looks like under-reporting and isn't:
  // a counter effect partially leaks into the two heroes' STRENGTHS, so a recovered residual is a
  // little smaller than the effect that generated it, and the more opponents counter a hero the
  // more of it is absorbed. That is the correct reading — a hero that loses to nearly everyone is
  // weak, not countered — and it means the shipped numbers are conservative rather than inflated.
  it("absorbs a counter into strength as it spreads across the roster", () => {
    const ids = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 };
    const oneEnemy = heroMatchups(makeMatrix(ids, { 3: -0.04 }), 1).tough[0]
      .resid;
    const everyEnemy = heroMatchups(
      makeMatrix(ids, { 2: -0.04, 3: -0.04, 4: -0.04, 5: -0.04 }),
      1,
    ).tough[0].resid;
    expect(oneEnemy).toBeLessThan(-0.029); // mostly recovered
    expect(everyEnemy).toBeGreaterThan(oneEnemy); // much of it now reads as "hero 1 is weak"
  });

  it("shrinks a thin cell toward the strength prediction", () => {
    // Same 3pt effect, but on 120 games instead of 100,000. The RESIDUAL_K=300 prior outweighs it,
    // so nothing is claimed — this is the floor that keeps a rank-and-patch slice honest.
    const thin = makeMatrix({ 1: 1, 2: 1.6, 3: 0.7 }, { 3: -0.03 }, 120);
    const m = heroMatchups(thin, 1);
    expect(m.tough).toHaveLength(0);
  });

  it("drops cells under the junk floor entirely", () => {
    const junk = makeMatrix({ 1: 1, 2: 1.5, 3: 0.6 }, {}, 40);
    expect(heroMatchups(junk, 1).tough).toHaveLength(0);
    expect(matchupTable(junk).resid.size).toBe(0);
  });

  it("ranks tough matchups worst-first and caps the list at five", () => {
    // A wide roster so six counters are a minority of it — with a small one the fit would (rightly)
    // read most of the effect as hero 1 being weak, and too little would survive to rank.
    const strengths: Record<number, number> = {};
    for (let i = 1; i <= 14; i++) strengths[i] = 1;
    const matrix = makeMatrix(strengths, {
      3: -0.02,
      4: -0.08,
      5: -0.04,
      6: -0.06,
      7: -0.03,
      8: -0.05,
    });
    const m = heroMatchups(matrix, 1);
    expect(m.tough).toHaveLength(5);
    expect(m.tough.map((x) => x.enemyHeroId)).toEqual([4, 6, 8, 5, 7]);
  });

  it("reuses a supplied table rather than refitting", () => {
    const matrix = makeMatrix({ 1: 1, 2: 1.6, 3: 0.7 }, { 3: -0.03 });
    const table = matchupTable(matrix);
    expect(heroMatchups(matrix, 1, table).tough[0].resid).toBeCloseTo(
      heroMatchups(matrix, 1).tough[0].resid,
      10,
    );
  });
});
