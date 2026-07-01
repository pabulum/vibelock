import { describe, expect, it } from "vitest";
import type { Item, ItemStat } from "../types";
import { computeItemCounters } from "./counters";
import { isWeakVsComp } from "./buildGenerator";

const item = (id: number): Item => ({
  id,
  name: `Item ${id}`,
  tier: 2,
  cost: 1250,
  slot: "weapon",
  componentIds: [],
});
const stat = (item_id: number, wins: number, losses: number): ItemStat => ({
  item_id,
  wins,
  losses,
  matches: wins + losses,
  players: wins + losses,
  avg_buy_time_s: 600,
  avg_sell_time_s: 0,
});

const items = new Map([1, 2].map((id) => [id, item(id)]));
// Item 2 is a huge "average" anchor so the matchup lean ≈ 0 and item 1's delta reads as its edge.
const baseline = [stat(1, 500, 500), stat(2, 50_000, 50_000)];

describe("computeItemCounters edgeByItem", () => {
  it("returns a shrunk signed edge with a sampling error that tightens with n", () => {
    const perEnemy = [
      { enemyHeroId: 7, stats: [stat(1, 400, 600), stat(2, 100_000, 100_000)] }, // item 1: 40% vs 50% base
    ];
    const { edgeByItem } = computeItemCounters(baseline, perEnemy, items);
    const e = edgeByItem.get(1)!;
    expect(e.edge).toBeLessThan(0); // it under-performs vs this enemy
    expect(e.edge).toBeGreaterThan(-0.1); // …but shrunk toward 0 (K games of "no edge" prior)
    // Delta-method SE of the shrunk weighted mean: √(n·p(1−p)) / (n + K), K = 60.
    expect(e.se).toBeCloseTo(Math.sqrt(1000 * 0.4 * 0.6) / 1060, 5);

    // 25× the sample, same rate → the SE tightens (≈1/√n); the edge stays strongly negative.
    // (Not exactly −10 pts: the item now also weighs more in the lean it's centered on.)
    const bigger = computeItemCounters(
      baseline,
      [
        {
          enemyHeroId: 7,
          stats: [stat(1, 10_000, 15_000), stat(2, 100_000, 100_000)],
        },
      ],
      items,
    );
    const eBig = bigger.edgeByItem.get(1)!;
    expect(eBig.se).toBeLessThan(e.se / 4);
    expect(eBig.edge).toBeLessThan(-0.08);
  });

  it("pools the edge and its error across enemies", () => {
    const perEnemy = [
      { enemyHeroId: 7, stats: [stat(1, 400, 600), stat(2, 100_000, 100_000)] },
      { enemyHeroId: 8, stats: [stat(1, 400, 600), stat(2, 100_000, 100_000)] },
    ];
    const { edgeByItem } = computeItemCounters(baseline, perEnemy, items);
    const e = edgeByItem.get(1)!;
    // Two identical 1000-game cells: Σn·p(1−p) doubles, denominator grows → smaller SE than one cell.
    expect(e.se).toBeCloseTo(Math.sqrt(2 * 1000 * 0.4 * 0.6) / 2060, 5);
  });
});

describe("isWeakVsComp (the ▼ demote gate)", () => {
  it("flags a confidently negative edge past the effect floor", () => {
    expect(isWeakVsComp({ edge: -0.05, se: 0.01 })).toBe(true);
  });

  it("does NOT flag the same point estimate on thin, noisy evidence", () => {
    // −5 pts but ±6 pts of noise: the old raw threshold flagged this; the gate holds fire.
    expect(isWeakVsComp({ edge: -0.05, se: 0.06 })).toBe(false);
  });

  it("does NOT flag a trivially small edge no matter how certain", () => {
    expect(isWeakVsComp({ edge: -0.02, se: 0.0001 })).toBe(false);
  });

  it("never flags a positive or zero edge", () => {
    expect(isWeakVsComp({ edge: 0.04, se: 0.01 })).toBe(false);
    expect(isWeakVsComp({ edge: 0, se: 0 })).toBe(false);
  });
});
