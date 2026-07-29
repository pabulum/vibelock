import { describe, expect, it } from "vitest";
import type { Item, ItemStat } from "../types";
import { findAdoptionMovers, findPatchMovers } from "./patchMovers";

const item = (id: number): Item =>
  ({
    id,
    name: `Item ${id}`,
    cost: 1000,
    tier: 2,
    slot: "weapon",
    componentIds: [],
  }) as unknown as Item;

const items = new Map(
  Array.from({ length: 30 }, (_, i) => [i + 1, item(i + 1)]),
);

const stat = (item_id: number, wins: number, losses: number): ItemStat => ({
  item_id,
  wins,
  losses,
  matches: wins + losses,
  players: wins + losses,
  avg_buy_time_s: 300,
  avg_sell_time_s: 0,
});

/** An item-stats row where the games it was bought in (`matches`, what a pick rate counts) is set
 * independently of the decided games behind its win rate. */
const buy = (
  item_id: number,
  matches: number,
  wins: number,
  losses: number,
): ItemStat => ({
  item_id,
  wins,
  losses,
  matches,
  players: matches,
  avg_buy_time_s: 300,
  avg_sell_time_s: 0,
});

// A hero whose own win rate didn't budge across the patch, sampled heavily enough that re-basing
// costs the tests almost nothing — the neutral background for the cases that aren't about the hero.
const flatHero = {
  freshRate: 0.5,
  freshDecided: 200_000,
  prevRate: 0.5,
  prevDecided: 200_000,
};

describe("findPatchMovers", () => {
  it("finds a real, big, well-sampled move and reports its direction", () => {
    const fresh = [stat(1, 1700, 1300)]; // 56.7%
    const prev = [stat(1, 5000, 5000)]; // 50%
    const [m] = findPatchMovers(fresh, prev, items, flatHero);
    expect(m.item.id).toBe(1);
    expect(m.delta).toBeGreaterThan(0.05);
    expect(m.isNew).toBeUndefined();
  });

  it("ignores thin samples and sub-floor drifts", () => {
    const fresh = [
      stat(1, 20, 10), // huge shift but n=30 < floor
      stat(2, 50600, 49400), // +0.6pt on a massive sample: significant, but below the 2pt effect floor
    ];
    const prev = [stat(1, 500, 500), stat(2, 50000, 50000)];
    expect(findPatchMovers(fresh, prev, items, flatHero)).toEqual([]);
  });

  it("FDR-controls the family: 20 null items with wobble produce no movers", () => {
    // Each item ~50% both windows with sampling-scale wobble — nothing should survive BH.
    const fresh = Array.from({ length: 20 }, (_, i) =>
      stat(i + 1, 300 + ((i * 7) % 25), 300 - ((i * 7) % 25)),
    );
    const prev = Array.from({ length: 20 }, (_, i) => stat(i + 1, 3000, 3000));
    expect(findPatchMovers(fresh, prev, items, flatHero)).toEqual([]);
  });

  it("appends well-sampled new items, flagged, after the movers", () => {
    const fresh = [stat(1, 1700, 1300), stat(9, 90, 60)];
    const prev = [stat(1, 5000, 5000)];
    const out = findPatchMovers(fresh, prev, items, flatHero);
    expect(out.map((m) => m.item.id)).toEqual([1, 9]);
    expect(out[1].isNew).toBe(true);
  });

  it("skips a new item that has not accrued a real sample yet", () => {
    const out = findPatchMovers([stat(9, 30, 20)], [], items, flatHero);
    expect(out).toEqual([]);
  });

  // The 07-28-2026 Haze case: the patch nerfed the HERO, so every item they buy lost win rate
  // together. Raw-rate testing called eight movers; none of them was an item moving.
  it("reports nothing when the hero moved and its items only followed", () => {
    const nerfedHero = {
      freshRate: 0.49,
      freshDecided: 60_000,
      prevRate: 0.53,
      prevDecided: 60_000,
    };
    // 20 items, each down exactly the hero's 4pt, on samples big enough that the raw drop is
    // significant item by item.
    const fresh = Array.from({ length: 20 }, (_, i) => stat(i + 1, 1960, 2040));
    const prev = Array.from({ length: 20 }, (_, i) => stat(i + 1, 2120, 1880));
    expect(findPatchMovers(fresh, prev, items, nerfedHero)).toEqual([]);
    // ...and the identical data against a hero that DIDN'T move calls movers, so the case above is
    // the re-basing working rather than the samples being too thin to call anything.
    expect(
      findPatchMovers(fresh, prev, items, flatHero).length,
    ).toBeGreaterThan(0);
  });

  it("catches an item that moved against its hero, and reports both framings", () => {
    // The hero lost 2pt; this item gained 3pt raw, so on its hero it gained 5.
    const buffedHero = {
      freshRate: 0.51,
      freshDecided: 60_000,
      prevRate: 0.53,
      prevDecided: 60_000,
    };
    const fresh = [stat(1, 2650, 2350)]; // 53%
    const prev = [stat(1, 5000, 5000)]; // 50%
    const [m] = findPatchMovers(fresh, prev, items, buffedHero);
    expect(m.item.id).toBe(1);
    expect(m.prevWinRate).toBeCloseTo(0.5, 3);
    expect(m.newWinRate).toBeCloseTo(0.53, 3);
    expect(m.prevEdge).toBeCloseTo(-0.03, 3);
    expect(m.newEdge).toBeCloseTo(0.02, 3);
    expect(m.delta).toBeCloseTo(0.05, 3);
  });

  it("declines to call anything without a hero baseline to re-base against", () => {
    const fresh = [stat(1, 1700, 1300)];
    const prev = [stat(1, 5000, 5000)];
    const empty = {
      freshRate: 0,
      freshDecided: 0,
      prevRate: 0,
      prevDecided: 0,
    };
    expect(findPatchMovers(fresh, prev, items, empty)).toEqual([]);
  });
});

describe("findAdoptionMovers", () => {
  it("sizes the comparator from the payloads, so a lopsided window can't fabricate a rise", () => {
    // Identical shares in both windows — item 1 is 44% of all purchases either side. The comparator
    // window simply holds twice as many purchases (twice as long, or twice as ingested). Dividing by
    // a *reported* game count that disagrees with the payload is what turned flat items into
    // "+31pt breakouts" on 07-28-2026; deriving the size from the purchase totals cannot.
    const fresh = [buy(1, 800, 500, 300), buy(2, 1000, 500, 500)];
    const prev = [buy(1, 1600, 1000, 600), buy(2, 2000, 1000, 1000)];
    expect(findAdoptionMovers(fresh, prev, 1000, 0.5, items)).toEqual([]);
  });

  it("catches a real rise and splits breakouts from hype on the win edge", () => {
    // Item 1 goes 60% → 80% of games while total purchases hold steady, at a 62.5% win rate.
    const fresh = [buy(1, 800, 500, 300), buy(2, 1000, 500, 500)];
    const prev = [buy(1, 600, 300, 300), buy(2, 1200, 600, 600)];
    const [a, ...rest] = findAdoptionMovers(fresh, prev, 1000, 0.5, items);
    expect(rest).toEqual([]); // item 2 fell; only a rise counts
    expect(a.item.id).toBe(1);
    expect(a.pickPrev).toBeCloseTo(0.6, 3);
    expect(a.pickNew).toBeCloseTo(0.8, 3);
    expect(a.pickDelta).toBeCloseTo(0.2, 3);
    expect(a.winEdge).toBeCloseTo(0.125, 3);
    expect(a.breakout).toBe(true);

    // Same adoption, win rate merely at the hero's own average ⇒ being tried, not proven.
    const flat = [buy(1, 800, 400, 400), buy(2, 1000, 500, 500)];
    const [h] = findAdoptionMovers(flat, prev, 1000, 0.5, items);
    expect(h.breakout).toBe(false);
  });

  it("holds a small rise to a significance floor, and lets volume clear it", () => {
    // The same 20% → 25% adoption both times; only the sample size differs, so only the z gate can
    // be what separates them.
    const thin = findAdoptionMovers(
      [buy(1, 250, 140, 110), buy(2, 670, 335, 335)],
      [buy(1, 200, 120, 80), buy(2, 720, 360, 360)],
      1000,
      0.5,
      items,
    );
    expect(thin).toEqual([]);
    const thick = findAdoptionMovers(
      [buy(1, 2000, 1120, 880), buy(2, 5360, 2680, 2680)],
      [buy(1, 1600, 960, 640), buy(2, 5760, 2880, 2880)],
      8000,
      0.5,
      items,
    );
    expect(thick.map((a) => a.item.id)).toEqual([1]);
  });

  it("returns nothing when a window is empty", () => {
    expect(
      findAdoptionMovers([], [buy(1, 100, 60, 40)], 1000, 0.5, items),
    ).toEqual([]);
    expect(
      findAdoptionMovers([buy(1, 100, 60, 40)], [], 1000, 0.5, items),
    ).toEqual([]);
    expect(
      findAdoptionMovers(
        [buy(1, 100, 60, 40)],
        [buy(1, 50, 30, 20)],
        0,
        0.5,
        items,
      ),
    ).toEqual([]);
  });
});

// foldTrendingBreakouts adds current breakouts as tagged situational options where they're not
// already in the build, placing each by tier (T1→Lane … T4→Late) and never duplicating an existing
// pick. It's purely additive — the core build is untouched.
import { foldTrendingBreakouts, type AdoptionMover } from "./patchMovers";
import type { BuildItem, BuildPhase, GeneratedBuild } from "../types";

const bi = (id: number): BuildItem =>
  ({
    item: item(id),
    role: "universal",
    pickRate: 0.5,
    adjustedWinRate: 0.52,
    rawWinRate: 0.52,
    sample: 1000,
    decided: 1000,
    avgNetWorthAtBuy: 0,
    why: "",
  }) as BuildItem;

const phase = (
  column: number,
  core: number[],
  situational: number[],
): BuildPhase => ({
  column,
  label: ["Lane", "Early mid", "Mid", "Late"][column],
  timeLabel: "",
  targetItems: core.length,
  itemsBought: core.length,
  soulBudget: 0,
  coreSouls: 0,
  categorySouls: { weapon: 0, vitality: 0, spirit: 0 },
  core: core.map(bi),
  situational: situational.map(bi),
});

const buildOf = (
  phases: BuildPhase[],
  overtime: number[] = [],
): GeneratedBuild => ({
  hero: { id: 1, name: "H", signatureClasses: [] },
  rankLabel: "R",
  population: { matches: 1000, avgDurationS: 1800, baselineWinRate: 0.5 },
  phases,
  standingSlots: 0,
  overtimePool: overtime.map(bi),
  overtimeBuys: overtime.map(bi),
  overtimeSell: [],
});

const mover = (id: number, tier: number, breakout: boolean): AdoptionMover => ({
  item: { ...item(id), tier },
  pickPrev: 0.05,
  pickNew: 0.14,
  pickDelta: 0.09,
  winRate: breakout ? 0.55 : 0.49,
  winEdge: breakout ? 0.05 : -0.01,
  nNew: 800,
  breakout,
});

describe("foldTrendingBreakouts", () => {
  it("folds an un-built breakout into the situational list of its tier phase", () => {
    const build = buildOf([
      phase(0, [1], []),
      phase(1, [2], []),
      phase(2, [3], []),
      phase(3, [4], []),
    ]);
    const out = foldTrendingBreakouts(build, [mover(20, 3, true)]); // T3 → Mid (column 2)
    const mid = out.phases[2];
    const added = mid.situational.find((b) => b.item.id === 20);
    expect(added).toBeDefined();
    expect(added!.why).toMatch(/trending up/);
    // other phases untouched, core untouched
    expect(out.phases[2].core.map((b) => b.item.id)).toEqual([3]);
  });

  it("never duplicates a breakout already in the build (core or overtime)", () => {
    const build = buildOf(
      [
        phase(0, [1], []),
        phase(1, [2], []),
        phase(2, [3], []),
        phase(3, [4], []),
      ],
      [40],
    );
    const out = foldTrendingBreakouts(build, [
      mover(3, 3, true),
      mover(40, 4, true),
    ]);
    const allIds = out.phases.flatMap((p) =>
      [...p.core, ...p.situational].map((b) => b.item.id),
    );
    expect(allIds.filter((x) => x === 3).length).toBe(1); // still just the one core copy
    expect(allIds).not.toContain(40); // already in overtime — not folded into a phase
  });

  it("returns the same build when there are no breakouts", () => {
    const build = buildOf([phase(0, [1], [])]);
    expect(foldTrendingBreakouts(build, [])).toBe(build);
  });
});
