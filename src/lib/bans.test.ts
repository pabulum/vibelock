import { describe, expect, it } from "vitest";
import { banAdvice, enemyPresence } from "./bans";
import { matchupTable } from "./matchups";
import type { Hero, HeroCounterRow } from "../types";

const hero = (id: number): Hero =>
  ({ id, name: `H${id}`, image: "", signatureClasses: [] }) as unknown as Hero;
const heroes = Array.from({ length: 10 }, (_, i) => hero(i + 1));

/** A full matrix over `heroCount` equally strong heroes. `counters[i][j]` shifts hero i's win rate
 * against enemy j; `plays[id]` scales how many games that hero appears in. */
function matrix(
  heroCount: number,
  counters: Record<number, Record<number, number>> = {},
  plays: Record<number, number> = {},
): HeroCounterRow[] {
  const rows: HeroCounterRow[] = [];
  for (let i = 1; i <= heroCount; i++)
    for (let j = 1; j <= heroCount; j++) {
      if (i === j) continue;
      const n = 100000 * (plays[i] ?? 1) * (plays[j] ?? 1);
      rows.push({
        hero_id: i,
        enemy_hero_id: j,
        wins: Math.round(n * (0.5 + (counters[i]?.[j] ?? 0))),
        matches_played: n,
        last_hits: 0,
        enemy_last_hits: 0,
      });
    }
  return rows;
}

const advise = (
  m: HeroCounterRow[],
  pool: number[],
  bans?: Map<number, number>,
) =>
  banAdvice({
    table: matchupTable(m),
    pool: pool.map(hero),
    heroes,
    presence: enemyPresence(m),
    bansByHero: bans,
  });

describe("enemyPresence", () => {
  it("sums to the six enemy slots across the roster", () => {
    // The self-check the estimator is built on: shares of all hero slots, times six slots.
    const total = [...enemyPresence(matrix(10, {}, { 3: 2 })).values()].reduce(
      (s, x) => s + x,
      0,
    );
    expect(total).toBeCloseTo(6, 6);
  });

  it("is higher for a hero that is played more", () => {
    const p = enemyPresence(matrix(10, {}, { 3: 2 }));
    expect(p.get(3)!).toBeGreaterThan(p.get(4)! * 1.5);
    // …and still a probability. A hero played enough to fill an enemy slot every game caps at 1
    // rather than reporting nonsense, which is what keeps expectedCost interpretable.
    const skewed = enemyPresence(matrix(10, {}, { 3: 40 }));
    expect(skewed.get(3)!).toBeLessThanOrEqual(1);
  });
});

describe("banAdvice", () => {
  it("ranks by cost to YOUR pool, not by who is strongest", () => {
    // Hero 9 hard-counters the pool. Hero 8 is simply a strong hero and counters nobody: the whole
    // point of banning off residuals is that it does not end up as the recommendation.
    const m = matrix(10, {
      1: { 9: -0.05 },
      2: { 9: -0.05 },
      8: { 1: 0.05, 2: 0.05, 3: 0.05, 4: 0.05, 5: 0.05, 6: 0.05, 7: 0.05 },
    });
    const a = advise(m, [1, 2, 3])!;
    expect(a.candidates[0].hero.id).toBe(9);
    expect(a.candidates.map((c) => c.hero.id)).not.toContain(8);
    expect(a.poolSize).toBe(3);
  });

  it("prefers the equally nasty hero you actually meet more often", () => {
    // Heroes 7 and 9 hurt the pool identically; 7 is played three times as much. Frequency is the
    // only thing separating them, and it has to be what decides — a ban you rarely cash in is worth
    // less than a smaller problem you meet every other game.
    const m = matrix(
      10,
      { 1: { 9: -0.06, 7: -0.06 }, 2: { 9: -0.06, 7: -0.06 } },
      { 7: 3 },
    );
    const a = advise(m, [1, 2])!;
    expect(a.candidates[0].hero.id).toBe(7);
    const nine = a.candidates.find((c) => c.hero.id === 9)!;
    expect(a.candidates[0].presence).toBeGreaterThan(nine.presence);
    expect(a.candidates[0].expectedCost).toBeGreaterThan(nine.expectedCost);
  });

  it("names the pool heroes a ban would protect, worst first", () => {
    const m = matrix(10, { 1: { 9: -0.02 }, 2: { 9: -0.06 } });
    const c = advise(m, [1, 2, 3])!.candidates.find((x) => x.hero.id === 9)!;
    expect(c.hits.map((h) => h.heroId)).toEqual([2, 1]);
    expect(c.hits[0].resid).toBeLessThan(c.hits[1].resid);
  });

  it("flags a candidate you play yourself rather than netting it off", () => {
    // Hero 3 is in the pool AND beats the rest of it. It stays on the list — banning it is a real
    // option — but the flag is what lets the UI say it costs you a pick.
    const m = matrix(10, { 1: { 3: -0.06 }, 2: { 3: -0.06 } });
    const c = advise(m, [1, 2, 3])!.candidates.find((x) => x.hero.id === 3);
    expect(c?.inYourPool).toBe(true);
    // Its own row is excluded from the average — a hero can't be its own matchup — so the cost is
    // the mean over the OTHER two, near the 6pt effect the matrix was built with. (Near, not equal:
    // the fit absorbs part of any counter effect into strength; see lib/matchups.)
    expect(c!.meanCost).toBeGreaterThan(0.04);
  });

  it("drops heroes that cost the pool nothing", () => {
    const a = advise(matrix(10), [1, 2, 3])!;
    expect(a.candidates).toHaveLength(0);
  });

  it("carries community ban share as context, normalized", () => {
    const m = matrix(10, { 1: { 9: -0.05 }, 2: { 9: -0.05 } });
    const c = advise(
      m,
      [1, 2],
      new Map([
        [9, 300],
        [8, 100],
      ]),
    )!.candidates.find((x) => x.hero.id === 9)!;
    expect(c.banShare).toBeCloseTo(0.75, 6);
  });

  it("returns null without a pool — there is no 'costs me' without a me", () => {
    expect(advise(matrix(10, { 1: { 9: -0.05 } }), [])).toBeNull();
  });
});
