import { describe, expect, it } from "vitest";
import { editDistance, fuzzyScore, rankByFuzzy } from "./fuzzy";

const HEROES = [
  "Abrams",
  "Bebop",
  "Grey Talon",
  "Haze",
  "Seven",
  "Vindicta",
  "Viscous",
  "Wraith",
];
const top = (q: string) => rankByFuzzy(q, HEROES, (h) => h)[0];

describe("editDistance", () => {
  it("is 0 for identical strings and symmetric", () => {
    expect(editDistance("haze", "haze")).toBe(0);
    expect(editDistance("sevn", "seven")).toBe(editDistance("seven", "sevn"));
  });
  it("counts single edits", () => {
    expect(editDistance("sevn", "seve")).toBe(1); // substitution
    expect(editDistance("seven", "sevn")).toBe(1); // deletion
  });
});

describe("fuzzyScore / rankByFuzzy", () => {
  it("resolves a live prefix as you type", () => {
    expect(top("haz")).toBe("Haze");
    expect(top("vindi")).toBe("Vindicta");
    expect(top("vis")).toBe("Viscous");
  });

  it("matches a word prefix inside a multi-word name", () => {
    expect(top("tal")).toBe("Grey Talon");
  });

  it("tolerates a typo via edit distance", () => {
    expect(top("sevn")).toBe("Seven");
    expect(top("vindicat")).toBe("Vindicta");
  });

  it("resolves a subsequence of skipped letters", () => {
    expect(top("grytln")).toBe("Grey Talon");
  });

  it("prefers the shorter name when two share a prefix", () => {
    // "v" prefixes Vindicta and Viscous; ranking is stable and deterministic, shorter first.
    const ranked = rankByFuzzy("vi", HEROES, (h) => h);
    expect(ranked[0]).toBe("Viscous"); // 7 chars < Vindicta's 8
  });

  it("returns null / empty for a hopeless query", () => {
    expect(fuzzyScore("zzzzz", "Haze")).toBeNull();
    expect(rankByFuzzy("", HEROES, (h) => h)).toEqual([]);
  });
});
