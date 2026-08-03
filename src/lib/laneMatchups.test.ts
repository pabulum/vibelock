import { describe, expect, it } from "vitest";
import type { WpStats } from "../api/wpStats";
import {
  laneEdgeIsReal,
  laneInsight,
  laneMatchups,
  laneReadFor,
  laneStrengthNote,
} from "./laneMatchups";

function wp(
  strengths: Record<string, number>,
  matchups: Record<string, Record<string, [number, number, number]>>,
): WpStats {
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
    lane: { tickS: 600, obs: 100000, minN: 200, strengths, matchups },
  } as WpStats;
}

const N = 5000;

describe("laneMatchups", () => {
  it("is null when the bake carries no lane block", () => {
    const bare = { ...wp({}, {}), lane: undefined } as WpStats;
    expect(laneMatchups(bare, 15)).toBeNull();
  });

  it("is null for a hero with no baked pairs", () => {
    expect(laneMatchups(wp({ "15": 0 }, { "15": {} }), 99)).toBeNull();
  });

  it("splits on the residual, not the raw differential", () => {
    // Hero 15 out-farms 20 by 400 souls raw, but strengths already explain all of it — that is not
    // a matchup, it is two heroes with different farm rates.
    const s = laneMatchups(
      wp(
        { "15": 300, "20": -100, "21": 0 },
        {
          "15": {
            "20": [N, 400, 0],
            "21": [N, 0, -300],
          },
        },
      ),
      15,
    )!;
    expect(s.hard.map((m) => m.enemyHeroId)).toEqual([21]);
    expect(s.good).toHaveLength(0);
  });

  it("orders hard worst-first and good best-first", () => {
    const s = laneMatchups(
      wp(
        { "15": 0 },
        {
          "15": {
            "20": [N, 0, -200],
            "21": [N, 0, -500],
            "22": [N, 0, 900],
            "23": [N, 0, 300],
          },
        },
      ),
      15,
    )!;
    expect(s.hard.map((m) => m.resid)).toEqual([-500, -200]);
    expect(s.good.map((m) => m.resid)).toEqual([900, 300]);
  });

  it("drops pairs under the display sample floor", () => {
    const s = laneMatchups(
      wp({ "15": 0 }, { "15": { "20": [10, 0, -900] } }),
      15,
    )!;
    expect(s.hard).toHaveLength(0);
  });

  it("drops residuals inside the noise floor", () => {
    const s = laneMatchups(
      wp({ "15": 0 }, { "15": { "20": [N, 0, -80], "21": [N, 0, 60] } }),
      15,
    )!;
    expect(s.hard).toHaveLength(0);
    expect(s.good).toHaveLength(0);
  });

  it("carries the hero's own fitted lane strength", () => {
    const s = laneMatchups(
      wp({ "15": 380 }, { "15": { "20": [N, 0, -200] } }),
      15,
    )!;
    expect(s.strength).toBe(380);
    expect(s.tickS).toBe(600);
  });
});

describe("laneReadFor", () => {
  const stats = wp({ "15": 0 }, { "15": { "20": [N, 250, 40] } });

  it("returns an even matchup rather than hiding it", () => {
    // A picked enemy must get an answer; silence would read as missing data.
    const r = laneReadFor(stats, 15, 20)!;
    expect(r.resid).toBe(40);
    expect(laneEdgeIsReal(r.resid)).toBe(false);
    expect(laneInsight(r, "Seven")).toContain("even lane");
  });

  it("is null for a pair that was never baked", () => {
    expect(laneReadFor(stats, 15, 99)).toBeNull();
  });
});

describe("wording", () => {
  it("never claims a win rate", () => {
    const hard = laneInsight(
      { enemyHeroId: 20, n: N, rawDiff: -400, resid: -300 },
      "Seven",
    );
    expect(hard).toContain("beats you in lane by 300 souls");
    expect(hard).not.toMatch(/win rate|%/);
  });

  it("describes a weak laner without calling the hero weak", () => {
    const note = laneStrengthNote(-350, "Seven");
    expect(note).toContain("not where this hero wins");
    expect(note).not.toMatch(/bad|weak hero/);
  });

  it("calls a near-zero strength average", () => {
    expect(laneStrengthNote(40, "Paradox")).toContain("about average");
  });
});
