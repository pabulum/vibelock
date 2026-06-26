import { describe, expect, it } from 'vitest';
import { RANK_TIERS, rankFloorLabel, tierToMinBadge } from './ranks';

describe('tierToMinBadge', () => {
  it('encodes a tier as average_badge tier*10 (subtier I)', () => {
    expect(tierToMinBadge(0)).toBe(0);
    expect(tierToMinBadge(7)).toBe(70);
    expect(tierToMinBadge(11)).toBe(110); // Eternus floor
  });
});

describe('rankFloorLabel', () => {
  it('appends "+" to every tier below the top (it is a floor)', () => {
    expect(rankFloorLabel(0)).toBe('Obscurus+');
    expect(rankFloorLabel(7)).toBe('Archon+');
    expect(rankFloorLabel(10)).toBe('Ascendant+');
  });

  it('drops the "+" at Eternus, the top tier (nothing above it)', () => {
    expect(rankFloorLabel(11)).toBe('Eternus');
  });

  it('falls back to a generic label for an unknown tier', () => {
    expect(rankFloorLabel(99)).toBe('Tier 99');
  });

  it('has a label for every tier in RANK_TIERS', () => {
    for (const t of RANK_TIERS) {
      expect(rankFloorLabel(t.tier)).toContain(t.name);
    }
  });
});
