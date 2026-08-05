import { describe, expect, it } from "vitest";
import { draftRanking, ladderRates, type PoolEntry } from "./draft";
import { matchupTable } from "./matchups";
import type { Hero, HeroCounterRow } from "../types";

const hero = (id: number): Hero =>
  ({ id, name: `H${id}`, image: "", signatureClasses: [] }) as unknown as Hero;

/** Full matrix over `n` equally strong heroes, with per-pair counter effects applied to `victim`. */
function matrix(
  heroCount: number,
  counters: Record<number, Record<number, number>> = {},
  n = 100000,
): HeroCounterRow[] {
  const rows: HeroCounterRow[] = [];
  for (let i = 1; i <= heroCount; i++)
    for (let j = 1; j <= heroCount; j++) {
      if (i === j) continue;
      const e = counters[i]?.[j] ?? 0;
      const p = 0.5 + e;
      rows.push({
        hero_id: i,
        enemy_hero_id: j,
        wins: Math.round(n * p),
        matches_played: n,
        last_hits: 0,
        enemy_last_hits: 0,
      });
    }
  return rows;
}

const heroes = Array.from({ length: 10 }, (_, i) => hero(i + 1));

function rank(opts: {
  m: HeroCounterRow[];
  enemies: number[];
  pool?: PoolEntry[] | null;
  lane?: Record<string, Record<string, [number, number, number]>> | null;
}) {
  return draftRanking({
    table: matchupTable(opts.m),
    enemies: opts.enemies,
    heroes,
    pool: opts.pool ?? null,
    ladder: ladderRates(opts.m),
    laneMatchups: opts.lane ?? null,
    newHeroTax: 0.02,
    minLadderGames: 0,
  });
}

describe("ladderRates", () => {
  it("sums a hero's whole row into its overall rate", () => {
    const m = matrix(4, { 1: { 2: 0.1 } });
    const r = ladderRates(m);
    // Hero 1 wins 60% of one of its three cells and 50% of the rest.
    expect(r.get(1)!.winRate).toBeCloseTo((0.6 + 0.5 + 0.5) / 3, 6);
    expect(r.get(1)!.games).toBe(300000);
  });
});

describe("draftRanking", () => {
  const pool: PoolEntry[] = [
    { hero: hero(1), matches: 200, wins: 100 }, // 50%
    { hero: hero(2), matches: 200, wins: 100 }, // 50%
    { hero: hero(3), matches: 200, wins: 100 }, // 50%
  ];

  it("lets a big matchup swing overcome a small gap in your own record", () => {
    // Hero 1 is the better pick on paper (54% vs 50% personal) but is hard-countered by both
    // enemies; hero 2 answers them. Only then does the panel claim the comp changed the answer.
    const m = matrix(10, {
      2: { 9: 0.05, 10: 0.05 },
      1: { 9: -0.05, 10: -0.05 },
    });
    const skewed: PoolEntry[] = [
      { hero: hero(1), matches: 400, wins: 216 }, // 54%
      { hero: hero(2), matches: 400, wins: 200 }, // 50%
    ];
    expect(rank({ m, enemies: [], pool: skewed }).candidates[0].hero.id).toBe(
      1,
    );
    const r = rank({ m, enemies: [9, 10], pool: skewed });
    expect(r.candidates[0].hero.id).toBe(2);
    expect(r.candidates[0].compEdge).toBeGreaterThan(0);
    expect(r.reorders).toBe(true);
  });

  it("sums the comp rather than reading one enemy", () => {
    const m = matrix(10, { 2: { 9: 0.04, 10: 0.04 } });
    const one = rank({ m, enemies: [9], pool }).candidates.find(
      (c) => c.hero.id === 2,
    )!;
    const both = rank({ m, enemies: [9, 10], pool }).candidates.find(
      (c) => c.hero.id === 2,
    )!;
    expect(both.compEdge).toBeGreaterThan(one.compEdge * 1.8);
  });

  it("keeps your own hero record ahead of a small matchup swing", () => {
    // You are 8pt better on hero 1 than on hero 2; hero 2's matchup edge is ~1pt. Skill wins, and
    // the panel must say the comp changed nothing — the whole point of `reorders`.
    const m = matrix(10, { 2: { 9: 0.01 } });
    const skewed: PoolEntry[] = [
      { hero: hero(1), matches: 400, wins: 232 }, // 58%
      { hero: hero(2), matches: 400, wins: 200 }, // 50%
    ];
    const r = rank({ m, enemies: [9], pool: skewed });
    expect(r.candidates[0].hero.id).toBe(1);
    expect(r.reorders).toBe(false);
  });

  it("names the enemies that moved a hero, biggest first", () => {
    const m = matrix(10, { 2: { 9: 0.05, 10: -0.02 } });
    const c = rank({ m, enemies: [9, 10, 8], pool }).candidates.find(
      (x) => x.hero.id === 2,
    )!;
    expect(c.marks.map((x) => x.enemyHeroId)).toEqual([9, 10]);
    expect(c.marks[0].resid).toBeGreaterThan(0);
    expect(c.marks[1].resid).toBeLessThan(0);
  });

  it("never offers a hero the enemy already picked", () => {
    const m = matrix(10);
    const r = rank({ m, enemies: [1, 9], pool });
    expect(r.candidates.map((c) => c.hero.id)).not.toContain(1);
    expect([...r.candidates, ...r.offPool].map((c) => c.hero.id)).not.toContain(
      9,
    );
  });

  it("taxes off-pool suggestions and only shows ones that still beat the pool", () => {
    // Hero 7 is off-pool and strong into the comp; hero 6 is off-pool and neutral.
    const m = matrix(10, { 7: { 9: 0.08 } });
    const r = rank({ m, enemies: [9], pool });
    expect(r.offPool.map((c) => c.hero.id)).toContain(7);
    expect(r.offPool.every((c) => c.offPool)).toBe(true);
    // The tax is really applied: hero 7's base sits a full tax below its ladder rate.
    const seven = r.offPool.find((c) => c.hero.id === 7)!;
    expect(seven.base).toBeCloseTo(ladderRates(m).get(7)!.winRate - 0.02, 6);
    expect(r.offPool.every((c) => c.expected > r.candidates[0].expected)).toBe(
      true,
    );
  });

  it("falls back to the ladder when there is no profile", () => {
    const m = matrix(10, { 7: { 9: 0.08 } });
    const r = rank({ m, enemies: [9], pool: null });
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates[0].hero.id).toBe(7);
    // Nothing is a "new hero" when there is no pool to be new relative to, so nothing is taxed.
    expect(r.candidates.every((c) => !c.offPool)).toBe(true);
    expect(r.offPool).toHaveLength(0);
  });

  it("carries the worst lane matchup in the comp without folding it into the score", () => {
    const m = matrix(10);
    const lane = {
      "1": {
        "9": [900, -300, -250] as [number, number, number],
        "10": [900, 0, 40] as [number, number, number],
      },
    };
    const c = rank({ m, enemies: [9, 10], pool, lane }).candidates.find(
      (x) => x.hero.id === 1,
    )!;
    expect(c.worstLane).toEqual({ enemyHeroId: 9, resid: -250 });
    // Souls are not win-rate points: `expected` is base + compEdge and nothing else.
    expect(c.expected).toBeCloseTo(c.base + c.compEdge, 12);
  });

  it("reports no reorder when the comp is empty of matchup structure", () => {
    const r = rank({ m: matrix(10), enemies: [9, 10], pool });
    expect(r.reorders).toBe(false);
    expect(r.candidates.every((c) => c.compEdge === 0)).toBe(true);
    expect(r.enemyCount).toBe(2);
  });
});
