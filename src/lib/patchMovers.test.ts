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
