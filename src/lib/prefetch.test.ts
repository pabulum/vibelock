import { describe, expect, it } from "vitest";
import { counterSliceQueries, type DataSlice } from "./prefetch";

// A prefetch only pays off if it resolves the *same* URL the real query asks for — the analytics
// layer is keyed by URL, so a near-miss is invisible and just does the work twice. These pin the
// query shape that features/useCounters and the build fan-out both read through this helper.
const SLICE: DataSlice = {
  minBadge: 110,
  dataWindow: { minUnixTimestamp: 2000, maxUnixTimestamp: 3000 },
  priorWin: { minUnixTimestamp: 1000, maxUnixTimestamp: 2000 },
  canBackfill: true,
};

describe("counterSliceQueries", () => {
  it("asks for both windows with backfill on, dropping the floor on the fresh one", () => {
    expect(counterSliceQueries(7, SLICE)).toEqual([
      {
        heroId: 7,
        minBadge: 110,
        maxBadge: undefined,
        enemyHeroIds: undefined,
        minUnixTimestamp: 2000,
        maxUnixTimestamp: 3000,
        minMatches: 5,
      },
      {
        heroId: 7,
        minBadge: 110,
        maxBadge: undefined,
        enemyHeroIds: undefined,
        minUnixTimestamp: 1000,
        maxUnixTimestamp: 2000,
      },
    ]);
  });

  it("is the selected window alone, at the endpoint's own floor, with backfill off", () => {
    const qs = counterSliceQueries(7, { ...SLICE, canBackfill: false });
    expect(qs).toHaveLength(1);
    expect(qs[0]).not.toHaveProperty("minMatches");
    expect(qs[0].minUnixTimestamp).toBe(2000);
  });

  it("differs from the base slice only by the enemy filter", () => {
    const [base] = counterSliceQueries(7, SLICE);
    const [vs] = counterSliceQueries(7, SLICE, [12]);
    expect(vs).toEqual({ ...base, enemyHeroIds: [12] });
  });

  it("carries a rank band's ceiling through", () => {
    const [q] = counterSliceQueries(7, { ...SLICE, maxBadge: 116 });
    expect(q.maxBadge).toBe(116);
  });
});
