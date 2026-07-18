import { describe, expect, it } from "vitest";
import type {
  BuildItem,
  BuildPhase,
  FlowNode,
  GeneratedBuild,
  Item,
  ItemFlowStats,
} from "../../types";
import { PHASE_META } from "./phaseFill";
import { itemVerdict } from "./verdict";

const item = (id: number, name: string, cost = 1000, slot: Item["slot"] = "weapon"): Item => ({
  id,
  name,
  tier: 2,
  cost,
  slot,
  componentIds: [],
});

const node = (
  itemId: number,
  column: number,
  players: number,
  adj: number,
  decided = players,
): FlowNode => ({
  column,
  item_id: itemId,
  wins: Math.round(decided * adj),
  losses: decided - Math.round(decided * adj),
  players,
  matches: players,
  adjusted_win_rate: adj,
  avg_net_worth_at_buy: 3000,
  total_kills: 0,
  total_deaths: 0,
  total_assists: 0,
});

const REACHED = 1000;
const flowOf = (nodes: FlowNode[]): ItemFlowStats => {
  const summary = {
    matches: REACHED,
    players: REACHED,
    wins: 500,
    losses: 500,
    avg_duration_s: 1800,
    avg_net_worth: 30000,
  };
  return {
    nodes,
    edges: [],
    summary,
    baseline: summary,
    reached_per_column: [REACHED, REACHED, REACHED, REACHED],
  };
};

const buildItem = (
  it: Item,
  pickRate: number,
  adj: number,
  decided: number,
): BuildItem => ({
  item: it,
  role: "universal",
  pickRate,
  adjustedWinRate: adj,
  rawWinRate: adj,
  sample: decided,
  decided,
  avgNetWorthAtBuy: 3000,
  why: "",
});

const buildOf = (
  perPhase: Partial<Record<number, Pick<BuildPhase, "core" | "situational">>>,
  pairGames?: GeneratedBuild["pairGames"],
): GeneratedBuild => ({
  hero: { id: 1, name: "Testo", signatureClasses: [] },
  rankLabel: "Eternus+",
  population: { matches: REACHED, avgDurationS: 1800, baselineWinRate: 0.5 },
  phases: PHASE_META.map((m, col) => ({
    column: col,
    label: m.label,
    timeLabel: m.timeLabel,
    targetItems: 1,
    itemsBought: 0,
    soulBudget: 5000,
    coreSouls: 0,
    categorySouls: { weapon: 0, vitality: 0, spirit: 0 },
    core: perPhase[col]?.core ?? [],
    situational: perPhase[col]?.situational ?? [],
  })),
  standingSlots: 0,
  overtimeBuys: [],
  overtimePool: [],
  overtimeSell: [],
  pairGames,
});

describe("itemVerdict", () => {
  const items = new Map<number, Item>();
  const reg = (it: Item) => {
    items.set(it.id, it);
    return it;
  };

  it("reports membership for an item already in the build", () => {
    const core = reg(item(1, "Staple"));
    const situ = reg(item(2, "Option"));
    const build = buildOf({
      0: { core: [buildItem(core, 0.6, 0.52, 500)], situational: [] },
      2: { core: [], situational: [buildItem(situ, 0.1, 0.53, 300)] },
    });
    const flow = flowOf([node(1, 0, 600, 0.52)]);
    expect(itemVerdict(1, flow, build, items)).toEqual({
      kind: "in-build",
      where: "core",
      phaseLabel: "Lane",
    });
    expect(itemVerdict(2, flow, build, items)).toMatchObject({
      kind: "in-build",
      where: "situational",
      phaseLabel: "Mid",
    });
  });

  it("returns no-data when nobody at this rank buys the item", () => {
    const build = buildOf({});
    expect(itemVerdict(999, flowOf([]), build, items)).toEqual({
      kind: "no-data",
    });
  });

  it("fires the sample floor when every phase is under support", () => {
    reg(item(3, "Fringe Pick"));
    const build = buildOf({});
    // 15 buyers < MIN_SUPPORT_ABS (40) — the fill never even scored it.
    const v = itemVerdict(3, flowOf([node(3, 1, 15, 0.62)]), build, items);
    expect(v).toMatchObject({ kind: "sample-floor", players: 15, floor: 40 });
    if (v.kind === "sample-floor") {
      expect(v.stats.phaseLabel).toBe("Early mid");
    }
  });

  it("names the winner of an either/or co-purchase conflict", () => {
    const rival = reg(item(10, "Monster Rounds", 1000));
    reg(item(11, "High-Velocity Rounds", 1000));
    // Both every-game weapon picks; measured overlap 10% of the smaller camp — substitutes.
    const build = buildOf(
      { 0: { core: [buildItem(rival, 0.6, 0.53, 5000)], situational: [] } },
      () => ({ joint: 500, totalA: 5000, totalB: 5000 }),
    );
    const v = itemVerdict(
      11,
      flowOf([node(11, 0, 500, 0.52, 4000)]),
      build,
      items,
    );
    expect(v).toMatchObject({
      kind: "either-or",
      winner: { id: 10, name: "Monster Rounds" },
      winnerWr: 0.53,
      overlap: 0.1,
    });
  });

  it("reports the buyer contrast for a popular pick whose buyers lose", () => {
    reg(item(20, "Headhunter Trap"));
    const build = buildOf({});
    // 40% pick, buyers at 47% vs a 50% baseline over 4000 decided — the revoked-seat case.
    const v = itemVerdict(
      20,
      flowOf([node(20, 0, 400, 0.47, 4000)]),
      build,
      items,
    );
    expect(v).toMatchObject({ kind: "popular-but-losing" });
    if (v.kind === "popular-but-losing") {
      // Observed −3pt at 40% pick ⇒ implied buyer-vs-non-buyer gap of 3/(1−0.4) = 5pt.
      expect(v.contrast).toBeCloseTo(0.05, 5);
    }
  });

  it("reports the marginal win rate for a below-baseline pick", () => {
    reg(item(21, "Losing Pick"));
    const build = buildOf({});
    const v = itemVerdict(
      21,
      flowOf([node(21, 0, 150, 0.48, 2000)]),
      build,
      items,
    );
    expect(v).toMatchObject({ kind: "below-baseline" });
    if (v.kind === "below-baseline") {
      expect(v.stats.adjustedWinRate).toBeCloseTo(0.48, 5);
      expect(v.stats.baseline).toBeCloseTo(0.5, 5);
      expect(v.stats.lcbEdge).toBeLessThan(0);
    }
  });

  it("names the pick that outranked a seatable item in the slot contest", () => {
    const seated = reg(item(30, "Proven Carry", 1000));
    reg(item(31, "Nearly Made It", 1000));
    const build = buildOf({
      0: { core: [buildItem(seated, 0.5, 0.56, 5000)], situational: [] },
    });
    // Above baseline, well-sampled, sub-universal, no conflict — it just ranked lower.
    const v = itemVerdict(
      31,
      flowOf([node(31, 0, 150, 0.53, 2000)]),
      build,
      items,
    );
    expect(v).toMatchObject({
      kind: "lost-slot",
      beatenBy: { id: 30, name: "Proven Carry" },
      beatenByWr: 0.56,
    });
  });

  it("judges at the item's best supported phase, not a thin earlier one", () => {
    reg(item(40, "Late Bloomer"));
    const build = buildOf({});
    // Under support in Lane, supported in Mid — the fill only ever saw the Mid column.
    const v = itemVerdict(
      40,
      flowOf([node(40, 0, 20, 0.6), node(40, 2, 200, 0.48, 2000)]),
      build,
      items,
    );
    expect(v).toMatchObject({ kind: "below-baseline" });
    if (v.kind === "below-baseline") {
      expect(v.stats.phaseLabel).toBe("Mid");
    }
  });
});
