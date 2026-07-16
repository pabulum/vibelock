import { describe, expect, it } from "vitest";
import type { MatchHistoryRow, MetricDistribution } from "../types";
import {
  climbAdvice,
  fundamentalsRows,
  percentileOf,
  recentWindow,
  WEAK_PERCENTILE,
  type FundamentalRow,
} from "./fundamentals";

const dist = (scale = 1): MetricDistribution => ({
  avg: 50 * scale,
  std: 20 * scale,
  percentile1: 10 * scale,
  percentile5: 20 * scale,
  percentile10: 25 * scale,
  percentile25: 35 * scale,
  percentile50: 50 * scale,
  percentile75: 65 * scale,
  percentile90: 80 * scale,
  percentile95: 90 * scale,
  percentile99: 110 * scale,
});

describe("percentileOf", () => {
  it("hits the grid points exactly", () => {
    expect(percentileOf(50, dist())).toBe(50);
    expect(percentileOf(80, dist())).toBe(90);
  });

  it("interpolates linearly between grid points", () => {
    // Halfway between p50 (50) and p75 (65) is 57.5 ⇒ percentile 62.5.
    expect(percentileOf(57.5, dist())).toBeCloseTo(62.5, 6);
  });

  it("clamps at the resolvable edges", () => {
    expect(percentileOf(-5, dist())).toBe(1);
    expect(percentileOf(1e9, dist())).toBe(99);
  });
});

describe("fundamentalsRows", () => {
  it("places the player on the ladder and inverts better-low metrics", () => {
    const ladder = {
      net_worth_per_min: dist(10),
      deaths: dist(0.1),
    };
    const player = {
      net_worth_per_min: { ...dist(10), avg: 650 }, // = ladder p75
      deaths: { ...dist(0.1), avg: 6.5 }, // p75 of deaths ⇒ goodness 25
    };
    const rows = fundamentalsRows(player, ladder);
    const souls = rows.find((r) => r.key === "net_worth_per_min")!;
    const deaths = rows.find((r) => r.key === "deaths")!;
    expect(souls.percentile).toBe(75);
    expect(deaths.percentile).toBe(25);
    expect(deaths.value).toBe("6.5");
    expect(souls.ladderMedian).toBe("500");
  });

  it("skips metrics missing on either side and degenerate ladder slices", () => {
    const flat = { ...dist(), percentile1: 5, percentile99: 5 };
    expect(fundamentalsRows({ deaths: dist() }, {})).toEqual([]);
    expect(fundamentalsRows({ deaths: dist() }, { deaths: flat })).toEqual([]);
  });

  it('treats the API\'s null-filled "empty slice" metrics as absent', () => {
    // No games on this hero ⇒ every field comes back null, not missing.
    const nulls = Object.fromEntries(
      Object.keys(dist()).map((k) => [k, null]),
    ) as unknown as MetricDistribution;
    expect(fundamentalsRows({ deaths: nulls }, { deaths: dist() })).toEqual([]);
    expect(fundamentalsRows({ deaths: dist() }, { deaths: nulls })).toEqual([]);
  });
});

describe("recentWindow", () => {
  const DAY = 86400;
  const now = Math.floor(Date.now() / 1000);
  const game = (heroId: number, daysAgo: number): MatchHistoryRow => ({
    match_id: daysAgo,
    hero_id: heroId,
    start_time: now - daysAgo * DAY,
    match_duration_s: 2000,
    match_result: 0,
    player_team: 0,
    player_kills: 0,
    player_deaths: 0,
    player_assists: 0,
    net_worth: 0,
  });

  it("windows to the Nth most recent game on the hero", () => {
    const history = [
      game(1, 1),
      game(1, 5),
      game(2, 6), // other hero — excluded
      game(1, 10),
      game(1, 40), // outside the last 3
    ];
    const w = recentWindow(history, 1, 3)!;
    expect(w.games).toBe(3);
    // Window opens just before the 3rd-newest hero-1 game (10 days ago), so the 40-day-old one is out.
    expect(w.minUnixTimestamp).toBe(now - 10 * DAY - 1);
    expect(w.spanDays).toBe(10);
  });

  it("never reaches past the games it counted — a long break can't leak in", () => {
    // A returning player: 4 recent games, and an old self from ~2 years ago.
    const history = [
      game(1, 1),
      game(1, 2),
      game(1, 3),
      game(1, 4),
      game(1, 650),
    ];
    const w = recentWindow(history, 1, 4)!;
    expect(w.games).toBe(4);
    expect(w.spanDays).toBe(4);
    expect(w.minUnixTimestamp).toBeGreaterThan(now - 5 * DAY);
  });

  it("takes everything when the player has fewer games than asked for", () => {
    const w = recentWindow([game(1, 1), game(1, 9), game(1, 20)], 1, 50)!;
    expect(w.games).toBe(3);
    expect(w.spanDays).toBe(20);
  });

  it("pools all heroes when heroId is null", () => {
    const w = recentWindow([game(1, 1), game(2, 2), game(3, 3)], null, 20)!;
    expect(w.games).toBe(3);
  });

  it("honors an explicit last-game request rather than widening it", () => {
    const w = recentWindow([game(1, 1), game(1, 8)], 1, 1)!;
    expect(w.games).toBe(1);
    expect(w.spanDays).toBe(1); // just the newest game
  });

  it("returns null only when the hero has no games at all", () => {
    expect(recentWindow([game(2, 1)], 1, 20)).toBeNull(); // other hero only
    expect(recentWindow([], 1, 20)).toBeNull();
    expect(recentWindow([game(1, 1)], 1, 20)).not.toBeNull(); // one game is enough
  });
});

describe("climbAdvice", () => {
  const row = (key: string, percentile: number): FundamentalRow => ({
    key,
    label: key,
    value: "0",
    percentile,
    ladderMedian: "0",
  });

  it("surfaces the weakest controllable levers, furthest-below first", () => {
    const tips = climbAdvice(
      [
        row("last_hits", 15), // weak, and weakest
        row("neutral_damage_per_min", 30), // weak
        row("deaths", 80), // strong — ignored
        row("accuracy", 10), // not a lever — ignored even though low
      ],
      "Abrams",
    );
    expect(tips.map((t) => t.key)).toEqual([
      "last_hits",
      "neutral_damage_per_min",
    ]);
    expect(tips[0].action).toBe("Secure your orbs");
    expect(tips[0].detail).toContain("Abrams"); // {hero} substituted
  });

  it("caps at two tips by default", () => {
    const tips = climbAdvice(
      [
        row("deaths", 5),
        row("last_hits", 10),
        row("neutral_damage_per_min", 12),
        row("denies", 14),
      ],
      "Haze",
    );
    expect(tips).toHaveLength(2);
  });

  it("breaks percentile ties by lever priority (survival/farm over fights)", () => {
    const tips = climbAdvice(
      [row("player_damage_per_min", 20), row("deaths", 20)],
      "Seven",
    );
    expect(tips[0].key).toBe("deaths"); // priority 3 > 1 at equal percentile
  });

  it("returns nothing when controllables sit at or above the ladder", () => {
    expect(
      climbAdvice([row("last_hits", WEAK_PERCENTILE), row("deaths", 60)], "Mo"),
    ).toEqual([]);
  });

  it("never recommends a non-lever outcome (kills), even if low", () => {
    expect(climbAdvice([row("kills", 5)], "Vindicta")).toEqual([]);
  });
});
