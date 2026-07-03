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
  it("shrinks the edge hard on modest evidence, trusts it as evidence mounts", () => {
    const perEnemy = [
      { enemyHeroId: 7, stats: [stat(1, 400, 600), stat(2, 100_000, 100_000)] }, // item 1: 40% vs 50% base
    ];
    const { edgeByItem } = computeItemCounters(baseline, perEnemy, items);
    const e = edgeByItem.get(1)!;
    expect(e.edge).toBeLessThan(0); // it under-performs vs this enemy
    // 1000 games against the K = 4000 prior keeps only n/(n+K) = 1/5 of the −10 pt raw edge.
    expect(e.edge).toBeCloseTo(-0.02, 2);
    // Delta-method SE of the shrunk weighted mean: √(n·p(1−p)) / (n + K).
    expect(e.se).toBeCloseTo(Math.sqrt(1000 * 0.4 * 0.6) / 5000, 5);

    // 25× the sample, same rate → the prior loses: 25000/29000 ≈ 86% of the raw edge survives.
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
    expect(eBig.edge).toBeLessThan(-0.07);
    expect(Math.abs(eBig.edge)).toBeGreaterThan(Math.abs(e.edge) * 3);
  });

  it("SUMS the edge across enemies — a full comp stacks, it doesn't average", () => {
    const vsOne = [
      { enemyHeroId: 7, stats: [stat(1, 400, 600), stat(2, 100_000, 100_000)] },
    ];
    const vsTwo = [
      ...vsOne,
      { enemyHeroId: 8, stats: [stat(1, 400, 600), stat(2, 100_000, 100_000)] },
    ];
    const one = computeItemCounters(baseline, vsOne, items).edgeByItem.get(1)!;
    const two = computeItemCounters(baseline, vsTwo, items).edgeByItem.get(1)!;
    // Equally bad vs both enemies → the comp edge doubles (the old weighted mean stayed flat).
    expect(two.edge).toBeCloseTo(2 * one.edge, 10);
    // …and the noise adds too: SE grows by √2 rather than tightening as if it were more
    // evidence about one number. √(2·n·p(1−p)/(n+K)²), n = 1000, K = 4000.
    expect(two.se).toBeCloseTo(
      Math.sqrt((2 * 1000 * 0.4 * 0.6) / 5000 ** 2),
      5,
    );
    expect(two.se).toBeCloseTo(Math.SQRT2 * one.se, 10);
  });

  it("treats enemies below the sample floor as no evidence, not as dilution", () => {
    const vsOne = [
      { enemyHeroId: 7, stats: [stat(1, 400, 600), stat(2, 100_000, 100_000)] },
    ];
    const withThin = [
      ...vsOne,
      // 20 games vs enemy 8 — under MIN_SAMPLE, so it must not touch the comp edge.
      { enemyHeroId: 8, stats: [stat(1, 5, 15), stat(2, 100_000, 100_000)] },
    ];
    const one = computeItemCounters(baseline, vsOne, items).edgeByItem.get(1)!;
    const two = computeItemCounters(baseline, withThin, items).edgeByItem.get(
      1,
    )!;
    expect(two.edge).toBeCloseTo(one.edge, 10);
    expect(two.se).toBeCloseTo(one.se, 10);
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
    expect(isWeakVsComp({ edge: -0.01, se: 0.0001 })).toBe(false);
  });

  it("never flags a positive or zero edge", () => {
    expect(isWeakVsComp({ edge: 0.04, se: 0.01 })).toBe(false);
    expect(isWeakVsComp({ edge: 0, se: 0 })).toBe(false);
  });
});
