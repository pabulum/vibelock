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
const stat = (
  item_id: number,
  wins: number,
  losses: number,
  buyTimeS = 600,
): ItemStat => ({
  item_id,
  wins,
  losses,
  matches: wins + losses,
  players: wins + losses,
  avg_buy_time_s: buyTimeS,
  avg_sell_time_s: 0,
});

const items = new Map([1, 2, 3, 4].map((id) => [id, item(id)]));
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

describe("phase-centered lean", () => {
  // A falloff enemy (think Seven): every early buy runs −8 pts against them, every late buy
  // only −2 pts. Flat 50% baselines so per-enemy win rates read directly as deltas.
  const flatBase = [1, 2, 3, 4].map((id) => stat(id, 500_000, 500_000));
  const falloffEnemy = [
    {
      enemyHeroId: 7,
      stats: [
        stat(2, 168_000, 232_000, 600), // early anchor: 42%, delta −8 pts
        stat(3, 192_000, 208_000, 2400), // late anchor: 48%, delta −2 pts
        stat(4, 96_000, 104_000, 2400), // late item, average for its phase (also −2)
        stat(1, 92_000, 108_000, 600), // early item beating its phase: 46% vs the −8 lean
      ],
    },
  ];

  it("credits an item against its own phase's lean, not the whole matchup's", () => {
    const { counters } = computeItemCounters(flatBase, falloffEnemy, items);
    const marked = counters.map((c) => c.item.id);
    // Item 1 is +4 pts over its (early) phase lean; a single global lean (−4.33) would have
    // read it as a trivial +0.33 and hidden it.
    expect(marked).toContain(1);
    // Item 4 merely matches its (late) phase's lean — the global lean would have minted a
    // fake +2.33 "counter" out of the enemy's late-game fade.
    expect(marked).not.toContain(4);
    expect(marked).toEqual([1]);
    // Early lean −6.67 shrunk toward global −4.33 by K=40k at w=600k → −6.52; edge ≈ +2.52.
    const mark = counters[0].marks[0];
    expect(mark.delta).toBeCloseTo(0.0252, 3);
  });

  it("centers the comp-edge ranking pathway on the same phase leans", () => {
    const { edgeByItem } = computeItemCounters(flatBase, falloffEnemy, items);
    // The late average item carries ~no comp edge either way; the early over-performer keeps
    // a clearly positive one.
    expect(Math.abs(edgeByItem.get(4)!.edge)).toBeLessThan(0.005);
    expect(edgeByItem.get(1)!.edge).toBeGreaterThan(0.02);
  });

  it("falls back to the global lean when a phase bucket is thin", () => {
    // Same shape, but the late bucket holds one n=1000 item: 1000/(1000+40k) of its −2 raw
    // lean survives, so the item is still centered on ≈ the global (−8-ish) lean and its
    // +6 pt edge stands — a thin bucket can't cancel the matchup lean with its own noise.
    const thin = [
      {
        enemyHeroId: 7,
        stats: [
          stat(2, 168_000, 232_000, 600),
          stat(4, 480, 520, 2400), // 48%, delta −2, but only 1000 games
        ],
      },
    ];
    const { counters } = computeItemCounters(flatBase, thin, items);
    const four = counters.find((c) => c.item.id === 4);
    expect(four).toBeDefined();
    expect(four!.marks[0].delta).toBeGreaterThan(0.05);
  });
});

describe("the ~1 pt effect floor", () => {
  // A confident +1.2 pt edge (SE ≈ 0.16 pt): under the old 1.5 pt floor this was hidden, but
  // it's squarely inside the real scale of counter effects (the best measure ≈ +2 pts).
  const base = [stat(1, 500_000, 500_000), stat(2, 5_000_000, 5_000_000)];

  it("surfaces a confident, genuinely-sized edge", () => {
    const perEnemy = [
      {
        enemyHeroId: 7,
        stats: [stat(1, 51_200, 48_800), stat(2, 5_000_000, 5_000_000)],
      },
    ];
    const { counters } = computeItemCounters(base, perEnemy, items);
    const c = counters.find((c) => c.item.id === 1);
    expect(c).toBeDefined();
    expect(c!.marks[0].delta).toBeCloseTo(0.0119, 3);
  });

  it("still rejects the same edge on a thin sample — the confidence bar is separate", () => {
    // Same rates at 1/50 the sample: GATE_Z·sd ≈ 2 pts ≫ the edge.
    const thinEnemy = [
      {
        enemyHeroId: 7,
        stats: [stat(1, 1_024, 976), stat(2, 5_000_000, 5_000_000)],
      },
    ];
    const { counters } = computeItemCounters(base, thinEnemy, items);
    expect(counters.find((c) => c.item.id === 1)).toBeUndefined();
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
