import { describe, expect, it } from "vitest";
import { buildJointGamesLookup } from "./pairs";
import type { ItemPermutationStats } from "../types";

const row = (
  ids: [number, number],
  wins: number,
  losses: number,
): ItemPermutationStats => ({
  item_ids: ids,
  wins,
  losses,
  matches: wins + losses,
});

describe("buildJointGamesLookup", () => {
  it("sums the two orderings of a pair into one unordered joint count", () => {
    // The endpoint reports a pair once per buy order; the orders partition the games.
    const lookup = buildJointGamesLookup([
      row([1, 2], 30, 20),
      row([2, 1], 10, 40),
    ]);
    expect(lookup(1, 2)).toBe(100);
  });

  it("is symmetric in its arguments", () => {
    const lookup = buildJointGamesLookup([row([3, 7], 5, 5)]);
    expect(lookup(7, 3)).toBe(lookup(3, 7));
  });

  it("returns 0 for pairs the endpoint didn't report", () => {
    const lookup = buildJointGamesLookup([row([1, 2], 1, 1)]);
    expect(lookup(1, 99)).toBe(0);
  });

  it("ignores non-pair rows", () => {
    const triple = {
      item_ids: [1, 2, 3],
      wins: 9,
      losses: 9,
      matches: 18,
    } as unknown as ItemPermutationStats;
    const lookup = buildJointGamesLookup([triple]);
    expect(lookup(1, 2)).toBe(0);
  });
});
