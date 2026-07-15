import { describe, expect, it } from "vitest";
import type { HeroCounterRow } from "../types";
import { heroMatchups } from "./matchups";

/** Build the full symmetric matrix for heroes with given true strengths π and optional per-pair
 * counter effects (added to hero 1's win rate vs that enemy). Big n so sampling noise ≈ 0. */
function makeMatrix(
  strengths: Record<number, number>,
  counterVs1: Record<number, number> = {},
  n = 100000,
): HeroCounterRow[] {
  const ids = Object.keys(strengths).map(Number);
  const rows: HeroCounterRow[] = [];
  for (const i of ids)
    for (const j of ids) {
      if (i === j) continue;
      let p = strengths[i] / (strengths[i] + strengths[j]);
      if (i === 1 && counterVs1[j]) p += counterVs1[j];
      if (j === 1 && counterVs1[i]) p -= counterVs1[i];
      rows.push({
        hero_id: i,
        enemy_hero_id: j,
        wins: Math.round(n * p),
        matches_played: n,
        last_hits: 150 * n,
        enemy_last_hits: 150 * n,
      });
    }
  return rows;
}

describe("heroMatchups", () => {
  // Hero 2 is stronger than hero 1 (below baseline ⇒ tough); hero 3 is weaker (above ⇒ favored).
  const matrix = makeMatrix({ 1: 1, 2: 1.5, 3: 0.6, 4: 1, 5: 1 });

  it("splits enemies into tough (below baseline) and favored (above)", () => {
    const m = heroMatchups(matrix, 1);
    expect(m.tough.map((x) => x.enemyHeroId)).toContain(2);
    expect(m.favorable.map((x) => x.enemyHeroId)).toContain(3);
    // Deltas are measured against hero 1's own overall win rate.
    expect(m.tough.find((x) => x.enemyHeroId === 2)!.delta).toBeLessThan(0);
    expect(m.favorable.find((x) => x.enemyHeroId === 3)!.delta).toBeGreaterThan(
      0,
    );
  });

  it("drops cells thinner than the sample floor", () => {
    const thin = makeMatrix({ 1: 1, 2: 1.5, 3: 0.6 }, {}, 100);
    const m = heroMatchups(thin, 1);
    expect(m.tough).toHaveLength(0);
    expect(m.favorable).toHaveLength(0);
  });
});
