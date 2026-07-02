import { describe, expect, it } from 'vitest';
import type { MetricDistribution } from '../types';
import { fundamentalsRows, percentileOf } from './fundamentals';

const dist = (scale = 1): MetricDistribution => ({
  avg: 50 * scale,
  std: 20 * scale,
  percentile1: 10 * scale,
  percentile5: 20 * scale,
  percentile10: 25 * scale,
  percentile25: 35 * scale,
  percentile50: 50 * scale,
  percentile75: 65 * scale,
  percentile90: 80 * scale,
  percentile95: 90 * scale,
  percentile99: 110 * scale,
});

describe('percentileOf', () => {
  it('hits the grid points exactly', () => {
    expect(percentileOf(50, dist())).toBe(50);
    expect(percentileOf(80, dist())).toBe(90);
  });

  it('interpolates linearly between grid points', () => {
    // Halfway between p50 (50) and p75 (65) is 57.5 ⇒ percentile 62.5.
    expect(percentileOf(57.5, dist())).toBeCloseTo(62.5, 6);
  });

  it('clamps at the resolvable edges', () => {
    expect(percentileOf(-5, dist())).toBe(1);
    expect(percentileOf(1e9, dist())).toBe(99);
  });
});

describe('fundamentalsRows', () => {
  it('places the player on the ladder and inverts better-low metrics', () => {
    const ladder = {
      net_worth_per_min: dist(10),
      deaths: dist(0.1),
    };
    const player = {
      net_worth_per_min: { ...dist(10), avg: 650 }, // = ladder p75
      deaths: { ...dist(0.1), avg: 6.5 }, // p75 of deaths ⇒ goodness 25
    };
    const rows = fundamentalsRows(player, ladder);
    const souls = rows.find((r) => r.key === 'net_worth_per_min')!;
    const deaths = rows.find((r) => r.key === 'deaths')!;
    expect(souls.percentile).toBe(75);
    expect(deaths.percentile).toBe(25);
    expect(deaths.value).toBe('6.5');
    expect(souls.ladderMedian).toBe('500');
  });

  it('skips metrics missing on either side and degenerate ladder slices', () => {
    const flat = { ...dist(), percentile1: 5, percentile99: 5 };
    expect(fundamentalsRows({ deaths: dist() }, {})).toEqual([]);
    expect(fundamentalsRows({ deaths: dist() }, { deaths: flat })).toEqual([]);
  });
});
