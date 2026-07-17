import { describe, expect, it } from "vitest";
import {
  expectedOwnS,
  fmtClock,
  leadAtS,
  phaseAtS,
  timelineAt,
  timelineEndS,
} from "./timeline";
import type { WpStats } from "../api/wpStats";
import type { BuildItem, BuildPhase, GeneratedBuild, Item } from "../types";

function item(id: number, name = `Item ${id}`): Item {
  return { id, name, tier: 1, cost: 500, slot: "weapon", componentIds: [] };
}

function pick(id: number, buyTimeS?: number): BuildItem {
  return {
    item: item(id),
    role: "universal",
    pickRate: 0.5,
    adjustedWinRate: 0.5,
    rawWinRate: 0.5,
    sample: 1000,
    decided: 1000,
    avgNetWorthAtBuy: 0,
    buyTimeS,
    why: "",
  };
}

function phase(
  column: number,
  core: BuildItem[],
  soulBudget: number,
): BuildPhase {
  return {
    column,
    label: `P${column}`,
    timeLabel: "",
    targetItems: core.length,
    itemsBought: core.length,
    soulBudget,
    coreSouls: 0,
    categorySouls: { weapon: 0, vitality: 0, spirit: 0 },
    core,
    situational: [],
  };
}

function build(phases: BuildPhase[], avgDurationS = 2100): GeneratedBuild {
  return {
    hero: { id: 1, name: "Hero" } as GeneratedBuild["hero"],
    rankLabel: "",
    population: { matches: 1000, avgDurationS, baselineWinRate: 0.5 },
    phases,
    standingSlots: 0,
    overtimePool: [],
    overtimeBuys: [],
    overtimeSell: [],
  };
}

describe("timelineAt", () => {
  const b = build([
    phase(0, [pick(1, 120), pick(2, 400)], 6000),
    phase(1, [pick(3, 900), pick(4)], 8000), // pick 4: no buy time ⇒ phase midpoint (870s)
  ]);

  it("splits owned vs upcoming picks around the scrubbed second", () => {
    const snap = timelineAt(b, 500);
    expect([...snap.ownedIds]).toEqual([1, 2]);
    expect(snap.ownedCount).toBe(2);
    expect(snap.coreCount).toBe(4);
  });

  it("names the next buy — the earliest expected own-time after t", () => {
    expect(timelineAt(b, 500).nextName).toBe("Item 4"); // midpoint 870 beats pick 3's 900
    expect(timelineAt(b, 880).nextName).toBe("Item 3");
    expect(timelineAt(b, 1000).nextId).toBeNull();
  });

  it("falls back to the phase-window midpoint when a pick has no buy time", () => {
    expect(expectedOwnS(b, pick(9), 1)).toBe((540 + 1200) / 2);
    const snap = timelineAt(b, 871);
    expect(snap.ownedIds.has(4)).toBe(true);
  });

  it("ramps each phase's soul budget linearly across its window", () => {
    expect(timelineAt(b, 0).spentSouls).toBe(0);
    expect(timelineAt(b, 270).spentSouls).toBe(3000); // halfway through Lane
    expect(timelineAt(b, 540).spentSouls).toBe(6000); // Lane budget fully spent
    // Halfway through Early mid (540 + 330 of 660): all of Lane + half of EM.
    expect(timelineAt(b, 870).spentSouls).toBe(6000 + 4000);
  });
});

describe("timelineEndS", () => {
  it("runs the axis to the average game length, floored at 40 minutes", () => {
    expect(timelineEndS(build([], 2100))).toBe(2400);
    expect(timelineEndS(build([], 2700))).toBe(2700);
  });
});

describe("leadAtS", () => {
  const wp = {
    wpModel: [
      { fromS: 0, toS: 600, sigma: 800, w0: 0, w1: 0.2 },
      { fromS: 600, toS: null, sigma: 2500, w0: 0, w1: 0.9 },
    ],
  } as WpStats;

  it("reads the bin covering t and converts a one-sigma lead to a win %", () => {
    expect(leadAtS(wp, 300)).toEqual({
      sigmaSouls: 800,
      pctAtSigma: Math.round(100 / (1 + Math.exp(-0.2))),
    });
    expect(leadAtS(wp, 1800)?.sigmaSouls).toBe(2500);
  });
});

describe("clock helpers", () => {
  it("formats mm:ss", () => {
    expect(fmtClock(0)).toBe("0:00");
    expect(fmtClock(870)).toBe("14:30");
  });

  it("maps a second to its phase column", () => {
    expect(phaseAtS(0)).toBe(0);
    expect(phaseAtS(539)).toBe(0);
    expect(phaseAtS(540)).toBe(1);
    expect(phaseAtS(1799)).toBe(2);
    expect(phaseAtS(3600)).toBe(3);
  });
});
