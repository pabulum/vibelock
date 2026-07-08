import { describe, expect, it } from 'vitest';
import type { Item, ItemStat } from '../types';
import { findPatchMovers } from './patchMovers';

const item = (id: number): Item =>
  ({ id, name: `Item ${id}`, cost: 1000, tier: 2, slot: 'weapon', componentIds: [] }) as unknown as Item;

const items = new Map(Array.from({ length: 30 }, (_, i) => [i + 1, item(i + 1)]));

const stat = (item_id: number, wins: number, losses: number): ItemStat => ({
  item_id,
  wins,
  losses,
  matches: wins + losses,
  players: wins + losses,
  avg_buy_time_s: 300,
  avg_sell_time_s: 0,
});

describe('findPatchMovers', () => {
  it('finds a real, big, well-sampled move and reports its direction', () => {
    const fresh = [stat(1, 1700, 1300)]; // 56.7%
    const prior = [stat(1, 5000, 5000)]; // 50%
    const [m] = findPatchMovers(fresh, prior, items);
    expect(m.item.id).toBe(1);
    expect(m.delta).toBeGreaterThan(0.05);
    expect(m.isNew).toBeUndefined();
  });

  it('ignores thin samples and sub-floor drifts', () => {
    const fresh = [
      stat(1, 20, 10), // huge shift but n=30 < floor
      stat(2, 50600, 49400), // +0.6pt on a massive sample: significant, but below the 2pt effect floor
    ];
    const prior = [stat(1, 500, 500), stat(2, 50000, 50000)];
    expect(findPatchMovers(fresh, prior, items)).toEqual([]);
  });

  it('FDR-controls the family: 20 null items with wobble produce no movers', () => {
    // Each item ~50% both windows with sampling-scale wobble — nothing should survive BH.
    const fresh = Array.from({ length: 20 }, (_, i) =>
      stat(i + 1, 300 + ((i * 7) % 25), 300 - ((i * 7) % 25)),
    );
    const prior = Array.from({ length: 20 }, (_, i) => stat(i + 1, 3000, 3000));
    expect(findPatchMovers(fresh, prior, items)).toEqual([]);
  });

  it('appends well-sampled new items, flagged, after the movers', () => {
    const fresh = [stat(1, 1700, 1300), stat(9, 90, 60)];
    const prior = [stat(1, 5000, 5000)];
    const out = findPatchMovers(fresh, prior, items);
    expect(out.map((m) => m.item.id)).toEqual([1, 9]);
    expect(out[1].isNew).toBe(true);
  });

  it('skips a new item that has not accrued a real sample yet', () => {
    const out = findPatchMovers([stat(9, 30, 20)], [], items);
    expect(out).toEqual([]);
  });
});

// foldTrendingBreakouts adds current breakouts as tagged situational options where they're not
// already in the build, placing each by tier (T1→Lane … T4→Late) and never duplicating an existing
// pick. It's purely additive — the core build is untouched.
import { foldTrendingBreakouts, type AdoptionMover } from './patchMovers';
import type { BuildItem, BuildPhase, GeneratedBuild } from '../types';

const bi = (id: number): BuildItem =>
  ({
    item: item(id),
    role: 'universal',
    pickRate: 0.5,
    adjustedWinRate: 0.52,
    rawWinRate: 0.52,
    sample: 1000,
    decided: 1000,
    avgNetWorthAtBuy: 0,
    why: '',
  }) as BuildItem;

const phase = (column: number, core: number[], situational: number[]): BuildPhase => ({
  column,
  label: ['Lane', 'Early mid', 'Mid', 'Late'][column],
  timeLabel: '',
  targetItems: core.length,
  itemsBought: core.length,
  soulBudget: 0,
  coreSouls: 0,
  categorySouls: { weapon: 0, vitality: 0, spirit: 0 },
  core: core.map(bi),
  situational: situational.map(bi),
});

const buildOf = (phases: BuildPhase[], overtime: number[] = []): GeneratedBuild => ({
  hero: { id: 1, name: 'H', signatureClasses: [] },
  rankLabel: 'R',
  population: { matches: 1000, avgDurationS: 1800, baselineWinRate: 0.5 },
  phases,
  standingSlots: 0,
  overtimeBuys: overtime.map(bi),
});

const mover = (id: number, tier: number, breakout: boolean): AdoptionMover => ({
  item: { ...item(id), tier },
  pickPrev: 0.05,
  pickNew: 0.14,
  pickDelta: 0.09,
  winRate: breakout ? 0.55 : 0.49,
  winEdge: breakout ? 0.05 : -0.01,
  nNew: 800,
  breakout,
});

describe('foldTrendingBreakouts', () => {
  it('folds an un-built breakout into the situational list of its tier phase', () => {
    const build = buildOf([phase(0, [1], []), phase(1, [2], []), phase(2, [3], []), phase(3, [4], [])]);
    const out = foldTrendingBreakouts(build, [mover(20, 3, true)]); // T3 → Mid (column 2)
    const mid = out.phases[2];
    const added = mid.situational.find((b) => b.item.id === 20);
    expect(added).toBeDefined();
    expect(added!.why).toMatch(/trending up/);
    // other phases untouched, core untouched
    expect(out.phases[2].core.map((b) => b.item.id)).toEqual([3]);
  });

  it('never duplicates a breakout already in the build (core or overtime)', () => {
    const build = buildOf([phase(0, [1], []), phase(1, [2], []), phase(2, [3], []), phase(3, [4], [])], [40]);
    const out = foldTrendingBreakouts(build, [mover(3, 3, true), mover(40, 4, true)]);
    const allIds = out.phases.flatMap((p) => [...p.core, ...p.situational].map((b) => b.item.id));
    expect(allIds.filter((x) => x === 3).length).toBe(1); // still just the one core copy
    expect(allIds).not.toContain(40); // already in overtime — not folded into a phase
  });

  it('returns the same build when there are no breakouts', () => {
    const build = buildOf([phase(0, [1], [])]);
    expect(foldTrendingBreakouts(build, [])).toBe(build);
  });
});
