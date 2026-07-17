import { describe, expect, test } from "vitest";
import { shareCardModel, shareLinks, CARD_PHASE_ROWS } from "./shareCard";
import type { BuildItem, BuildPhase, GeneratedBuild, Item } from "../types";

function item(id: number, name: string, slot: Item["slot"] = "weapon"): Item {
  return { id, name, tier: 2, cost: 1250, slot, componentIds: [] };
}

function buildItem(over: Partial<BuildItem> & { item: Item }): BuildItem {
  return {
    role: "universal",
    pickRate: 0.8,
    adjustedWinRate: 0.53,
    rawWinRate: 0.53,
    sample: 1000,
    decided: 1000,
    avgNetWorthAtBuy: 5000,
    why: "",
    ...over,
  };
}

function phase(label: string, core: BuildItem[]): BuildPhase {
  return {
    column: 0,
    label,
    timeLabel: "0–9 min",
    targetItems: core.length,
    itemsBought: core.length,
    soulBudget: 5000,
    coreSouls: 4000,
    categorySouls: { weapon: 4000, vitality: 0, spirit: 0 },
    core,
    situational: [],
  };
}

function build(phases: BuildPhase[]): GeneratedBuild {
  return {
    hero: { id: 1, name: "Paradox", signatureClasses: [] },
    rankLabel: "Eternus",
    population: { matches: 12345, avgDurationS: 2100, baselineWinRate: 0.5 },
    phases,
    standingSlots: 12,
    overtimeBuys: [],
    overtimePool: [],
    overtimeSell: [],
  };
}

describe("shareCardModel", () => {
  test("reduces build to card content with baseline-relative deltas", () => {
    const b = build([
      phase("Lane", [
        buildItem({ item: item(1, "Monster Rounds"), adjustedWinRate: 0.56 }),
        buildItem({
          item: item(2, "Rapid Rounds"),
          adjustedWinRate: 0.49,
          transient: true,
        }),
      ]),
    ]);
    const m = shareCardModel(b, {
      heroName: "Paradox",
      patchLabel: "Update 07-10",
      siteLabel: "example.com",
    });
    expect(m.heroName).toBe("Paradox");
    expect(m.subtitle).toContain("Eternus");
    expect(m.subtitle).toContain("12,345 matches");
    expect(m.subtitle).toContain("avg WR 50%");
    expect(m.phases).toHaveLength(1);
    // delta = adjustedWinRate − baseline (0.5)
    expect(m.phases[0].items[0].delta).toBeCloseTo(0.06);
    expect(m.phases[0].items[1].delta).toBeCloseTo(-0.01);
    expect(m.phases[0].items[1].transient).toBe(true);
  });

  test("caps rows at CARD_PHASE_ROWS and counts the overflow", () => {
    const core = Array.from({ length: CARD_PHASE_ROWS + 3 }, (_, i) =>
      buildItem({ item: item(i + 1, `Item ${i}`) }),
    );
    const m = shareCardModel(build([phase("Lane", core)]), {
      heroName: "Paradox",
      patchLabel: "p",
      siteLabel: "s",
    });
    expect(m.phases[0].items).toHaveLength(CARD_PHASE_ROWS);
    expect(m.phases[0].more).toBe(3);
  });

  test("carries archetype, enemies and fundamentals only when present", () => {
    const bare = shareCardModel(build([]), {
      heroName: "Paradox",
      patchLabel: "p",
      siteLabel: "s",
    });
    expect(bare.archLabel).toBeUndefined();
    expect(bare.enemiesLabel).toBeUndefined();
    expect(bare.fundamentals).toBeUndefined();

    const full = shareCardModel(build([]), {
      heroName: "Paradox",
      patchLabel: "p",
      siteLabel: "s",
      archLabel: "Gun build",
      enemyNames: ["Seven", "Haze"],
      fundamentals: [{ label: "Souls/min", value: "900", percentile: 72 }],
    });
    expect(full.archLabel).toBe("Gun build");
    expect(full.enemiesLabel).toBe("vs Seven, Haze");
    expect(full.fundamentals).toHaveLength(1);
  });

  test("treats an empty enemy list as no comp", () => {
    const m = shareCardModel(build([]), {
      heroName: "Paradox",
      patchLabel: "p",
      siteLabel: "s",
      enemyNames: [],
    });
    expect(m.enemiesLabel).toBeUndefined();
  });
});

describe("shareLinks", () => {
  const origin = "https://pabulum.github.io";
  const base = "/vibelock/";

  test("app link carries the encoded selection", () => {
    const { app } = shareLinks(
      { hero: "paradox", tier: 11 },
      origin,
      base,
    );
    expect(app).toBe("https://pabulum.github.io/vibelock/?hero=paradox&rank=11");
  });

  test("shim link points at the per-hero OG page with the same query", () => {
    const { shim } = shareLinks(
      { hero: "grey-talon", tier: 6, enemies: ["seven"] },
      origin,
      base,
    );
    // The full query — hero included — rides on the shim: its inline script forwards
    // the query string verbatim into the app, so the selection must survive in it.
    expect(shim).toBe(
      "https://pabulum.github.io/vibelock/og/grey-talon.html?hero=grey-talon&rank=6&vs=seven",
    );
  });

  test("no shim without a hero", () => {
    const { app, shim } = shareLinks({ tier: 11 }, origin, base);
    expect(app).toBe("https://pabulum.github.io/vibelock/?rank=11");
    expect(shim).toBeUndefined();
  });
});
