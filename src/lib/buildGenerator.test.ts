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
