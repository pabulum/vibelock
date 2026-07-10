import { describe, expect, it } from "vitest";
import {
  WIN_STATE_GAP,
  classifyWinState,
  generateBuild,
} from "./buildGenerator";
import type { Hero, Item, ItemFlowStats } from "../types";

// classifyWinState reads the raw-vs-adjusted (game-state-corrected) win-rate gap: a pick whose raw
// rate runs well above its adjusted rate mostly wins games you were already winning ("win more"); the
// reverse holds up when bought from behind ("comeback"). A clear loser is never labelled.
describe("classifyWinState", () => {
  const baseline = 0.5;

  it('labels a pick that wins far more raw than adjusted as "winmore"', () => {
    expect(classifyWinState(0.56, 0.5, baseline)).toBe("winmore");
  });

  it('labels a pick that holds up better adjusted than raw as "comeback"', () => {
    expect(classifyWinState(0.5, 0.56, baseline)).toBe("comeback");
  });

  it("returns undefined when the gap is within noise", () => {
    expect(classifyWinState(0.51, 0.5, baseline)).toBeUndefined();
  });

  it("never labels a clear loser, even with a large raw-vs-adjusted gap", () => {
    // adjusted well below baseline ⇒ just a bad pick, not a "win more" option, despite the wide gap.
    expect(classifyWinState(0.6, 0.4, baseline)).toBeUndefined();
  });

  it('keys "winmore"/"comeback" off the gap sign at the WIN_STATE_GAP threshold', () => {
    const adj = 0.5;
    expect(classifyWinState(adj + WIN_STATE_GAP, adj, baseline)).toBe(
      "winmore",
    );
    expect(classifyWinState(adj - WIN_STATE_GAP, adj, baseline)).toBe(
      "comeback",
    );
    // Just inside the threshold ⇒ unlabelled.
    expect(
      classifyWinState(adj + WIN_STATE_GAP - 1e-6, adj, baseline),
    ).toBeUndefined();
  });
});

// Regression: Deadlock never lets you buy a component standalone once its upgrade is owned (you can
// buy a *different* item built from that component, but not the component itself again). A build that
// puts the upgrade core in an earlier phase and then offers the component again in a later phase is
// recommending an impossible purchase.
describe("generateBuild — component/upgrade cross-phase dedup", () => {
  it("never offers a component once its upgrade is already core in an earlier phase", () => {
    const component: Item = {
      id: 1,
      name: "Mystic Vulnerability",
      tier: 1,
      cost: 500,
      slot: "spirit",
      componentIds: [],
    };
    const upgrade: Item = {
      id: 2,
      name: "Escalating Exposure",
      tier: 2,
      cost: 1500,
      slot: "spirit",
      componentIds: [component.id],
    };
    const items = new Map<number, Item>([
      [component.id, component],
      [upgrade.id, upgrade],
    ]);

    const flow: ItemFlowStats = {
      nodes: [
        // The upgrade is bought (and is the sole, universal, core-worthy pick) in Mid (column 2).
        {
          column: 2,
          item_id: upgrade.id,
          wins: 60,
          losses: 40,
          players: 100,
          matches: 100,
          adjusted_win_rate: 0.6,
          avg_net_worth_at_buy: 5000,
          total_kills: 0,
          total_deaths: 0,
          total_assists: 0,
        },
        // Its component resurfaces as a distinct, universal, core-worthy candidate in Late (column 3) —
        // e.g. a different slice of players who buy it standalone and never upgrade.
        {
          column: 3,
          item_id: component.id,
          wins: 70,
          losses: 30,
          players: 100,
          matches: 100,
          adjusted_win_rate: 0.7,
          avg_net_worth_at_buy: 8000,
          total_kills: 0,
          total_deaths: 0,
          total_assists: 0,
        },
      ],
      edges: [],
      summary: {
        matches: 100,
        players: 100,
        wins: 50,
        losses: 50,
        avg_duration_s: 1800,
        avg_net_worth: 8000,
      },
      baseline: {
        matches: 100,
        players: 100,
        wins: 50,
        losses: 50,
        avg_duration_s: 1800,
        avg_net_worth: 8000,
      },
      reached_per_column: [100, 100, 100, 100],
    };

    const hero: Hero = { id: 1, name: "Test Hero", signatureClasses: [] };
    const build = generateBuild(
      hero,
      "Test Rank",
      items,
      flow,
      new Map(),
      new Map(),
    );

    const allItemIds = build.phases.flatMap((p) =>
      [...p.core, ...p.situational].map((b) => b.item.id),
    );
    expect(allItemIds).not.toContain(component.id);
    expect(allItemIds).toContain(upgrade.id);
  });

  // Buying a core upgrade auto-queues its whole component tree, so a part of it shouldn't also be
  // offered as a separate *situational* pickup in the same phase (Extra Health surfacing optional
  // while Fortitude, which builds from it, is core). The cross-phase test above covers earlier-phase
  // upgrades; this covers the same-phase core case (which dropSamePhaseComponents only handled for core).
  it("never offers a component as situational when its upgrade is core in the same phase", () => {
    const component: Item = {
      id: 1,
      name: "Extra Health",
      tier: 1,
      cost: 800,
      slot: "vitality",
      componentIds: [],
    };
    const upgrade: Item = {
      id: 2,
      name: "Fortitude",
      tier: 3,
      cost: 3000,
      slot: "vitality",
      componentIds: [component.id],
    };
    const items = new Map<number, Item>([
      [component.id, component],
      [upgrade.id, upgrade],
    ]);

    const flow: ItemFlowStats = {
      nodes: [
        // The upgrade is a near-universal, winning core pick this phase.
        {
          column: 0,
          item_id: upgrade.id,
          wins: 540,
          losses: 360,
          players: 900,
          matches: 900,
          adjusted_win_rate: 0.6,
          avg_net_worth_at_buy: 3000,
          total_kills: 0,
          total_deaths: 0,
          total_assists: 0,
        },
        // Its component is a strong sub-universal value pick — it'd otherwise land in situational.
        {
          column: 0,
          item_id: component.id,
          wins: 130,
          losses: 70,
          players: 200,
          matches: 200,
          adjusted_win_rate: 0.65,
          avg_net_worth_at_buy: 800,
          total_kills: 0,
          total_deaths: 0,
          total_assists: 0,
        },
      ],
      edges: [],
      summary: {
        matches: 1000,
        players: 1000,
        wins: 500,
        losses: 500,
        avg_duration_s: 1800,
        avg_net_worth: 8000,
      },
      baseline: {
        matches: 1000,
        players: 1000,
        wins: 500,
        losses: 500,
        avg_duration_s: 1800,
        avg_net_worth: 8000,
      },
      reached_per_column: [1000, 1000, 1000, 1000],
    };

    const hero: Hero = { id: 1, name: "Test Hero", signatureClasses: [] };
    const build = generateBuild(
      hero,
      "Test Rank",
      items,
      flow,
      new Map(),
      new Map(),
    );

    const lane = build.phases[0];
    expect(lane.core.map((b) => b.item.id)).toContain(upgrade.id);
    const allItemIds = build.phases.flatMap((p) =>
      [...p.core, ...p.situational].map((b) => b.item.id),
    );
    expect(allItemIds).not.toContain(component.id);
  });
});

// Measured co-purchase data (BuildOptions.jointGamesOf) — the sew-together fixes. Fixtures share
// this shape: a 10k-match population, universal lane picks, and a joint-games lookup standing in
// for the permutation pairs.
const mkNode = (
  column: number,
  item_id: number,
  players: number,
  adj: number,
) => ({
  column,
  item_id,
  wins: Math.round(players * adj),
  losses: players - Math.round(players * adj),
  players,
  matches: players,
  adjusted_win_rate: adj,
  avg_net_worth_at_buy: 1000,
  total_kills: 0,
  total_deaths: 0,
  total_assists: 0,
});
const mkFlow = (nodes: ReturnType<typeof mkNode>[]): ItemFlowStats => ({
  nodes,
  edges: [],
  summary: {
    matches: 10000,
    players: 10000,
    wins: 5000,
    losses: 5000,
    avg_duration_s: 1800,
    avg_net_worth: 8000,
  },
  baseline: {
    matches: 10000,
    players: 10000,
    wins: 5000,
    losses: 5000,
    avg_duration_s: 1800,
    avg_net_worth: 8000,
  },
  reached_per_column: [10000, 10000, 10000, 10000],
});
const jointLookup =
  (joints: Record<string, number>) => (a: number, b: number) =>
    joints[a < b ? `${a}-${b}` : `${b}-${a}`] ?? 0;
const testHero: Hero = { id: 1, name: "Test Hero", signatureClasses: [] };

// A cheap (≤T1) core pick that leaves inventory before ~25 min is flagged as a transient placeholder
// (TEMP) — but with NO reason string. The time used to print as "often sold ~mm:ss", but item-stats'
// avg_sell_time_s counts an upgrade absorbing the component as a "sell" (verified: a single-upgrade
// component's sell time == its upgrade's buy time), so it was an upgrade time, not a sale. We keep the
// TEMP flag (a cheap early stat-stick isn't a permanent slot) and drop the misleading label.
describe("generateBuild — early-placeholder TEMP flag", () => {
  const comp: Item = {
    id: 1,
    name: "Comp Stick",
    tier: 1,
    cost: 800,
    slot: "weapon",
    componentIds: [],
  };
  const upg: Item = {
    id: 2,
    name: "Big Upgrade",
    tier: 3,
    cost: 3200,
    slot: "weapon",
    componentIds: [comp.id],
  };
  const sold: Item = {
    id: 3,
    name: "Sold Stick",
    tier: 1,
    cost: 800,
    slot: "vitality",
    componentIds: [],
  };
  const staple: Item = {
    id: 5,
    name: "Spirit Staple",
    tier: 1,
    cost: 800,
    slot: "spirit",
    componentIds: [],
  };
  const items = new Map<number, Item>(
    [comp, upg, sold, staple].map((i) => [i.id, i]),
  );

  const flow = mkFlow([
    mkNode(0, comp.id, 8000, 0.5), // cheap lane stick, sold early — a placeholder
    mkNode(0, sold.id, 7000, 0.5),
    mkNode(0, staple.id, 6000, 0.51),
    mkNode(2, upg.id, 800, 0.48),
  ]);
  const sellTimes = new Map([
    [comp.id, 700],
    [sold.id, 700],
  ]);

  const build = generateBuild(
    testHero,
    "Test Rank",
    items,
    flow,
    new Map(),
    sellTimes,
  );
  const lane = build.phases[0];

  it("flags a cheap early-placeholder pick as TEMP with no reason text", () => {
    const row = lane.core.find((b) => b.item.id === comp.id);
    expect(row?.transient).toBe(true);
    expect(row?.transientReason).toBeUndefined();
  });

  it("never prints a sell-time or build-into label on a cheap placeholder", () => {
    for (const b of build.phases.flatMap((p) => p.core))
      expect(b.transientReason ?? "").not.toMatch(/sold|most build into/);
  });
});

// The substitute call, measured: two same-slot universals whose pick rates sum past 1 pass the old
// inclusion–exclusion bound ("must overlap"), but the pair data can still show their buyers are
// disjoint camps — then they share one core slot, with the loser benched as the swap.
describe("generateBuild — measured substitutes override the pick-rate bound", () => {
  const a: Item = {
    id: 1,
    name: "Round A",
    tier: 1,
    cost: 800,
    slot: "weapon",
    componentIds: [],
  };
  const b: Item = {
    id: 2,
    name: "Round B",
    tier: 1,
    cost: 800,
    slot: "weapon",
    componentIds: [],
  };
  const staple: Item = {
    id: 3,
    name: "Spirit Staple",
    tier: 1,
    cost: 800,
    slot: "spirit",
    componentIds: [],
  };
  const items = new Map<number, Item>([a, b, staple].map((i) => [i.id, i]));
  const flow = () =>
    mkFlow([
      mkNode(0, a.id, 9500, 0.5),
      mkNode(0, b.id, 8000, 0.5),
      mkNode(0, staple.id, 8000, 0.5),
    ]);

  it("benches the less-popular pick as a swap when the measured overlap is low", () => {
    const build = generateBuild(
      testHero,
      "Test Rank",
      items,
      flow(),
      new Map(),
      new Map(),
      // pick sum 1.75 passes the old bound, but only 10% of B's buyers also buy A
      { jointGamesOf: jointLookup({ "1-2": 800 }) },
    );
    const lane = build.phases[0];
    expect(lane.core.map((x) => x.item.id)).toContain(a.id);
    expect(lane.core.map((x) => x.item.id)).not.toContain(b.id);
    const swap = lane.situational.find((s) => s.item.id === b.id);
    expect(swap?.swapFor?.id).toBe(a.id);
  });

  it("keeps both core under the pick-rate fallback when no pair data is supplied", () => {
    const build = generateBuild(
      testHero,
      "Test Rank",
      items,
      flow(),
      new Map(),
      new Map(),
    );
    const ids = build.phases[0].core.map((x) => x.item.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });
});

// The falsifiable universal bypass (the Headhunter case): a popular pick seats without a win-rate
// check — that's deliberate, its observable edge is compressed by (1−pickRate) — UNLESS its buyers
// verifiably run behind its non-buyers on the contrast scale. Then it loses the seat and surfaces
// as an honest "popular but losing" optional row instead.
describe("generateBuild — buyer-vs-non-buyer gate on the universal bypass", () => {
  const mkItem = (id: number, name: string): Item => ({
    id,
    name,
    tier: 2,
    cost: 1000,
    slot: "weapon",
    componentIds: [],
  });
  const trap = mkItem(1, "Trap Staple"); // 35% pick, buyers −3.5pt ⇒ contrast ≈ −5.4pt: demote
  const staple = mkItem(2, "Fine Staple"); // 65% pick, −0.5pt ⇒ contrast ≈ −1.4pt: under margin, keep
  const backbone = mkItem(3, "True Backbone"); // 75% pick: complement too weird to read, keep
  const items = new Map<number, Item>([
    [trap.id, trap],
    [staple.id, staple],
    [backbone.id, backbone],
  ]);

  const node = (item_id: number, players: number, adj: number) => ({
    column: 0,
    item_id,
    wins: Math.round(players * adj),
    losses: players - Math.round(players * adj),
    players,
    matches: players,
    adjusted_win_rate: adj,
    avg_net_worth_at_buy: 1000,
    total_kills: 0,
    total_deaths: 0,
    total_assists: 0,
  });

  const flow: ItemFlowStats = {
    nodes: [
      node(trap.id, 3500, 0.465),
      node(staple.id, 6500, 0.495),
      node(backbone.id, 7500, 0.46),
    ],
    edges: [],
    summary: {
      matches: 10000,
      players: 10000,
      wins: 5000,
      losses: 5000,
      avg_duration_s: 1800,
      avg_net_worth: 8000,
    },
    baseline: {
      matches: 10000,
      players: 10000,
      wins: 5000,
      losses: 5000,
      avg_duration_s: 1800,
      avg_net_worth: 8000,
    },
    reached_per_column: [10000],
  };

  const hero: Hero = { id: 1, name: "Test Hero", signatureClasses: [] };
  const build = generateBuild(
    hero,
    "Test Rank",
    items,
    flow,
    new Map(),
    new Map(),
  );
  const lane = build.phases[0];
  const coreIds = lane.core.map((b) => b.item.id);

  it("demotes a popular pick whose buyers significantly trail non-buyers", () => {
    expect(coreIds).not.toContain(trap.id);
    const row = lane.situational.find((s) => s.item.id === trap.id);
    expect(row).toBeDefined();
    expect(row!.why).toMatch(/behind the ones who don't/);
  });

  it("keeps a popular pick whose observed dip is within the contrast margin", () => {
    expect(coreIds).toContain(staple.id);
  });

  it("gives very-high-pick staples the benefit of the doubt (no readable complement)", () => {
    expect(coreIds).toContain(backbone.id);
  });
});

// Line-aware survivorship shrink (BuildOptions.lineAware): an upgrade few of its component's buyers reach
// (small λ) has a selection-inflated win rate. The shrink pulls its *admission* WR toward the component's
// broader WR, so a shiny-but-rarely-reached upgrade is kept OUT of core — while the plain build (toggle
// off) still seats it. The shrink is a gate only: it must not change the displayed adjustedWinRate.
describe("generateBuild — line-aware survivorship shrink", () => {
  const component: Item = {
    id: 1,
    name: "Cheap Stick",
    tier: 1,
    cost: 800,
    slot: "weapon",
    componentIds: [],
  };
  const upgrade: Item = {
    id: 2,
    name: "Shiny Upgrade",
    tier: 2,
    cost: 1600,
    slot: "weapon",
    componentIds: [component.id],
  };
  const alt: Item = {
    id: 3,
    name: "Plain Alt",
    tier: 1,
    cost: 800,
    slot: "weapon",
    componentIds: [],
  };
  const items = new Map<number, Item>(
    [component, upgrade, alt].map((i) => [i.id, i]),
  );

  // baseline 50%. Component is universal (everyone buys it, its broad WR 48%); the upgrade is reached by
  // only ~14% of the lobby but flashes a shiny +10pt — a classic survivorship shine. λ = pickUp/pickComp ≈
  // 0.143, so shrunk ≈ 0.48 + 0.143·(0.60−0.48) ≈ 0.497 < baseline ⇒ demoted only when line-aware. reached
  // == the component's buyers so its pick-weighted soul budget covers its cost (a sparse fixture otherwise
  // underbudgets and nothing seats). The upgrade surfaces as a situational *value* pick when off.
  const flow: ItemFlowStats = {
    nodes: [
      mkNode(0, component.id, 1400, 0.48), // Lane, pick 1.0 (universal)
      mkNode(1, upgrade.id, 200, 0.6), // Early mid, pick 0.14, shiny but rarely reached
      mkNode(1, alt.id, 400, 0.52), // Early mid, pick 0.29, plain positive alternative
    ],
    edges: [],
    summary: {
      matches: 1400,
      players: 1400,
      wins: 700,
      losses: 700,
      avg_duration_s: 1800,
      avg_net_worth: 8000,
    },
    baseline: {
      matches: 1400,
      players: 1400,
      wins: 700,
      losses: 700,
      avg_duration_s: 1800,
      avg_net_worth: 8000,
    },
    reached_per_column: [1400, 1400, 1400, 1400],
  };

  const allIds = (b: ReturnType<typeof generateBuild>) =>
    new Set(
      b.phases.flatMap((p) =>
        [...p.core, ...p.situational].map((c) => c.item.id),
      ),
    );

  it("surfaces the shiny upgrade when line-aware is OFF", () => {
    const b = generateBuild(testHero, "R", items, flow, new Map(), new Map());
    expect(allIds(b).has(upgrade.id)).toBe(true);
  });

  it("keeps the survivorship-inflated upgrade out of the build when line-aware is ON", () => {
    const b = generateBuild(testHero, "R", items, flow, new Map(), new Map(), {
      lineAware: true,
    });
    expect(allIds(b).has(upgrade.id)).toBe(false);
  });

  it("never alters the displayed adjustedWinRate (shrink is rank-only)", () => {
    const b = generateBuild(testHero, "R", items, flow, new Map(), new Map(), {
      lineAware: true,
    });
    // The component stays in core with its shown WR untouched (rank shrink is a separate field).
    const comp = b.phases
      .flatMap((p) => p.core)
      .find((c) => c.item.id === component.id);
    expect(comp?.adjustedWinRate).toBe(0.48);
  });
});

// Line-collapse (BuildOptions.lineAware): when a phase shows both a component (core) and a worthy direct
// upgrade of it (situational), the upgrade is promoted into core and the component folds away — so the
// build recommends the finished item you actually play, not the terminal stat-stick. Mirrors the live
// Paradox result (Lane: High-Velocity Rounds → Opening Rounds).
describe("generateBuild — line-aware line-collapse", () => {
  const comp: Item = {
    id: 1,
    name: "Base Stick",
    tier: 1,
    cost: 800,
    slot: "weapon",
    componentIds: [],
  };
  const upgrade: Item = {
    id: 2,
    name: "Finished Gun",
    tier: 2,
    cost: 1600,
    slot: "weapon",
    componentIds: [comp.id],
  };
  const items = new Map<number, Item>([comp, upgrade].map((i) => [i.id, i]));

  // baseline 50%. Component universal (70%) at a mild −1pt (not a significant loser, so it keeps its core
  // slot); upgrade reached by 25% at a clear +16pt. λ ≈ 0.36 so the shrink still leaves the upgrade well
  // above the component on merit ⇒ worth collapsing into. One weapon slot, so the component takes core and
  // the upgrade lands in situational — until collapse promotes it.
  const flow: ItemFlowStats = {
    nodes: [mkNode(0, comp.id, 700, 0.49), mkNode(0, upgrade.id, 250, 0.66)],
    edges: [],
    summary: {
      matches: 1000,
      players: 1000,
      wins: 500,
      losses: 500,
      avg_duration_s: 1800,
      avg_net_worth: 8000,
    },
    baseline: {
      matches: 1000,
      players: 1000,
      wins: 500,
      losses: 500,
      avg_duration_s: 1800,
      avg_net_worth: 8000,
    },
    reached_per_column: [1000, 1000, 1000, 1000],
  };
  const coreIds = (b: ReturnType<typeof generateBuild>) =>
    new Set(b.phases.flatMap((p) => p.core.map((c) => c.item.id)));
  const allIds = (b: ReturnType<typeof generateBuild>) =>
    new Set(
      b.phases.flatMap((p) =>
        [...p.core, ...p.situational].map((c) => c.item.id),
      ),
    );

  it("keeps the terminal component in core when line-aware is OFF", () => {
    const b = generateBuild(testHero, "R", items, flow, new Map(), new Map());
    expect(coreIds(b).has(comp.id)).toBe(true);
    expect(coreIds(b).has(upgrade.id)).toBe(false);
    expect(allIds(b).has(upgrade.id)).toBe(true); // surfaced situationally
  });

  it("collapses the component into its worthy upgrade in core when line-aware is ON", () => {
    const b = generateBuild(testHero, "R", items, flow, new Map(), new Map(), {
      lineAware: true,
    });
    expect(coreIds(b).has(upgrade.id)).toBe(true); // the finished item now holds the slot
    expect(allIds(b).has(comp.id)).toBe(false); // the terminal component folded away
  });
});
