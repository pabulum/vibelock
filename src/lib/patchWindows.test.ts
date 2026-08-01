import { describe, expect, it } from "vitest";
import {
  hasSpan,
  moversWindowFor,
  priorWindowFor,
  windowFor,
} from "./patchWindows";
import { PRIOR_WINDOW_S } from "./patchBlend";
import type { Patch } from "../types";

const DAY = 86400;
// Newest first, as the patch feed is sorted.
const patches: Patch[] = [
  { title: "newest", ts: 1_000_000 },
  { title: "middle", ts: 1_000_000 - 10 * DAY },
  { title: "oldest", ts: 1_000_000 - 40 * DAY },
];

// The same list with a ranked season opening on the middle patch — the live 2026-07-30 shape.
const SEASON_TS = 1_000_000 - 10 * DAY;
const season = { name: "Beta Season 1", startTs: SEASON_TS };
const seasoned: Patch[] = [
  { ...patches[0], season },
  { ...patches[1], season },
  patches[2],
];

describe("windowFor", () => {
  it("runs the newest patch open-ended and closes older ones at the next patch", () => {
    expect(windowFor(patches, 0)).toEqual({
      minUnixTimestamp: 1_000_000,
      maxUnixTimestamp: undefined,
    });
    expect(windowFor(patches, 1)).toEqual({
      minUnixTimestamp: 1_000_000 - 10 * DAY,
      maxUnixTimestamp: 1_000_000,
    });
    expect(windowFor(patches, 9)).toEqual({});
  });
});

describe("priorWindowFor", () => {
  it("is the fixed 30-day borrow window before the patch", () => {
    expect(priorWindowFor(patches, 0)).toEqual({
      minUnixTimestamp: 1_000_000 - PRIOR_WINDOW_S,
      maxUnixTimestamp: 1_000_000,
    });
  });

  it("never borrows across a ranked reset", () => {
    // The 30 days before this patch reach 20 days past the season start, where average_badge meant
    // something else — borrowing there would blend two different populations.
    expect(priorWindowFor(seasoned, 0)).toEqual({
      minUnixTimestamp: SEASON_TS,
      maxUnixTimestamp: 1_000_000,
    });
  });

  it("collapses on the boundary itself, where there is nothing admissible to borrow", () => {
    const w = priorWindowFor(seasoned, 1);
    expect(w).toEqual({
      minUnixTimestamp: SEASON_TS,
      maxUnixTimestamp: SEASON_TS,
    });
    // The caller reads this, not the timestamps, to switch backfill off (see App).
    expect(hasSpan(w)).toBe(false);
  });
});

describe("hasSpan", () => {
  it("rejects the two windows that would silently answer the wrong question", () => {
    expect(hasSpan({})).toBe(false); // = the API's default last 30 days
    expect(hasSpan({ minUnixTimestamp: 5, maxUnixTimestamp: 5 })).toBe(false);
    expect(hasSpan({ minUnixTimestamp: 5, maxUnixTimestamp: 6 })).toBe(true);
    expect(hasSpan({ minUnixTimestamp: 5 })).toBe(true); // open-ended: runs to now
  });
});

describe("moversWindowFor", () => {
  it("mirrors how long the running patch has been out", () => {
    const now = 1_000_000 + 2 * DAY;
    expect(moversWindowFor(patches, 0, now)).toEqual({
      minUnixTimestamp: 1_000_000 - 2 * DAY,
      maxUnixTimestamp: 1_000_000,
    });
  });

  it("grows with the patch, keeping the two sides equal", () => {
    const day1 = moversWindowFor(patches, 0, 1_000_000 + DAY);
    const day5 = moversWindowFor(patches, 0, 1_000_000 + 5 * DAY);
    const span = (w: {
      minUnixTimestamp?: number;
      maxUnixTimestamp?: number;
    }) => w.maxUnixTimestamp! - w.minUnixTimestamp!;
    expect(span(day1)).toBe(DAY);
    expect(span(day5)).toBe(5 * DAY);
  });

  it("mirrors a finished patch's own length, not the clock", () => {
    // The middle patch ran 10 days; "now" is irrelevant to it.
    expect(moversWindowFor(patches, 1, 9_999_999)).toEqual({
      minUnixTimestamp: 1_000_000 - 20 * DAY,
      maxUnixTimestamp: 1_000_000 - 10 * DAY,
    });
  });

  it("caps at the borrow window so a long patch doesn't reach back into ancient drift", () => {
    const w = moversWindowFor(patches, 0, 1_000_000 + 120 * DAY);
    expect(w.maxUnixTimestamp! - w.minUnixTimestamp!).toBe(PRIOR_WINDOW_S);
  });

  it("stops the comparator at a ranked reset even when that costs the two sides equal length", () => {
    // 12 days into the patch, but only 10 days of same-ladder history behind it. The alternative —
    // comparing against pre-reset data — would price the reset as an item mover.
    expect(moversWindowFor(seasoned, 0, 1_000_000 + 12 * DAY)).toEqual({
      minUnixTimestamp: SEASON_TS,
      maxUnixTimestamp: 1_000_000,
    });
    // ...and nothing at all to compare against on the boundary patch.
    expect(hasSpan(moversWindowFor(seasoned, 1, 9_999_999))).toBe(false);
  });

  it("degenerates to an empty window at the moment of the patch, never to a windowless query", () => {
    // A windowless {} would silently mean "the API's default last 30 days" — the exact comparator
    // this function exists to avoid.
    expect(moversWindowFor(patches, 0, 1_000_000)).toEqual({
      minUnixTimestamp: 1_000_000,
      maxUnixTimestamp: 1_000_000,
    });
    expect(moversWindowFor(patches, 9, 1_000_000)).toEqual({});
  });
});
