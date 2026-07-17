import { describe, expect, it } from 'vitest';
import type { CommunityBuild, HeroBuildStatRow } from '../types';
import { diffBuild, matchCommunityBuilds } from './communityBuilds';

function build(
  id: number,
  coreItemIds: number[],
  itemIds: number[] = coreItemIds,
): CommunityBuild {
  return {
    id,
    name: `build ${id}`,
    authorId: 0,
    version: 1,
    updatedAt: 0,
    itemIds,
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

describe('diffBuild', () => {
  // Their build: core {1,2,7,8}, situational tail {3,5,9}.
  const theirs = build(9, [1, 2, 7, 8], [1, 2, 7, 8, 3, 5, 9]);
  // Ours: core {1,3,4}, situational {2,5,6}.
  const d = diffBuild([1, 3, 4], [2, 5, 6], theirs);

  it('partitions the union into the verdict buckets', () => {
    expect(d.agreeCore).toEqual([1]); // core for both
    expect(d.agreeFlex).toEqual([5]); // situational for both
    expect(d.demoted).toEqual([3]); // our core, their situational
    expect(d.promoted).toEqual([2]); // our situational, their core
    expect(d.added).toEqual([7, 8]); // their core, not in ours at all
    expect(d.addedFlexCount).toBe(1); // their situational tail (9)
    expect(d.missingCore).toEqual([4]); // our core, absent from their menu
    expect(d.missingFlex).toEqual([6]); // our situational, absent
  });

  it('covers both builds exactly once', () => {
    const listed =
      d.agreeCore.length +
      d.agreeFlex.length +
      d.demoted.length +
      d.promoted.length +
      d.added.length +
      d.addedFlexCount +
      d.missingCore.length +
      d.missingFlex.length;
    expect(listed).toBe(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]).size);
  });

  it('treats an item listed in both of our sets as core', () => {
    const d2 = diffBuild([1], [1], build(1, [1]));
    expect(d2.agreeCore).toEqual([1]);
    expect(d2.agreeFlex).toEqual([]);
    expect(d2.promoted).toEqual([]);
  });

  it('tolerates a core id missing from the build item list', () => {
    // Defensive: coreItemIds should be ⊆ itemIds, but a payload that violates it
    // must not surface the item as "missing".
    const d3 = diffBuild([1], [], build(1, [1], []));
    expect(d3.agreeCore).toEqual([1]);
    expect(d3.missingCore).toEqual([]);
  });

  it('handles an empty generated build (everything is theirs)', () => {
    const d4 = diffBuild([], [], theirs);
    expect(d4.added).toEqual([1, 2, 7, 8]);
    expect(d4.addedFlexCount).toBe(3);
    expect(d4.agreeCore).toEqual([]);
    expect(d4.missingCore).toEqual([]);
  });
});
