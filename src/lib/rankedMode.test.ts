import { describe, expect, it } from "vitest";
import { RANKED_MODE_FROM_S, rankedOnlyUsable } from "./rankedMode";
import { BADGE_OUTAGE_FROM_S, rankFilterUsable } from "./badgeOutage";

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;

describe("rankedOnlyUsable", () => {
  it("allows Ranked scoping for a window inside the current ranked era", () => {
    expect(rankedOnlyUsable({ minUnixTimestamp: day("2026-08-01") })).toBe(
      true,
    );
    expect(rankedOnlyUsable({ minUnixTimestamp: RANKED_MODE_FROM_S })).toBe(
      true,
    );
  });

  it("refuses it for a window that predates the mode", () => {
    // Ranked did not exist between 2024-11-22 and the 2026-07-30 update; scoping a window there
    // returns nothing at all, which would blank every historical patch.
    expect(rankedOnlyUsable({ minUnixTimestamp: day("2026-07-20") })).toBe(
      false,
    );
    expect(rankedOnlyUsable({ minUnixTimestamp: RANKED_MODE_FROM_S - 1 })).toBe(
      false,
    );
  });

  it("refuses it for an open-ended window, which reaches back indefinitely", () => {
    expect(rankedOnlyUsable({})).toBe(false);
  });
});

describe("rankFilterUsable", () => {
  it("keeps the rank filter for a window that ends before the outage", () => {
    expect(rankFilterUsable({ maxUnixTimestamp: day("2026-07-20") })).toBe(
      true,
    );
    expect(rankFilterUsable({ maxUnixTimestamp: BADGE_OUTAGE_FROM_S })).toBe(
      true,
    );
  });

  it("drops it for a window that merely touches the outage", () => {
    // A straddling window is the subtle case: the filter still returns rows, but only pre-outage
    // ones, so it would answer for a shorter period than was asked about.
    expect(
      rankFilterUsable({ maxUnixTimestamp: BADGE_OUTAGE_FROM_S + 1 }),
    ).toBe(false);
    expect(rankFilterUsable({ maxUnixTimestamp: day("2026-08-02") })).toBe(
      false,
    );
  });

  it("drops it for an open-ended window, which runs to now", () => {
    expect(rankFilterUsable({})).toBe(false);
  });
});

describe("the two guards together", () => {
  it("are complementary on today's windows: current patch ranked-but-rankless", () => {
    const currentPatch = {
      minUnixTimestamp: RANKED_MODE_FROM_S,
      maxUnixTimestamp: undefined,
    };
    expect(rankedOnlyUsable(currentPatch)).toBe(true);
    expect(rankFilterUsable(currentPatch)).toBe(false);
  });

  it("...and an older patch rank-filterable but not ranked-scoped", () => {
    const oldPatch = {
      minUnixTimestamp: day("2026-07-13"),
      maxUnixTimestamp: day("2026-07-27"),
    };
    expect(rankedOnlyUsable(oldPatch)).toBe(false);
    expect(rankFilterUsable(oldPatch)).toBe(true);
  });
});
