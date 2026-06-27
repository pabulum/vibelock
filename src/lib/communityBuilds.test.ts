import { describe, expect, it } from 'vitest';
import type { CommunityBuild, HeroBuildStatRow } from '../types';
import { matchCommunityBuilds } from './communityBuilds';

function build(id: number, coreItemIds: number[]): CommunityBuild {
  return {
    id,
    name: `build ${id}`,
    authorId: 0,
    version: 1,
    updatedAt: 0,
    itemIds: coreItemIds,
    coreItemIds,
    skillOrder: [],
    imbueTargets: [],
  };
}
function stat(id: number, wins: number, matches: number): HeroBuildStatRow {
  return { hero_build_id: id, wins, losses: matches - wins, matches };
}

describe('matchCommunityBuilds', () => {
  const ourCore = [1, 2, 3, 4];
  // A: exact item overlap (Jaccard 1.0) but a mediocre win rate.
  const closest = build(1, [1, 2, 3, 4]);
  // B: more items (Jaccard 0.8) but the best win rate.
  const winner = build(2, [1, 2, 3, 4, 5]);
  const stats = [stat(1, 30, 60), stat(2, 50, 60)];

  it('aligns on item overlap and headlines on win rate, flagging when they disagree', () => {
    const m = matchCommunityBuilds([closest, winner], stats, ourCore, []);
    expect(m.aligned?.build.id).toBe(1); // highest Jaccard
    expect(m.best?.build.id).toBe(2); // highest win rate (≥ sample floor)
    expect(m.agree).toBe(false);
  });

  it('returns no headline when nothing clears the win-rate sample floor', () => {
    const thin = [stat(1, 8, 10), stat(2, 9, 12)];
    const m = matchCommunityBuilds([closest, winner], thin, ourCore, []);
    expect(m.best).toBeNull(); // below MIN_BEST_SAMPLE
    expect(m.aligned?.build.id).toBe(1); // alignment ignores the floor
  });
});
