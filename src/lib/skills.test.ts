import { describe, expect, it } from 'vitest';
import type { AbilityOrderRow } from '../types';
import { bestSkillBuild, maxOrder } from './skills';

const G = 10, B = 20, I = 30, S = 40; // grenade, beam, ice, shelter

function row(abilities: number[], players: number): AbilityOrderRow {
  return { abilities, wins: 0, losses: 0, players, matches: 0 };
}

describe('bestSkillBuild', () => {
  it('returns null when no row carries an order', () => {
    expect(bestSkillBuild([])).toBeNull();
    expect(bestSkillBuild([row([], 100)])).toBeNull();
  });

  it('recommends the most-common order and reports its sample (no win rate)', () => {
    const popular = row([G, B, I, S, G, B], 1000);
    const build = bestSkillBuild([popular, row([G, I, S, B], 300)]);
    expect(build?.order).toEqual(popular.abilities);
    expect(build?.sample).toBe(1000);
    expect(build?.lowSample).toBe(false);
  });

  it('flags a thin standard when even the most-common order is below the floor', () => {
    const build = bestSkillBuild([row([G, B], 30), row([G, I], 12)]);
    expect(build?.order).toEqual([G, B]); // most common, even if thin
    expect(build?.lowSample).toBe(true);
  });
});

describe('maxOrder', () => {
  it('orders abilities by when they receive their last point (maxed first → first)', () => {
    // OTHER's last point at index 5, BEAM's at index 6 → OTHER maxed first.
    expect(maxOrder([B, I, B, I, B, I, B])).toEqual([I, B]);
  });
});
