// For imbue-type items (Surge of Power, Quicksilver Reload, Echo Shard, …) the pick that
// matters is *which ability you imbue it onto*. That choice is only recorded in community
// builds (the `imbue_target_ability_id` each author sets), and there's no analytics endpoint
// that breaks win rate down by target — so the best signal we have is author popularity: the
// plurality target across the hero's builds, same epistemic class as the skill order.

import type { Ability, CommunityBuild, ImbueTarget } from '../types';

// Authors often leave the target unset, so the populated set is sparse. Don't claim a target
// until enough builds have committed to one, and only when a single ability is a clear
// plurality — otherwise the choice is genuinely split and we stay silent.
const MIN_SAMPLE = 5;
const MIN_SHARE = 0.4;

/**
 * The plurality imbue target per imbue item, across a hero's community builds. Keyed by item
 * id; only items that clear the sample/plurality floor appear. `slotOrder` is the hero's
 * ability ids in slot order, used to color the target to match the skill grid. Pure.
 */
export function bestImbueTargets(
  builds: CommunityBuild[],
  abilities: Map<number, Ability>,
  slotOrder: number[],
): Map<number, ImbueTarget> {
  // item id -> (ability id -> count)
  const counts = new Map<number, Map<number, number>>();
  for (const b of builds) {
    for (const { itemId, abilityId } of b.imbueTargets) {
      if (!abilities.has(abilityId)) continue; // drop ids that don't resolve to a known ability
      let inner = counts.get(itemId);
      if (!inner) counts.set(itemId, (inner = new Map()));
      inner.set(abilityId, (inner.get(abilityId) ?? 0) + 1);
    }
  }

  const out = new Map<number, ImbueTarget>();
  for (const [itemId, inner] of counts) {
    let topId = -1;
    let topCount = 0;
    let total = 0;
    for (const [abilityId, n] of inner) {
      total += n;
      if (n > topCount) {
        topCount = n;
        topId = abilityId;
      }
    }
    if (total < MIN_SAMPLE || topCount / total < MIN_SHARE) continue;
    const a = abilities.get(topId)!;
    out.set(itemId, {
      ability: { id: a.id, name: a.name, image: a.image },
      colorIndex: slotOrder.indexOf(topId),
      share: topCount / total,
      sample: total,
    });
  }
  return out;
}
