import { describe, expect, it } from "vitest";
import {
  RANK_TIERS,
  badgeLabel,
  highestPopulatedFloor,
  rankFloorLabel,
  tierToMinBadge,
} from "./ranks";

/** Build a distribution from tier→matches, spread across that tier's subranks. */
const dist = (byTier: Record<number, number>) =>
  Object.entries(byTier).flatMap(([tier, matches]) =>
    [1, 2, 3, 4, 5, 6].map((sub) => ({
      badge_level: Number(tier) * 10 + sub,
      total_matches: matches / 6,
    })),
  );

describe("badgeLabel", () => {
  it("splits a per-match badge into its tier and subrank", () => {
    expect(badgeLabel(92)).toBe("Phantom II"); // observed live on a ranked account
    expect(badgeLabel(85)).toBe("Oracle V");
    expect(badgeLabel(116)).toBe("Eternus VI"); // the API's documented ceiling
  });

  it("names the bare tier when there is no subrank", () => {
    // Badge 0 is what the API reports for an account with no ranked result yet.
    expect(badgeLabel(0)).toBe("Obscurus");
    expect(badgeLabel(90)).toBe("Phantom");
  });
});

describe("tierToMinBadge", () => {
  it("encodes a tier as average_badge tier*10 (subtier I)", () => {
    expect(tierToMinBadge(0)).toBe(0);
    expect(tierToMinBadge(7)).toBe(70);
    expect(tierToMinBadge(11)).toBe(110); // Eternus floor
  });
});

describe("rankFloorLabel", () => {
  it('appends "+" to every tier below the top (it is a floor)', () => {
    expect(rankFloorLabel(0)).toBe("Obscurus+");
    // Tier 7 was "Archon+" until the 2026-07-30 rank rename moved Emissary up a slot.
    expect(rankFloorLabel(7)).toBe("Emissary+");
    expect(rankFloorLabel(10)).toBe("Ascendant+");
  });

  it("carries the post-2026-07-30 names, which shifted against their tier numbers", () => {
    // Guards the rename itself: three names were replaced and two moved up a tier. Getting this
    // wrong mislabels every rank slice in the UI while the queries silently stay correct.
    expect(RANK_TIERS.map((t) => t.name)).toEqual([
      "Obscurus",
      "Initiate",
      "Seeker",
      "Acolyte",
      "Sentinel",
      "Mystic",
      "Ritualist",
      "Emissary",
      "Oracle",
      "Phantom",
      "Ascendant",
      "Eternus",
    ]);
  });

  it('drops the "+" at Eternus, the top tier (nothing above it)', () => {
    expect(rankFloorLabel(11)).toBe("Eternus");
  });

  it("falls back to a generic label for an unknown tier", () => {
    expect(rankFloorLabel(99)).toBe("Tier 99");
  });

  it("has a label for every tier in RANK_TIERS", () => {
    for (const t of RANK_TIERS) {
      expect(rankFloorLabel(t.tier)).toContain(t.name);
    }
  });
});

describe("highestPopulatedFloor", () => {
  it("keeps the top of the ladder when it has data, even though it is always thin", () => {
    // A normal week: Eternus is only ~3% of matches and is still the right default. A stricter
    // bar would drag the default down the ladder for no reason.
    const rows = dist({
      11: 310,
      10: 810,
      9: 700,
      8: 1370,
      7: 1180,
      6: 1270,
      5: 4360,
    });
    expect(highestPopulatedFloor(rows)).toBe(11);
  });

  it("walks down past tiers that are genuinely empty", () => {
    // The 2026-07-30 ranked reset: calibration capped everyone at Oracle VI, so 9/10/11 held zero
    // matches while the app still defaulted to Eternus and rendered a build over nothing.
    const rows = dist({
      8: 3323,
      7: 1301,
      6: 1061,
      5: 985,
      4: 764,
      3: 659,
      2: 656,
      1: 451,
    });
    expect(highestPopulatedFloor(rows)).toBe(8);
  });

  it("counts the floor cumulatively, not that tier alone", () => {
    // 10k matches: tier 11 holds 0.9% (just under the bar), tier 10 only 0.2% on its own. A floor
    // of 10 queries badge >= 100, so it inherits tier 11's matches too and clears at 1.1% — which
    // it could never do tier-alone. That inheritance is the whole reason a floor is the right unit.
    const rows = dist({ 11: 90, 10: 20, 5: 9890 });
    expect(highestPopulatedFloor(rows)).toBe(10);
    // Raise the bar past what 10 and 11 hold together and it keeps walking down.
    expect(highestPopulatedFloor(rows, 0.02)).toBe(5);
  });

  it("returns null for an empty window so the caller keeps its own fallback", () => {
    expect(highestPopulatedFloor([])).toBeNull();
    expect(highestPopulatedFloor(dist({ 8: 0 }))).toBeNull();
  });

  it("never invents a tier above the ladder", () => {
    const rows = dist({ 1: 1000 });
    expect(highestPopulatedFloor(rows)).toBe(1);
  });
});
