import { describe, expect, it } from 'vitest';
import type { FlowNode, FlowSummary, ItemFlowStats } from '../types';
import {
  PATCH_K_DEFAULT,
  PATCH_K_MAX,
  blendFlow,
  estimatePatchK,
} from './patchBlend';

function summary(wins: number, losses: number): FlowSummary {
  const matches = Math.round(wins + losses);
  return {
    matches,
    players: matches,
    wins,
    losses,
    avg_duration_s: 1800,
    avg_net_worth: 20000,
  };
}

function node(p: Partial<FlowNode> & { item_id: number }): FlowNode {
  return {
    column: 0,
    wins: 0,
    losses: 0,
    players: 0,
    matches: 0,
    adjusted_win_rate: 0.5,
    avg_net_worth_at_buy: 1000,
    total_kills: 0,
    total_deaths: 0,
    total_assists: 0,
    ...p,
  };
}

function flow(
  nodes: FlowNode[],
  reached: number[],
  baseWins: number,
  baseLosses: number,
): ItemFlowStats {
  return {
    nodes,
    edges: [],
    summary: summary(baseWins, baseLosses),
    baseline: summary(baseWins, baseLosses),
    reached_per_column: reached,
  };
}

// A day-one fresh window: one item with 10 decided games. Prior: same item, 5000 games. With a
// single overlapping node the drift fit can't run (< DRIFT_MIN_PAIRS), so K = PATCH_K_DEFAULT.
const freshThin = flow(
  [node({ item_id: 7, wins: 5, losses: 5, players: 10, matches: 10, adjusted_win_rate: 0.48 })],
  [500],
  250,
  250,
);
const priorBig = flow(
  [node({ item_id: 7, wins: 2750, losses: 2250, players: 5000, matches: 5000, adjusted_win_rate: 0.55 })],
  [50000],
  25000,
  25000,
);

describe('blendFlow', () => {
  it('on day one the prior dominates: blended rate sits near the pre-patch rate', () => {
    const { flow: f, borrowedShare } = blendFlow(freshThin, priorBig);
    const n = f.nodes.find((x) => x.item_id === 7)!;
    // ~10 fresh games vs ~950 borrowed (K=1000 minus a small agreement discount).
    expect(n.adjusted_win_rate).toBeGreaterThan(0.54);
    expect(n.adjusted_win_rate).toBeLessThan(0.55);
    expect(borrowedShare).toBeGreaterThan(0.9);
  });

  it('caps borrowing at K: effective decided games ≤ fresh n + K', () => {
    const { flow: f } = blendFlow(freshThin, priorBig);
    const n = f.nodes.find((x) => x.item_id === 7)!;
    expect(n.wins + n.losses).toBeLessThanOrEqual(10 + PATCH_K_DEFAULT);
    expect(n.wins + n.losses).toBeGreaterThan(10); // ...but it did borrow
  });

  it('anneals: with a mature fresh window the fresh data dominates', () => {
    const freshMature = flow(
      [node({ item_id: 7, wins: 24000, losses: 26000, players: 50000, matches: 50000, adjusted_win_rate: 0.48 })],
      [200000],
      100000,
      100000,
    );
    const { flow: f, borrowedShare } = blendFlow(freshMature, priorBig);
    const n = f.nodes.find((x) => x.item_id === 7)!;
    expect(n.adjusted_win_rate).toBeLessThan(0.485);
    expect(borrowedShare).toBeLessThan(0.05);
  });

  it('discounts a contradicted prior: an item the patch visibly changed borrows far less', () => {
    // Fresh disagrees hard (0.40 over 2000 games vs prior 0.55): z ≈ 11 ⇒ discount ≈ 3%.
    const freshChanged = flow(
      [node({ item_id: 7, wins: 800, losses: 1200, players: 2000, matches: 2000, adjusted_win_rate: 0.4 })],
      [8000],
      4000,
      4000,
    );
    const { flow: f } = blendFlow(freshChanged, priorBig);
    const n = f.nodes.find((x) => x.item_id === 7)!;
    // An undiscounted K=1000 borrow would land ≈ (2000·0.40 + 1000·0.55)/3000 = 0.45.
    expect(n.adjusted_win_rate).toBeLessThan(0.41);
    expect(n.wins + n.losses).toBeLessThan(2000 + 100);
  });

  it('keeps prior-only items alive with the column-β pick-rate borrow', () => {
    const priorTwoItems = flow(
      [
        node({ item_id: 7, wins: 2750, losses: 2250, players: 5000, matches: 5000, adjusted_win_rate: 0.55 }),
        node({ item_id: 9, wins: 10500, losses: 9500, players: 20000, matches: 20000, adjusted_win_rate: 0.52 }),
      ],
      [50000],
      25000,
      25000,
    );
    const { flow: f } = blendFlow(freshThin, priorTwoItems);
    const ghost = f.nodes.find((x) => x.item_id === 9)!;
    // β = min(1, K/reachedPrior) = 1000/50000 = 0.02 ⇒ 20000 players scale to 400,
    // reached = 500 + 0.02·50000 = 1500 — same denominator for every item in the column.
    expect(ghost.players).toBe(400);
    expect(f.reached_per_column[0]).toBe(1500);
    expect(ghost.adjusted_win_rate).toBeCloseTo(0.52, 6);
  });

  it('passes fresh-only (new this patch) items through untouched', () => {
    const freshNew = flow(
      [
        node({ item_id: 7, wins: 5, losses: 5, players: 10, matches: 10, adjusted_win_rate: 0.48 }),
        node({ item_id: 42, wins: 30, losses: 20, players: 55, matches: 55, adjusted_win_rate: 0.58 }),
      ],
      [500],
      250,
      250,
    );
    const { flow: f } = blendFlow(freshNew, priorBig);
    const fnew = f.nodes.find((x) => x.item_id === 42)!;
    expect(fnew.wins + fnew.losses).toBe(50);
    expect(fnew.adjusted_win_rate).toBeCloseTo(0.58, 6);
    expect(fnew.players).toBe(55);
  });

  it('borrowedShare falls as the fresh window grows', () => {
    const dayOne = blendFlow(freshThin, priorBig).borrowedShare;
    const freshWeek = flow(
      [node({ item_id: 7, wins: 2400, losses: 2600, players: 5000, matches: 5000, adjusted_win_rate: 0.48 })],
      [20000],
      10000,
      10000,
    );
    const weekIn = blendFlow(freshWeek, priorBig).borrowedShare;
    expect(weekIn).toBeLessThan(dayOne);
  });

  it('blends the baseline with the same capped borrow, keeping counts integral', () => {
    const { flow: f } = blendFlow(freshThin, priorBig);
    expect(Number.isInteger(f.baseline.matches)).toBe(true);
    const decided = f.baseline.wins + f.baseline.losses;
    expect(decided).toBeGreaterThan(500); // borrowed something
    expect(decided).toBeLessThanOrEqual(500 + PATCH_K_DEFAULT);
  });
});

describe('estimatePatchK', () => {
  const manyNodes = (adjOf: (i: number) => number, n: number) =>
    Array.from({ length: 10 }, (_, i) =>
      node({
        item_id: i + 1,
        wins: Math.round(n * adjOf(i)),
        losses: n - Math.round(n * adjOf(i)),
        players: n,
        matches: n,
        adjusted_win_rate: adjOf(i),
      }),
    );

  it('falls back to the default with too few well-sampled pairs (day one)', () => {
    expect(estimatePatchK(freshThin, priorBig, 0.5)).toBe(PATCH_K_DEFAULT);
  });

  it('returns the max when the windows agree beyond sampling noise (a no-op patch)', () => {
    const a = flow(manyNodes(() => 0.5, 100000), [400000], 200000, 200000);
    const b = flow(manyNodes(() => 0.5, 100000), [400000], 200000, 200000);
    expect(estimatePatchK(a, b, 0.5)).toBe(PATCH_K_MAX);
  });

  it('does NOT max out on day-one "agreement" the fit had no power to test', () => {
    // Thin fresh pairs (60 games each): samplingVar ≫ typical drift, so driftVar ≤ 0 is guaranteed
    // whatever the truth — that must fall back to the default, not read as "no drift, borrow max".
    const a = flow(manyNodes(() => 0.5, 60), [400], 200, 200);
    const b = flow(manyNodes(() => 0.5, 100000), [400000], 200000, 200000);
    expect(estimatePatchK(a, b, 0.5)).toBe(PATCH_K_DEFAULT);
  });

  it('learns K from real drift: ~2pt typical movement ⇒ K ≈ p(1−p)/drift²', () => {
    // Huge samples so sampling noise is negligible; items drift ±0.02 across the "patch".
    const a = flow(manyNodes((i) => 0.5 + (i % 2 === 0 ? 0.02 : -0.02), 100000), [400000], 200000, 200000);
    const b = flow(manyNodes(() => 0.5, 100000), [400000], 200000, 200000);
    const k = estimatePatchK(a, b, 0.5);
    // 0.25 / 0.0004 = 625, minus the (tiny) sampling correction.
    expect(k).toBeGreaterThan(500);
    expect(k).toBeLessThan(700);
  });
});
