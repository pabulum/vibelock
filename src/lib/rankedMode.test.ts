import { describe, expect, it } from "vitest";
import { RANKED_MODE_FROM_S, rankedOnlyUsable } from "./rankedMode";

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
