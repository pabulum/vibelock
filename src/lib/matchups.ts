// Turns the hero-vs-hero counter matrix into the selected hero's notable matchups.
//
// hero-counter-stats returns the full matrix (every hero vs every enemy), so we
// filter to the selected hero, take each enemy's win rate, and compare it to that
// hero's overall win rate. Enemies well below baseline counter you (build against
// them); well above, you're favoured. These feed the counters panel: one click
// adds a tough hero to the enemy list and the build-vs-them items appear.
//
// Note: the win rate is whole-game "this hero was on the enemy team", not lane-only
// (the API's same_lane_filter is a no-op here). `laneCsDelta` is a separate lane hint.

import type { HeroCounterRow, HeroMatchups, Matchup } from '../types';

const MIN_SAMPLE = 300; // matchups thinner than this are too noisy to surface
const MIN_DELTA = 0.02; // only show matchups that move win rate by ≥ 2 pts
const TOP = 5;

export function heroMatchups(matrix: HeroCounterRow[], heroId: number): HeroMatchups {
  const rows = matrix.filter((r) => r.hero_id === heroId && r.matches_played >= MIN_SAMPLE);

  const totals = rows.reduce(
    (a, r) => ({ wins: a.wins + r.wins, matches: a.matches + r.matches_played }),
    { wins: 0, matches: 0 },
  );
  const baseline = totals.matches > 0 ? totals.wins / totals.matches : 0.5;

  const all: Matchup[] = rows.map((r) => ({
    enemyHeroId: r.enemy_hero_id,
    winRate: r.wins / r.matches_played,
    delta: r.wins / r.matches_played - baseline,
    sample: r.matches_played,
    laneCsDelta: (r.last_hits - r.enemy_last_hits) / r.matches_played,
  }));

  const tough = all
    .filter((m) => m.delta <= -MIN_DELTA)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, TOP);
  const favorable = all
    .filter((m) => m.delta >= MIN_DELTA)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, TOP);

  return { baseline, tough, favorable };
}
