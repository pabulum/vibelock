// Picks a recommended skill (ability upgrade) build from ability-order-stats.
//
// Each row is a full upgrade order with win/loss. Exact orders fragment, so we take the most
// *common* order — the standard build good players run — and derive the "max priority" (which
// ability gets fully upgraded first) for a quick summary. It's shown descriptively, with no
// win rate: ability-order win rates are survivorship-biased (a completed order only exists in
// games that lasted), and the de-confounded effect of skill order is ~nil and not estimable
// from a client-side tool. See the ability-order-survivorship analysis.

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

  return {
    order: r.abilities,
    maxPriority: maxOrder(r.abilities),
    sample: r.players,
    lowSample: r.players < MIN_SAMPLE,
  };
}

/** Abilities sorted by when they receive their last point (earlier = maxed first).
 *  Exported for the build-hover, which shows a community build's max order. */
export function maxOrder(order: number[]): number[] {
  const lastIndex = new Map<number, number>();
  order.forEach((id, i) => lastIndex.set(id, i));
  return [...new Set(order)].sort((a, b) => (lastIndex.get(a) ?? 0) - (lastIndex.get(b) ?? 0));
}
