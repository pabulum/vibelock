import { describe, expect, it } from 'vitest';
import type { HeroCounterRow } from '../types';
import { fitBradleyTerry, heroMatchups } from './matchups';

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

describe('fitBradleyTerry', () => {
  it('recovers relative strengths from a clean matrix', () => {
    const pi = fitBradleyTerry(makeMatrix({ 1: 1, 2: 1.5, 3: 0.8, 4: 1.2 }));
    // Ratios are what's identified; compare against hero 1.
    expect(pi.get(2)! / pi.get(1)!).toBeCloseTo(1.5, 1);
    expect(pi.get(3)! / pi.get(1)!).toBeCloseTo(0.8, 1);
  });
});

describe('heroMatchups with denoise', () => {
  // Hero 2 is simply strong (1.4×); hero 3 genuinely counters hero 1 by 4pts on equal strength.
  const matrix = makeMatrix({ 1: 1, 2: 1.4, 3: 1, 4: 1, 5: 1, 6: 1 }, { 3: -0.04 });

  it('raw mode flags the merely-strong hero as tough', () => {
    const raw = heroMatchups(matrix, 1, false);
    expect(raw.tough.map((m) => m.enemyHeroId)).toContain(2);
  });

  it('de-noised mode keeps the true counter and drops the merely-strong hero', () => {
    const dn = heroMatchups(matrix, 1, true);
    const toughIds = dn.tough.map((m) => m.enemyHeroId);
    expect(toughIds).toContain(3); // the genuine counter survives
    expect(toughIds).not.toContain(2); // "they're just meta" is explained away
    const vsStrong = [...dn.tough, ...dn.favorable].find((m) => m.enemyHeroId === 2);
    expect(vsStrong).toBeUndefined();
  });

  it('shrinks a floor-sample cell to ~no effect instead of flagging it', () => {
    // A dramatic 6pt "counter" backed by only 50 games: the strengths-are-right prior (K=300)
    // shrinks it to ~0.9pt, under the surfacing floor. It earns the flag around n≈60+.
    const thin = makeMatrix({ 1: 1, 2: 1, 3: 1 }, { 3: -0.06 }, 50);
    const dn = heroMatchups(thin, 1, true);
    expect(dn.tough.find((m) => m.enemyHeroId === 3)).toBeUndefined();
  });

  it('carries the strengths-only expectation for the tooltip', () => {
    const dn = heroMatchups(matrix, 1, true);
    const vs3 = dn.tough.find((m) => m.enemyHeroId === 3)!;
    expect(vs3.expectedWinRate).toBeCloseTo(0.5, 1);
    expect(vs3.winRate).toBeCloseTo(0.46, 2);
  });
});
