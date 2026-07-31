import { describe, expect, it } from "vitest";
import {
  FLOW_PHASE_COUNT,
  FLOW_PHASE_INTERVAL_S,
  PHASE_END_S,
  PHASE_LABELS,
  PHASE_TIME_LABELS,
  bucketForTime,
  phaseForTime,
} from "./phases";

describe("phase geometry", () => {
  it("keeps phase_count equal to the number of labels", () => {
    // The generator indexes flow columns by position, so a mismatch here would silently drop a
    // phase (count < labels) or leave one permanently empty (count > labels).
    expect(FLOW_PHASE_COUNT).toBe(PHASE_LABELS.length);
    expect(PHASE_END_S).toHaveLength(PHASE_LABELS.length);
    expect(PHASE_TIME_LABELS).toHaveLength(PHASE_LABELS.length);
  });

  it("derives labels from the interval actually sent to the API", () => {
    // These read "0–9 min" while the API sliced 0–600s, which is the bug this module exists to
    // prevent. Assert the derivation, not the strings, so retuning the interval stays honest.
    expect(PHASE_TIME_LABELS).toEqual([
      "0–10 min",
      "10–20 min",
      "20–30 min",
      "30+ min",
    ]);
    expect(PHASE_TIME_LABELS[0]).toContain(String(FLOW_PHASE_INTERVAL_S / 60));
  });

  it("ends each phase on its column boundary, with the last open-ended", () => {
    expect(PHASE_END_S.slice(0, -1)).toEqual([600, 1200, 1800]);
    expect(PHASE_END_S.at(-1)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("bucketForTime", () => {
  it("puts a purchase in the column the API would have put it in", () => {
    expect(bucketForTime(0)).toBe(0);
    expect(bucketForTime(599)).toBe(0);
    // The disputed minute: 9:00–10:00 is still the Lane column, which the old 540s bound got wrong.
    expect(bucketForTime(540)).toBe(0);
    expect(bucketForTime(600)).toBe(1);
    expect(bucketForTime(1200)).toBe(2);
    expect(bucketForTime(1800)).toBe(3);
  });

  it("clamps a very late purchase into the open-ended last column", () => {
    expect(bucketForTime(60 * 60 * 3)).toBe(PHASE_LABELS.length - 1);
  });

  it("never returns a negative column for a nonsensical time", () => {
    expect(bucketForTime(-1)).toBe(0);
  });

  it("names the phase it buckets into", () => {
    expect(phaseForTime(0)).toBe("Lane");
    expect(phaseForTime(540)).toBe("Lane");
    expect(phaseForTime(601)).toBe("Early mid");
    expect(phaseForTime(9999)).toBe("Late");
  });
});
