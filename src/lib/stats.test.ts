import { describe, expect, it } from 'vitest';
import {
  GATE_Z,
  benjaminiHochberg,
  normalCdf,
  significantlyHigher,
  winRateSE,
} from './stats';

describe('winRateSE', () => {
  it('is the binomial standard error √(p(1−p)/n)', () => {
    expect(winRateSE(0.5, 100)).toBeCloseTo(0.05, 12); // √(0.25/100)
    expect(winRateSE(0.4, 600)).toBeCloseTo(Math.sqrt((0.4 * 0.6) / 600), 12);
  });

  it('is zero at the degenerate rates 0 and 1 (no variance)', () => {
    expect(winRateSE(0, 100)).toBe(0);
    expect(winRateSE(1, 100)).toBe(0);
  });

  it('returns Infinity for an empty or invalid sample, so it never reads as certain', () => {
    expect(winRateSE(0.5, 0)).toBe(Infinity);
    expect(winRateSE(0.5, -10)).toBe(Infinity);
  });

  it('shrinks toward zero as the sample grows', () => {
    expect(winRateSE(0.5, 10000)).toBeLessThan(winRateSE(0.5, 100));
  });
});

describe('significantlyHigher', () => {
  it('fails when the point estimate does not clear the effect-size margin', () => {
    // 0.52 vs 0.51 with a 0.02 margin: 0.52 < 0.51 + 0.02, so it fails before any noise test.
    expect(significantlyHigher(0.52, 1_000_000, 0.51, Infinity, 0.02)).toBe(false);
  });

  it('fails a real-looking gap on a thin sample (could be noise)', () => {
    // +5pp over baseline but only 10 games — nowhere near GATE_Z sampling errors wide.
    expect(significantlyHigher(0.55, 10, 0.5, Infinity)).toBe(false);
  });

  it('passes the same gap once the sample is large enough', () => {
    expect(significantlyHigher(0.55, 10_000, 0.5, Infinity)).toBe(true);
  });

  it('treats a degenerate-variance edge (SE 0) as decided by the effect-size pass', () => {
    expect(significantlyHigher(1, 100, 0.5, Infinity)).toBe(true);
  });

  it('accounts for the reference sample noise when nb is finite', () => {
    // A tiny reference sample adds enough noise to sink a gap that clears against a fixed baseline.
    expect(significantlyHigher(0.6, 200, 0.5, Infinity)).toBe(true);
    expect(significantlyHigher(0.6, 200, 0.5, 8)).toBe(false);
  });

  it('sits right at the GATE_Z boundary', () => {
    // Construct a gap of exactly GATE_Z standard errors: a=b+GATE_Z·SE(a,na), nb=Infinity.
    const b = 0.5;
    const na = 10_000;
    const se = winRateSE(0.5, na); // approx SE near the boundary
    const a = b + GATE_Z * se;
    expect(significantlyHigher(a, na, b, Infinity)).toBe(true);
    // Nudge just below the bar and it must fail.
    expect(significantlyHigher(a - 1e-4, na, b, Infinity)).toBe(false);
  });
});

describe('normalCdf', () => {
  it('is 0.5 at zero', () => {
    // The erf is a rational approximation accurate to ~1.5e-7, so we don't ask for more digits than that.
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
  });

  it('matches standard normal table values', () => {
    expect(normalCdf(1.645)).toBeCloseTo(0.95, 4);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1)).toBeCloseTo(0.1587, 4);
    expect(normalCdf(GATE_Z)).toBeCloseTo(0.8997, 4); // GATE_Z = 1.28 ⇒ ~90% one-sided
  });

  it('is symmetric: Φ(z) + Φ(−z) = 1', () => {
    for (const z of [0.3, 1, 2.5]) {
      expect(normalCdf(z) + normalCdf(-z)).toBeCloseTo(1, 6);
    }
  });
});

describe('benjaminiHochberg', () => {
  it('returns an empty array for no tests', () => {
    expect(benjaminiHochberg([], 0.05)).toEqual([]);
  });

  it('rejects everything when all p-values are large', () => {
    expect(benjaminiHochberg([0.5, 0.6, 0.7], 0.05)).toEqual([false, false, false]);
  });

  it('accepts up to the largest rank passing (k/m)·q', () => {
    // m=5, q=0.05 ⇒ thresholds 0.01,0.02,0.03,0.04,0.05. 0.13 fails its rank-5 bar (0.05),
    // so the cutoff is rank 4 and the first four are accepted.
    expect(benjaminiHochberg([0.005, 0.011, 0.02, 0.04, 0.13], 0.05)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it('aligns the accept flags to the input order, not the sorted order', () => {
    // Same five p-values, shuffled: the 0.13 (index 2) is the only rejection.
    expect(benjaminiHochberg([0.04, 0.005, 0.13, 0.011, 0.02], 0.05)).toEqual([
      true,
      true,
      false,
      true,
      true,
    ]);
  });

  it('gets stricter as the number of tests grows (multiple-comparisons control)', () => {
    // A lone p=0.03 is significant at q=0.05; buried among many large p-values it is not.
    expect(benjaminiHochberg([0.03], 0.05)).toEqual([true]);
    const many = [0.03, ...Array.from({ length: 99 }, () => 0.9)];
    expect(benjaminiHochberg(many, 0.05)[0]).toBe(false);
  });
});
