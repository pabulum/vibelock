import { describe, expect, it } from "vitest";
import type { MatchDeath } from "../types";
import {
  cellRect,
  clusterInsight,
  deathCluster,
  deathMarks,
  decodeDensity,
  depthInsight,
  depthRead,
  landmarks,
  placeName,
  teamSign,
  timeDead,
  worldToUnit,
  type DeathMark,
  type MapFrame,
} from "./deathMap";

const H = 11520;

/** The real baked frame, rounded — see scripts/bake-death-map.mjs. Own base at negative y. */
const FRAME: MapFrame = {
  core: { x: 0, y: -8060 },
  tier1: [
    { lane: 1, x: -7970, y: -1850 },
    { lane: 3, x: 150, y: -1790 },
    { lane: 4, x: 6910, y: -2215 },
  ],
  tier2: [
    { lane: 1, x: -6010, y: -4770 },
    { lane: 3, x: -1660, y: -3345 },
    { lane: 4, x: 5370, y: -4910 },
  ],
};

const death = (
  game_time_s: number,
  x: number,
  y: number,
  extra: Partial<MatchDeath> = {},
): MatchDeath => ({
  game_time_s,
  killer_player_slot: 1,
  time_to_kill_s: 8,
  death_pos: { x, y, z: 0 },
  killer_pos: null,
  death_duration_s: 30,
  ...extra,
});

describe("worldToUnit", () => {
  it("puts the world origin at the centre", () => {
    expect(worldToUnit(0, 0, H)).toEqual({ u: 0.5, v: 0.5 });
  });

  it("flips y for screen space", () => {
    // World +y is up, SVG +y is down; a death to the north must draw ABOVE centre.
    expect(worldToUnit(0, H, H).v).toBe(0);
    expect(worldToUnit(0, -H, H).v).toBe(1);
  });

  it("clamps outside the box instead of dropping the point", () => {
    // A death just past the baked extent is still a real death and belongs on the edge.
    const p = worldToUnit(H * 3, -H * 3, H);
    expect(p.u).toBe(1);
    expect(p.v).toBe(1);
  });
});

describe("decodeDensity", () => {
  it("decodes a grid of the declared size", () => {
    const bytes = new Uint8Array(4).fill(200);
    const b64 = Buffer.from(bytes).toString("base64");
    const d = decodeDensity(b64, 2, H)!;
    expect(d.size).toBe(2);
    expect(Array.from(d.cells)).toEqual([200, 200, 200, 200]);
  });

  it("is null when the payload doesn't match the declared size", () => {
    // A shape change must degrade to "no underlay", never to a scrambled map.
    const b64 = Buffer.from(new Uint8Array(3)).toString("base64");
    expect(decodeDensity(b64, 8, H)).toBeNull();
  });

  it("is null on a payload that isn't base64 at all", () => {
    expect(decodeDensity("!!!not base64!!!", 2, H)).toBeNull();
  });
});

describe("deathMarks", () => {
  it("drops deaths with no recorded position rather than placing them at the origin", () => {
    const marks = deathMarks(
      [death(100, 0, 0), death(200, 0, 0, { death_pos: null })],
      H,
    );
    expect(marks).toHaveLength(1);
    expect(marks[0].i).toBe(0);
  });

  it("buckets into the same 600s phase columns as the build", () => {
    const marks = deathMarks(
      [
        death(100, 0, 0),
        death(700, 0, 0),
        death(1300, 0, 0),
        death(5000, 0, 0),
      ],
      H,
    );
    expect(marks.map((m) => m.phase)).toEqual([0, 1, 2, 3]);
  });

  it("carries the killer position as a direction when reported", () => {
    const marks = deathMarks(
      [
        death(100, 0, 0, { killer_pos: { x: H, y: 0, z: 0 } }),
        death(200, 0, 0, { killer_pos: null }),
      ],
      H,
    );
    expect(marks[0].from).toEqual({ u: 1, v: 0.5 });
    expect(marks[1].from).toBeUndefined();
  });
});

describe("deathCluster", () => {
  const at = (u: number, v: number, i = 0): DeathMark => ({
    i,
    gameTimeS: 600,
    phase: 1,
    x: (u - 0.5) * 2 * H,
    y: (0.5 - v) * 2 * H,
    u,
    v,
    deadS: 30,
  });

  it("is null below the minimum count", () => {
    expect(deathCluster([at(0.5, 0.5), at(0.5, 0.5)])).toBeNull();
  });

  it("finds a spot that dominates", () => {
    const marks = [
      at(0.5, 0.5),
      at(0.52, 0.51),
      at(0.49, 0.53),
      at(0.1, 0.9),
      at(0.9, 0.1),
    ];
    const c = deathCluster(marks)!;
    expect(c.count).toBe(3);
    expect(c.share).toBeCloseTo(0.6, 5);
    expect(c.u).toBeCloseTo(0.5033, 2);
    expect(c.deadS).toBe(90);
  });

  it("stays silent when deaths are spread out", () => {
    // Enough deaths, but no concentration — the honest answer is "no habit here".
    const spread = [
      at(0.1, 0.1),
      at(0.9, 0.1),
      at(0.1, 0.9),
      at(0.9, 0.9),
      at(0.5, 0.05),
      at(0.05, 0.5),
    ];
    expect(deathCluster(spread)).toBeNull();
  });

  it("requires a share, not just a count", () => {
    // Three together out of twelve is 25% — a coincidence of a long game, not a pattern.
    const marks = [
      at(0.5, 0.5),
      at(0.51, 0.5),
      at(0.5, 0.51),
      ...Array.from({ length: 9 }, (_, k) => at(0.05 + k * 0.1, 0.05)),
    ];
    expect(deathCluster(marks)).toBeNull();
  });

  it("omits the time cost when any death in the cluster lacks a duration", () => {
    const marks = [
      { ...at(0.5, 0.5), deadS: undefined },
      at(0.51, 0.5),
      at(0.5, 0.51),
    ];
    expect(deathCluster(marks)!.deadS).toBeUndefined();
  });
});

describe("clusterInsight", () => {
  const lms = landmarks(FRAME, H);

  it("reports the count, the share and the cost", () => {
    const c = { u: 0.5, v: 0.5, x: 0, y: 0, count: 6, share: 0.6, deadS: 180 };
    const s = clusterInsight(c, 10)!;
    expect(s).toContain("6 of your 10 deaths");
    expect(s).toContain("one place");
    expect(s).toContain("3 minutes dead");
  });

  it("names the place when a frame is available", () => {
    const t2 = FRAME.tier2[0];
    const c = {
      u: 0,
      v: 0,
      x: t2.x,
      y: t2.y,
      count: 4,
      share: 0.5,
      deadS: 0,
    };
    expect(clusterInsight(c, 8, lms)).toContain("your tier-2 on the left");
  });

  it("stays placeless without a frame rather than guessing", () => {
    const c = { u: 0.5, v: 0.5, x: 0, y: 0, count: 6, share: 0.6, deadS: 0 };
    const s = clusterInsight(c, 10)!;
    expect(s).not.toMatch(/tier|base|half|midline|left|right/i);
  });

  it("says so when deaths are spread and there were enough to mean it", () => {
    const s = clusterInsight(null, 8)!;
    expect(s).toContain("spread across the map");
  });

  it("stays quiet on a short game with no cluster", () => {
    expect(clusterInsight(null, 3)).toBeNull();
  });

  it("omits the time cost when it's trivial", () => {
    const c = { u: 0.5, v: 0.5, x: 0, y: 0, count: 3, share: 0.5, deadS: 30 };
    expect(clusterInsight(c, 6)).not.toContain("minutes dead");
  });
});

describe("teamSign", () => {
  it("leaves Team0 alone and rotates Team1", () => {
    // Team0 already plays from negative y; Team1's game rotates 180° onto the same frame.
    expect(teamSign(0)).toBe(1);
    expect(teamSign(1)).toBe(-1);
  });

  it("puts both teams' own base at the bottom of the map", () => {
    const own = (team: number) => {
      const s = teamSign(team);
      // Each team's spawn, measured from match_paths: Team0 at y ≈ −10100, Team1 at ≈ +10300.
      const y = team === 0 ? -10100 : 10300;
      return worldToUnit(0, s * y, H).v;
    };
    expect(own(0)).toBeGreaterThan(0.5);
    expect(own(1)).toBeGreaterThan(0.5);
  });

  it("rotates rather than mirrors, so a Team1 player's left stays their left", () => {
    // A mirror (y only) would leave x alone and swap the player's sense of left and right; the
    // measured symmetry is a 180° rotation, which negates both.
    const marks = deathMarks([death(600, 4000, 3000)], H, teamSign(1));
    expect(marks[0].x).toBe(-4000);
    expect(marks[0].y).toBe(-3000);
  });
});

describe("landmarks", () => {
  const lms = landmarks(FRAME, H);

  it("places both teams' structures from one measured set", () => {
    // 2 cores + 2×3 tier-1 + 2×3 tier-2.
    expect(lms).toHaveLength(14);
    expect(lms.filter((l) => l.own)).toHaveLength(7);
  });

  it("puts the viewer's structures below the midline and the enemy's above", () => {
    for (const l of lms) {
      if (l.own) expect(l.y).toBeLessThan(0);
      else expect(l.y).toBeGreaterThan(0);
      // v is screen space: below the midline means a LARGER v.
      expect(l.own ? l.v > 0.5 : l.v < 0.5).toBe(true);
    }
  });

  it("negates the enemy's, so their left-lane structure mirrors the viewer's right", () => {
    // The map is 180°-rotation symmetric, not left-right mirrored: the enemy structure in the
    // viewer's LEFT corridor is the negation of the viewer's RIGHT-lane one.
    const ownRight = FRAME.tier1.find((t) => t.x > 3000)!;
    const enemyLeft = lms.find(
      (l) => !l.own && l.kind === "tier1" && l.side === "left",
    )!;
    expect(enemyLeft.x).toBe(-ownRight.x);
    expect(enemyLeft.side).toBe("left");
  });
});

describe("placeName", () => {
  const lms = landmarks(FRAME, H);

  it("names a structure when the point is at one", () => {
    const t1 = FRAME.tier1[0]; // lane 1, x ≈ −7970
    expect(placeName(t1.x + 200, t1.y - 150, lms)).toBe(
      "your tier-1 on the left",
    );
  });

  it("says whose it is, using the rotation for the enemy's", () => {
    const t2 = FRAME.tier2[2]; // own lane 4, x ≈ +5370
    expect(placeName(-t2.x, -t2.y, lms)).toBe("their tier-2 on the left");
  });

  it("calls the middle corridor mid rather than a side", () => {
    expect(placeName(FRAME.tier1[1].x, FRAME.tier1[1].y, lms)).toBe(
      "your tier-1 in mid",
    );
  });

  it("falls back to the display frame away from any structure", () => {
    // Deep in the enemy half on the right, but not at a structure.
    expect(placeName(8000, 7000, lms)).toBe("deep in their half on the right");
    expect(placeName(-8000, -6500, lms)).toBe(
      "deep in your own half on the left",
    );
  });

  it("describes the midline as the midline, not as a half", () => {
    expect(placeName(0, 100, lms)).toBe("around the midline");
    expect(placeName(8000, -200, lms)).toBe("around the midline on the right");
  });

  it("never reaches for geography the data can't locate", () => {
    const names = [
      placeName(0, 0, lms),
      placeName(8000, 7000, lms),
      placeName(-4000, -3000, lms),
      placeName(FRAME.core.x, FRAME.core.y, lms),
    ];
    for (const n of names)
      expect(n).not.toMatch(/jungle|river|flank|shop|high ground|jung/i);
  });
});

describe("depthRead", () => {
  const mark = (phase: number, y: number, i = 0): DeathMark => ({
    i,
    gameTimeS: phase * 600 + 60,
    phase,
    x: 0,
    y,
    u: 0.5,
    v: 0.5,
  });
  const norm = (enemyHalf: number) => ({ enemyHalf, n: 100000 });

  it("is null below a usable number of deaths", () => {
    expect(
      depthRead([mark(1, 5000), mark(1, 5000)], [null, norm(0.4), null, null]),
    ).toBeNull();
  });

  it("standardizes on the phases the player's deaths actually fell in", () => {
    // All six deaths are in the Late phase, where the population dies deep (70%). A player with
    // 4/6 forward is BELOW that, even though 67% would look reckless against a pooled 40%.
    const norms = [norm(0.1), norm(0.3), norm(0.5), norm(0.7)];
    const marks = [
      mark(3, 5000, 0),
      mark(3, 5000, 1),
      mark(3, 5000, 2),
      mark(3, 5000, 3),
      mark(3, -5000, 4),
      mark(3, -5000, 5),
    ];
    const r = depthRead(marks, norms)!;
    expect(r.observed).toBeCloseTo(4 / 6, 5);
    expect(r.expected).toBeCloseTo(0.7, 5);
    expect(r.real).toBe(false);
  });

  it("claims nothing when the gap is inside binomial noise", () => {
    // 7 of 10 against an expected 6 is one death's worth of difference.
    const norms = [norm(0.6), norm(0.6), norm(0.6), norm(0.6)];
    const marks = Array.from({ length: 10 }, (_, i) =>
      mark(1, i < 7 ? 5000 : -5000, i),
    );
    const r = depthRead(marks, norms)!;
    expect(r.real).toBe(false);
    expect(depthInsight(r)).toBeNull();
  });

  it("speaks when the gap clears it", () => {
    const norms = [norm(0.2), norm(0.2), norm(0.2), norm(0.2)];
    const marks = Array.from({ length: 12 }, (_, i) =>
      mark(2, i < 10 ? 5000 : -5000, i),
    );
    const r = depthRead(marks, norms)!;
    expect(r.real).toBe(true);
    const s = depthInsight(r)!;
    expect(s).toContain("10 of your 12");
    expect(s).toContain("further forward");
  });

  it("reads the other direction too", () => {
    const norms = [norm(0.8), norm(0.8), norm(0.8), norm(0.8)];
    const marks = Array.from({ length: 12 }, (_, i) =>
      mark(2, i < 2 ? 5000 : -5000, i),
    );
    expect(depthInsight(depthRead(marks, norms))).toContain("further back");
  });

  it("skips phases the bake has no population for", () => {
    // A thin bake can miss an arm; those deaths drop out rather than comparing against zero.
    const marks = [
      mark(0, 5000, 0),
      mark(0, 5000, 1),
      mark(3, 5000, 2),
      mark(3, 5000, 3),
      mark(3, 5000, 4),
      mark(3, -5000, 5),
    ];
    const r = depthRead(marks, [null, null, null, norm(0.5)])!;
    expect(r.total).toBe(4);
    expect(r.past).toBe(3);
  });
});

describe("timeDead", () => {
  it("totals reported durations", () => {
    expect(timeDead([death(100, 0, 0), death(200, 0, 0)])).toBe(60);
  });

  it("is null when nothing reported a duration", () => {
    expect(timeDead([death(100, 0, 0, { death_duration_s: null })])).toBeNull();
  });
});

describe("cellRect", () => {
  // The row-order contract, pinned. Mirror this and the density field still renders as a plausible
  // map — just flipped against the deaths drawn over it, which is exactly how it shipped wrong once.
  it("draws cell 0 at the top-left", () => {
    const r = cellRect(0, 64, 256);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });

  it("walks rows top-down, so the first row is the top of the map", () => {
    const size = 8;
    const box = 80;
    // Last cell of row 0 …
    expect(cellRect(size - 1, size, box).y).toBe(0);
    // … and first cell of row 1 sits one row LOWER on screen, not higher.
    expect(cellRect(size, size, box).y).toBe(box / size);
    expect(cellRect(size, size, box).x).toBe(0);
  });

  it("puts the last cell at the bottom-right", () => {
    const size = 8;
    const box = 80;
    const r = cellRect(size * size - 1, size, box);
    expect(r.x).toBe(box - box / size);
    expect(r.y).toBe(box - box / size);
  });

  it("overlaps neighbours slightly so the field has no seams", () => {
    expect(cellRect(0, 64, 256).w).toBeGreaterThan(256 / 64);
  });
});
