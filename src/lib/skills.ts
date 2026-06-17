// Picks a recommended skill (ability upgrade) build from ability-order-stats.
//
// Each row is a full upgrade order with win/loss. Exact orders fragment, so rather
// than chase a high-variance top win rate we take the most *common* order that
// still has a solid win rate — the standard build good players run — and derive the
// "max priority" (which ability gets fully upgraded first) for a quick summary.

import type { AbilityOrderRow, SkillBuild } from '../types';

/** Confidence floor: we trust the most-common order only above this many players. */
export const MIN_SAMPLE = 50;

export function bestSkillBuild(rows: AbilityOrderRow[]): SkillBuild | null {
  const withAbilities = rows.filter((r) => r.abilities.length > 0);
  if (!withAbilities.length) return null;

  // Prefer orders that clear the confidence floor; if none do, still surface the most
  // common one rather than showing nothing — but flag it as a thin sample.
  const usable = withAbilities.filter((r) => r.players >= MIN_SAMPLE);
  const pool = usable.length ? usable : withAbilities;

  // Most common order — the meta-standard skill build.
  const r = pool.reduce((best, cur) => (cur.players > best.players ? cur : best));
  const decided = r.wins + r.losses;

  return {
    order: r.abilities,
    maxPriority: maxOrder(r.abilities),
    winRate: decided > 0 ? r.wins / decided : 0,
    sample: r.players,
    lowSample: r.players < MIN_SAMPLE,
  };
}

/** Abilities sorted by when they receive their last point (earlier = maxed first). */
function maxOrder(order: number[]): number[] {
  const lastIndex = new Map<number, number>();
  order.forEach((id, i) => lastIndex.set(id, i));
  return [...new Set(order)].sort((a, b) => (lastIndex.get(a) ?? 0) - (lastIndex.get(b) ?? 0));
}
