import { describe, expect, it } from "vitest";
import {
  analyzeMatch,
  benchmarkEconomy,
  deathInsights,
  deathsSummary,
  economyRows,
  heroFarmProfile,
  matchFundamentals,
  winProbability,
  wpTimeline,
} from "./matchAnalysis";
import type { WpStats } from "../api/wpStats";
import type {
  MatchInfo,
  MatchPlayer,
  MetricDistribution,
  PlayerMetrics,
} from "../types";

// A flat WP surface: one bin covering the whole game, sigma 1000, and a slope that makes the
// numbers easy to reason about — wp(lead=1000) = σ(1) ≈ 0.731, wp(0) = 0.5.
const WP: WpStats = {
  generatedAt: "",
  window: { fromDay: "", toDay: "", matches: 0, purchases: 0 },
  meanExcess: 0,
  wpModel: [{ fromS: 0, toS: null, sigma: 1000, w0: 0, w1: 1 }],
  items: [],
  heroes: [],
};

const player = (over: Partial<MatchPlayer>): MatchPlayer => ({
  account_id: 0,
  player_slot: 0,
  team: "Team0",
  hero_id: 1,
  kills: 0,
  deaths: 0,
  assists: 0,
  net_worth: 0,
  ...over,
});

// Two players, one per team. Team0's player climbs to a 2,000-soul lead by t=600.
const MATCH: MatchInfo = {
  match_id: 42,
  start_time: 0,
  duration_s: 600,
  winning_team: "Team0",
  average_badge_team0: 95,
  players: [
    player({
      account_id: 100,
      team: "Team0",
      net_worth: 3000,
      kills: 3,
      deaths: 2,
      assists: 5,
      last_hits: 120,
      denies: 10,
      stats: [
        {
          time_stamp_s: 300,
          net_worth: 1500,
          kills: 1,
          deaths: 1,
          assists: 2,
          denies: 5,
          shots_hit: 60,
          shots_missed: 40,
          player_damage: 5000,
        },
        {
          time_stamp_s: 600,
          net_worth: 3000,
          kills: 3,
          deaths: 2,
          assists: 5,
          denies: 10,
          shots_hit: 150,
          shots_missed: 50,
          player_damage: 12000,
          gold_death_loss: 400,
          gold_sources: [
            { source: 2, gold: 700, gold_orbs: 500 }, // lane creeps + orbs
            { source: 3, gold: 900 }, // neutral camps
            { source: 12, gold: 300 }, // breakables
            { source: 1, gold: 350 }, // kills
            { source: 6, gold: 150 }, // assists
            { source: 5, gold: 100 }, // urn
            { source: 8, gold: 0 }, // team bonus: zero → dropped
          ],
        },
      ],
      death_details: [
        { game_time_s: 200 }, // Lane (0–9 min)
        { game_time_s: 700 }, // Early mid (9–20 min) — past duration but bucket math is pure
      ],
    }),
    player({
      account_id: 200,
      team: "Team1",
      net_worth: 1000,
      stats: [
        {
          time_stamp_s: 300,
          net_worth: 500,
          kills: 0,
          deaths: 0,
          assists: 0,
          denies: 0,
        },
        {
          time_stamp_s: 600,
          net_worth: 1000,
          kills: 0,
          deaths: 0,
          assists: 0,
          denies: 0,
        },
      ],
    }),
  ],
};

describe("winProbability", () => {
  it("prices a one-sigma lead through the bin's logistic", () => {
    expect(winProbability(WP, 100, 0)).toBeCloseTo(0.5, 5);
    expect(winProbability(WP, 100, 1000)!).toBeCloseTo(
      1 / (1 + Math.exp(-1)),
      5,
    );
  });

  it("returns null outside every bin", () => {
    const wp: WpStats = {
      ...WP,
      wpModel: [{ fromS: 0, toS: 300, sigma: 1000, w0: 0, w1: 1 }],
    };
    expect(winProbability(wp, 500, 0)).toBeNull();
  });
});

describe("wpTimeline", () => {
  it("tracks the focus team's lead at each stat sample, starting even", () => {
    const { points } = wpTimeline(MATCH, "Team0", WP);
    expect(points.map((p) => p.t)).toEqual([0, 300, 600]);
    expect(points[0].wp).toBeCloseTo(0.5, 5);
    expect(points[1].lead).toBe(1000); // 1500 − 500
    expect(points[2].lead).toBe(2000); // 3000 − 1000
    expect(points[2].wp).toBeGreaterThan(points[1].wp);
  });

  it("mirrors for the other team", () => {
    const { points } = wpTimeline(MATCH, "Team1", WP);
    expect(points[2].lead).toBe(-2000);
    expect(points[2].wp).toBeLessThan(0.5);
  });

  it("ranks the biggest inter-sample swing first", () => {
    const { swings } = wpTimeline(MATCH, "Team0", WP);
    // 0→300 moves wp by σ(1)−0.5 ≈ 0.231; 300→600 by σ(2)−σ(1) ≈ 0.150.
    expect(swings[0].fromT).toBe(0);
    expect(swings[0].delta).toBeGreaterThan(swings[1].delta);
  });

  it("is empty without a WP surface", () => {
    expect(wpTimeline(MATCH, "Team0", null).points).toEqual([]);
  });
});

describe("matchFundamentals", () => {
  const dist = (lo: number, mid: number, hi: number): MetricDistribution => ({
    avg: mid,
    std: 1,
    percentile1: lo,
    percentile5: lo,
    percentile10: lo,
    percentile25: lo,
    percentile50: mid,
    percentile75: hi,
    percentile90: hi,
    percentile95: hi,
    percentile99: hi,
  });

  it("places this game's souls/min on the ladder and inverts deaths", () => {
    const ladder: PlayerMetrics = {
      net_worth_per_min: dist(100, 300, 500), // this game: 3000/10min = 300/min ⇒ p50
      deaths: dist(0, 2, 10), // 2 deaths ⇒ p50 ⇒ inverted stays 50
    };
    const rows = matchFundamentals(MATCH.players[0], 600, ladder);
    const souls = rows.find((r) => r.key === "net_worth_per_min");
    const deaths = rows.find((r) => r.key === "deaths");
    expect(souls?.percentile).toBe(50);
    expect(souls?.value).toBe("300");
    expect(deaths?.percentile).toBe(50);
  });

  it("skips metrics the ladder can't grid", () => {
    const ladder: PlayerMetrics = { net_worth_per_min: dist(300, 300, 300) };
    expect(matchFundamentals(MATCH.players[0], 600, ladder)).toEqual([]);
  });
});

describe("economyRows", () => {
  it("sums orbs into the source, groups kinds, sorts by gold, drops zeros", () => {
    const rows = economyRows(MATCH.players[0], 600);
    expect(rows.map((r) => r.key)).toEqual([
      "lane", // 700+500 = 1200
      "camps", // 900
      "kills", // 350+150 = 500
      "boxes", // 300
      "urn", // 100
    ]);
    const lane = rows[0];
    expect(lane.gold).toBe(1200);
    expect(lane.kind).toBe("steady");
    expect(lane.perMin).toBeCloseTo(120, 5);
    expect(lane.src).toBe(2); // single source ⇒ benchmarkable
    expect(rows.find((r) => r.key === "camps")?.kind).toBe("steady");
    expect(rows.find((r) => r.key === "camps")?.src).toBe(3);
    expect(rows.find((r) => r.key === "kills")?.kind).toBe("swingy");
    expect(rows.find((r) => r.key === "kills")?.src).toBeUndefined(); // grouped ⇒ not benchmarked
    // Shares sum to 1 over the shown rows (team bonus was zero and dropped).
    expect(rows.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1, 5);
  });
});

describe("benchmarkEconomy", () => {
  const wp = (norms: WpStats["farmNorms"]): WpStats => ({
    ...WP,
    farmPcts: [10, 25, 50, 75, 90],
    farmNorms: norms,
  });
  const rows = economyRows(MATCH.players[0], 600); // lane 120/min, camps 90/min

  it("places a single-source row on the population percentile grid", () => {
    // Hero 1, tier 9. Camps grid [10,25,50,75,90] gold/min → percentiles. This game's camps = 90/min.
    const stats = wp({ "1:9": { n: 500, src: { 3: [30, 60, 90, 150, 240] } } });
    const out = benchmarkEconomy(rows, 1, 9, stats);
    const camps = out.find((r) => r.key === "camps")!;
    expect(camps.percentile).toBe(50); // 90 is the p50 grid point
    // Interpolates between grid points too: lane 120/min on [60,90,120,180,240] → p50.
  });

  it("leaves grouped rows and missing cells unbenchmarked", () => {
    const stats = wp({ "1:9": { n: 500, src: { 3: [30, 60, 90, 150, 240] } } });
    const out = benchmarkEconomy(rows, 1, 9, stats);
    expect(out.find((r) => r.key === "kills")!.percentile).toBeUndefined(); // grouped
    // camps has a norm but lane's source (2) isn't in this cell → no benchmark
    expect(out.find((r) => r.key === "lane")!.percentile).toBeUndefined();
  });

  it("no-ops when norms are absent (day-one data)", () => {
    expect(benchmarkEconomy(rows, 1, 9, wp(undefined))).toEqual(rows);
    expect(benchmarkEconomy(rows, 1, 9, null)).toEqual(rows);
    expect(
      benchmarkEconomy(rows, 99, 9, wp({ "1:9": { n: 500, src: {} } })),
    ).toEqual(rows); // wrong hero
  });
});

describe("heroFarmProfile", () => {
  const wp = (norms: WpStats["farmNorms"]): WpStats => ({
    ...WP,
    farmPcts: [10, 25, 50, 75, 90],
    farmNorms: norms,
  });
  // p50 (index 2) medians: camps 100, breakables 50, lane 400, kills 80, assists 20.
  const cell = {
    n: 200,
    src: {
      3: [40, 70, 100, 150, 190],
      12: [20, 35, 50, 70, 95],
      2: [300, 350, 400, 470, 540],
      1: [40, 60, 80, 120, 160],
      6: [10, 15, 20, 30, 40],
    },
  };

  it("builds the median mix, groups kills+assists, and sums steady share", () => {
    const prof = heroFarmProfile(wp({ "5:8": cell }), 5, 8)!;
    expect(prof.tier).toBe(8);
    expect(prof.substituted).toBe(false);
    expect(prof.n).toBe(200);
    // Rows largest-median first; kills+assists collapse to one 100/min "kills" row.
    expect(prof.rows.map((r) => [r.key, r.perMin])).toEqual([
      ["lane", 400],
      ["camps", 100],
      ["kills", 100], // 80 + 20
      ["boxes", 50],
    ]);
    // steadyShare = (lane + camps + breakables) / total = (400 + 100 + 50) / 650; kills is swingy.
    expect(prof.steadyShare).toBeCloseTo(550 / 650, 5);
    expect(prof.rows.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1, 5);
  });

  it("falls back to the nearest baked tier within ±2 and flags it", () => {
    // Requested tier 5 isn't baked; tier 6 is one away ⇒ used and flagged substituted.
    const prof = heroFarmProfile(wp({ "5:6": cell }), 5, 5)!;
    expect(prof.tier).toBe(6);
    expect(prof.substituted).toBe(true);
    // Ties break toward the climb (up): tier 5 requested, both 4 and 6 baked ⇒ 6 wins.
    const both = heroFarmProfile(
      wp({ "5:4": { n: 5, src: cell.src }, "5:6": cell }),
      5,
      5,
    )!;
    expect(both.tier).toBe(6);
    // Beyond ±2 there's no substitute: tier 5 requested, only tier 8 baked ⇒ null.
    expect(heroFarmProfile(wp({ "5:8": cell }), 5, 5)).toBeNull();
  });

  it("drops a grouped row unless every member source is baked", () => {
    // Assists (6) missing ⇒ the kills+assists group can't be formed consistently, so it's omitted.
    const partial = { n: 200, src: { 3: cell.src[3], 1: cell.src[1] } };
    const prof = heroFarmProfile(wp({ "5:8": partial }), 5, 8)!;
    expect(prof.rows.map((r) => r.key)).toEqual(["camps"]);
  });

  it("returns null when the cell, grid, or data is absent", () => {
    expect(heroFarmProfile(wp({ "5:8": cell }), 99, 8)).toBeNull(); // wrong hero
    expect(heroFarmProfile(wp(undefined), 5, 8)).toBeNull();
    expect(heroFarmProfile(null, 5, 8)).toBeNull();
  });
});

describe("deathsSummary", () => {
  it("buckets deaths into build phases and reads the death-loss ledger", () => {
    const d = deathsSummary(MATCH.players[0]);
    expect(d.total).toBe(2);
    expect(d.byPhase.map((b) => `${b.label}:${b.count}`)).toEqual([
      "Lane:1",
      "Early mid:1",
      "Mid:0",
      "Late:0",
    ]);
    expect(d.goldLost).toBe(400);
  });

  it("falls back to the scoreboard count when death_details is missing", () => {
    const d = deathsSummary(player({ deaths: 7 }));
    expect(d.total).toBe(7);
  });

  // The focus player dies 4 times; enemy slot 9 (hero 77) lands 3 of them.
  const victim = player({
    account_id: 1,
    team: "Team0",
    deaths: 4,
    death_details: [
      { game_time_s: 300, killer_player_slot: 9, time_to_kill_s: 2 }, // burst, solo
      { game_time_s: 600, killer_player_slot: 9, time_to_kill_s: 3 }, // burst, solo
      { game_time_s: 900, killer_player_slot: 9, time_to_kill_s: 25 }, // in a fight
      { game_time_s: 1200, killer_player_slot: 8, time_to_kill_s: -1 }, // unknown ttk, solo
    ],
  });
  const mate = player({
    account_id: 2,
    team: "Team0",
    player_slot: 1,
    death_details: [{ game_time_s: 905 }], // 5s from the 900s death ⇒ that one was a team fight
  });
  const enemySlots = new Map([
    [9, 77],
    [8, 55],
  ]);

  it("names a repeat killer as the nemesis", () => {
    const d = deathsSummary(victim, [mate], enemySlots);
    expect(d.nemesis).toEqual({ heroId: 77, count: 3, share: 0.75 });
  });

  it("counts a death as solo only when no teammate died nearby", () => {
    const d = deathsSummary(victim, [mate], enemySlots);
    expect(d.soloPicks).toBe(3); // the 900s death had a teammate die 5s later
  });

  it("counts burst deaths and never treats the -1 sentinel as instant", () => {
    const d = deathsSummary(victim, [mate], enemySlots);
    expect(d.burst).toBe(2); // the 2s and 3s deaths; the -1 is excluded, not counted as 0s
    expect(d.medianTimeToKillS).toBe(3); // sorted [2,3,25] → middle (the -1 never enters)
  });

  it("won't call a one-off killer a nemesis", () => {
    const spread = player({
      deaths: 4,
      death_details: [
        { game_time_s: 100, killer_player_slot: 9 },
        { game_time_s: 200, killer_player_slot: 8 },
        { game_time_s: 300, killer_player_slot: 9 },
        { game_time_s: 400, killer_player_slot: 8 },
      ],
    });
    // 2 kills each: below the 3-kill floor, so neither is a pattern.
    expect(deathsSummary(spread, [], enemySlots).nemesis).toBeUndefined();
  });
});

describe("deathInsights", () => {
  const base = {
    total: 4,
    byPhase: [],
    soloPicks: 0,
    burst: 0,
  };

  it("calls out the nemesis as a build problem", () => {
    const [line] = deathInsights(
      { ...base, nemesis: { heroId: 77, count: 3, share: 0.75 } },
      "Haze",
    );
    expect(line).toContain("Haze killed you 3 of 4 times");
    expect(line).toContain("build against");
  });

  it("calls out solo picks only when they're the majority", () => {
    expect(deathInsights({ ...base, soloPicks: 3 }).join()).toContain(
      "picked off alone",
    );
    expect(deathInsights({ ...base, soloPicks: 2 }).join()).not.toContain(
      "picked off alone",
    );
  });

  it("reads long deaths as overstaying, short ones as positioning", () => {
    expect(deathInsights({ ...base, burst: 2 }).join()).toContain("under 5s");
    expect(deathInsights({ ...base, medianTimeToKillS: 25 }).join()).toContain(
      "Leave earlier",
    );
  });

  it("says nothing when there's nothing to say", () => {
    expect(deathInsights({ ...base, total: 0 })).toEqual([]);
    expect(deathInsights(base)).toEqual([]);
  });
});

describe("analyzeMatch", () => {
  it("assembles the focus player's full read", () => {
    const a = analyzeMatch(MATCH, 100, WP, {});
    expect(a).not.toBeNull();
    expect(a!.won).toBe(true);
    expect(a!.averageBadge).toBe(95);
    expect(a!.wp.points.length).toBe(3);
    expect(a!.economy.length).toBeGreaterThan(0);
  });

  it("returns null when the account isn't in the match", () => {
    expect(analyzeMatch(MATCH, 999, WP, {})).toBeNull();
  });

  it("scores the losing seat as a loss", () => {
    const a = analyzeMatch(MATCH, 200, WP, {});
    expect(a!.won).toBe(false);
  });
});
