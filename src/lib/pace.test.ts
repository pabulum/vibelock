import { describe, expect, it } from "vitest";
import type { WpStats } from "../api/wpStats";
import {
  FALLOFF_GAP,
  paceDiagnosis,
  paceInsight,
  paceProfile,
  readPaceWindows,
  WEAK_PACE_PERCENTILE,
  type PaceWindowRead,
} from "./pace";

/** A WpStats carrying only what the pace code reads — the rest of the file is required by the
 * schema but irrelevant here, so it stays minimal rather than pretending to be a real bake. */
function wp(cells: Record<string, unknown>): WpStats {
  return {
    generatedAt: "2026-08-03T00:00:00.000Z",
    window: {
      fromDay: "2026-07-04",
      toDay: "2026-08-02",
      matches: 1,
      purchases: 1,
    },
    meanExcess: 0,
    wpModel: [],
    items: [],
    heroes: [],
    pace: {
      ticksS: [240, 480, 720],
      windowsS: [
        [0, 600],
        [600, 1200],
        [1200, 1800],
        [1800, 2400],
      ],
      levelPcts: [25, 50, 75],
      ratePcts: [10, 25, 50, 75, 90],
      minN: 200,
      cells: cells as never,
    },
  } as WpStats;
}

/** A cell whose four windows sit at rate grids scaled by `scale[i]`, so a test can dial one
 * phase's ladder up or down without hand-writing twenty numbers. */
const cell = (scale = [1, 1, 1, 1]) => ({
  n: [500, 500, 400],
  lv: [
    [2000, 2400, 2800],
    [4400, 5200, 6000],
    [7200, 8800, 10400],
  ],
  won: [2450, 5350, 9100],
  lost: [2400, 5250, 8750],
  wn: [500, 490, 380, 150],
  rt: scale.map((s) => [500, 600, 700, 800, 900].map((v) => Math.round(v * s))),
});

describe("paceProfile", () => {
  it("is null when the bake carries no pace block at all", () => {
    // The state of every deployed build until the first bake that emits one.
    const bare = { ...wp({}), pace: undefined } as WpStats;
    expect(paceProfile(bare, 15, 5)).toBeNull();
  });

  it("is null when nothing is baked within ±2 tiers", () => {
    expect(paceProfile(wp({ "15:9": cell() }), 15, 4)).toBeNull();
  });

  it("substitutes the nearest baked tier and says so", () => {
    const p = paceProfile(wp({ "15:6": cell() }), 15, 5);
    expect(p?.tier).toBe(6);
    expect(p?.substituted).toBe(true);
  });

  it("prefers the exact tier and breaks ties upward", () => {
    const exact = paceProfile(
      wp({ "15:4": cell(), "15:5": cell(), "15:6": cell() }),
      15,
      5,
    );
    expect(exact?.tier).toBe(5);
    expect(exact?.substituted).toBe(false);
    // 4 and 6 are both one away; the climb direction wins.
    const tie = paceProfile(wp({ "15:4": cell(), "15:6": cell() }), 15, 5);
    expect(tie?.tier).toBe(6);
  });

  it("keeps arrays index-aligned with the shared axes", () => {
    const p = paceProfile(wp({ "15:5": cell() }), 15, 5)!;
    expect(p.ticks.map((t) => t.t)).toEqual([240, 480, 720]);
    expect(p.windows.map((w) => w.label)).toEqual([
      "Lane",
      "Early mid",
      "Mid",
      "Late",
    ]);
    expect(p.windows[0].fromS).toBe(0);
    expect(p.windows[0].toS).toBe(600);
  });

  it("carries the winner/loser means through", () => {
    const p = paceProfile(wp({ "15:5": cell() }), 15, 5)!;
    expect(p.ticks[2].won).toBe(9100);
    expect(p.ticks[2].lost).toBe(8750);
  });
});

describe("readPaceWindows", () => {
  // A player earning a flat 700 souls/min for the whole game — exactly the ladder median.
  const flat = (rate: number) => (t: number) => (t / 60) * rate;

  it("places a flat median earner at p50 in every window", () => {
    const p = paceProfile(wp({ "15:5": cell() }), 15, 5)!;
    const reads = readPaceWindows(flat(700), 2400, p);
    expect(reads).toHaveLength(4);
    for (const r of reads) expect(r.percentile).toBe(50);
  });

  it("drops windows the game did not fully play rather than pro-rating them", () => {
    const p = paceProfile(wp({ "15:5": cell() }), 15, 5)!;
    // A 24-minute game has a Lane and an Early mid, but no full 20–30 window.
    const reads = readPaceWindows(flat(700), 24 * 60, p);
    expect(reads.map((r) => r.label)).toEqual(["Lane", "Early mid"]);
  });

  it("reads each window's own rate, not the whole-game average", () => {
    const p = paceProfile(wp({ "15:5": cell() }), 15, 5)!;
    // Strong lane, then a hard flatline: 900/min to 600s, then 300/min after.
    const nwAt = (t: number) =>
      t <= 600 ? (t / 60) * 900 : 9000 + ((t - 600) / 60) * 300;
    const reads = readPaceWindows(nwAt, 2400, p);
    expect(reads[0].rate).toBeCloseTo(900, 5);
    expect(reads[0].percentile).toBe(90);
    expect(reads[1].rate).toBeCloseTo(300, 5);
    expect(reads[1].percentile).toBe(10); // clamped at the grid's low edge
  });

  it("reports the ladder median for each window", () => {
    const p = paceProfile(wp({ "15:5": cell([1, 2, 1, 1]) }), 15, 5)!;
    const reads = readPaceWindows(flat(700), 2400, p);
    expect(reads[0].median).toBe(700);
    expect(reads[1].median).toBe(1400);
  });
});

describe("paceDiagnosis", () => {
  const read = (label: string, percentile: number): PaceWindowRead => ({
    label,
    fromS: 600,
    toS: 1200,
    n: 500,
    p: [500, 600, 700, 800, 900],
    rate: 700,
    percentile,
    median: 700,
  });

  it("is null when every phase is at or above the ladder", () => {
    expect(paceDiagnosis([read("Lane", 55), read("Mid", 60)])).toBeNull();
  });

  it("finds a fall-off when one phase is far below the player's best", () => {
    const d = paceDiagnosis([read("Lane", 70), read("Mid", 70 - FALLOFF_GAP)])!;
    expect(d.falloff).toBe(true);
    expect(d.weakest.label).toBe("Mid");
    expect(d.strongest?.label).toBe("Lane");
    expect(d.gap).toBe(FALLOFF_GAP);
  });

  it("reports a flat deficit as a deficit, not a fall-off", () => {
    // Weak everywhere and evenly so — naming "your worst phase" here would invent a specific
    // problem out of a general one.
    const d = paceDiagnosis([read("Lane", 20), read("Mid", 22)])!;
    expect(d.falloff).toBe(false);
    expect(d.strongest).toBeNull();
    expect(d.weakest.percentile).toBe(20);
  });

  it("stays quiet on a small spread among healthy phases", () => {
    expect(
      paceDiagnosis([read("Lane", 60), read("Mid", 60 - (FALLOFF_GAP - 1))]),
    ).toBeNull();
  });

  it("still names a genuinely low phase when the spread is small", () => {
    const d = paceDiagnosis([read("Lane", WEAK_PACE_PERCENTILE - 1)])!;
    expect(d.falloff).toBe(false);
    expect(d.weakest.percentile).toBe(WEAK_PACE_PERCENTILE - 1);
  });

  it("wording distinguishes the two findings", () => {
    const falloff = paceInsight(
      paceDiagnosis([read("Lane", 75), read("Mid", 40)])!,
    );
    expect(falloff).toContain("where the game leaves you");
    const flat = paceInsight(paceDiagnosis([read("Mid", 15)])!);
    expect(flat).toContain("souls/min is normal here");
    expect(flat).not.toContain("where the game leaves you");
  });
});
