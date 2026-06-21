// Match our generated build against real player-authored builds for the same hero,
// surfacing two signals: the build that *performs* best at the chosen rank, and the
// build whose core item set most *aligns* with ours. When they're the same build, that's a
// strong endorsement — the meta agrees with what the tool generated.

import type {
  CommunityBuild,
  CommunityMatch,
  HeroBuildStatRow,
  RankedCommunityBuild,
} from '../types';

/**
 * Overlap of two item sets, 0–1 (intersection / union). Jaccard, not coverage, on
 * purpose: community builds list the author's whole menu (40+ items), so a kitchen-sink
 * build trivially contains ours. Penalizing union size makes a focused build that
 * matches ours score higher than one that simply lists everything. We feed it the build's
 * *core* set (situational sections excluded), which compounds this: a well-organized build
 * exposes a tight core and scores high; one that never flags its tail is judged on the
 * whole bloated list and falls behind.
 */
function overlap(a: Set<number>, b: Iterable<number>): { jaccard: number; shared: number } {
  let inter = 0;
  let bSize = 0;
  const seen = new Set<number>();
  for (const id of b) {
    if (seen.has(id)) continue;
    seen.add(id);
    bSize++;
    if (a.has(id)) inter++;
  }
  const union = a.size + bSize - inter;
  return { jaccard: union > 0 ? inter / union : 0, shared: inter };
}

/**
 * How many of our situational picks the build also lists as situational (its items that
 * aren't in its core). Like-for-like and bounded by our (capped) situational set. Kept out
 * of the ranking on purpose: their situational tail is the bloated part of the menu, so a
 * Jaccard there ≈ 0 for everyone and a coverage metric there would re-reward kitchen-sink
 * builds — the very bias core:core removes. It's a display-only secondary signal.
 */
function situationalOverlap(build: CommunityBuild, ourSitu: Set<number>): number {
  if (ourSitu.size === 0) return 0;
  const core = new Set(build.coreItemIds);
  let n = 0;
  for (const id of build.itemIds) if (!core.has(id) && ourSitu.has(id)) n++;
  return n;
}

/**
 * Join community builds to their win-rate stats, score each against our build's items,
 * and pick the best-performing and best-aligned. Only builds with stats in the window
 * (i.e. actually played at this rank) are considered, so every result has a real win
 * rate to show. Pure.
 */
export function matchCommunityBuilds(
  builds: CommunityBuild[],
  stats: HeroBuildStatRow[],
  ourCoreIds: number[],
  ourSituationalIds: number[],
): CommunityMatch {
  const ourCore = new Set(ourCoreIds);
  const ourSitu = new Set(ourSituationalIds);
  const statById = new Map(stats.map((s) => [s.hero_build_id, s]));

  const ranked: RankedCommunityBuild[] = [];
  for (const build of builds) {
    const stat = statById.get(build.id);
    if (!stat || stat.matches <= 0) continue;
    // Rank on core:core (symmetric, robust); carry situational:situational as a secondary
    // signal only — never in the score (see situationalOverlap).
    const { jaccard, shared } = overlap(ourCore, build.coreItemIds);
    ranked.push({
      build,
      winRate: stat.wins / stat.matches,
      matches: stat.matches,
      similarity: jaccard,
      shared,
      situShared: situationalOverlap(build, ourSitu),
    });
  }
  if (ranked.length === 0) return { best: null, aligned: null, agree: false };

  // Best win rate (break ties toward the larger sample); closest item set to ours.
  const best = ranked.reduce((a, b) =>
    b.winRate > a.winRate || (b.winRate === a.winRate && b.matches > a.matches) ? b : a,
  );
  const aligned = ranked.reduce((a, b) => (b.similarity > a.similarity ? b : a));

  return { best, aligned, agree: best.build.id === aligned.build.id };
}
