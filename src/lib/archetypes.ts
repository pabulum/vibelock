// Flex heroes (Victor, Vyper…) have viable Gun *and* Spirit builds. Aggregating
// every player blends the two into a hybrid no one runs (gun lane, spirit late).
//
// To separate them we condition the population on a *signature* item: the highest-
// pick T3 scaling item of each damage type. Players who bought the big weapon item
// are running the gun build; players who bought the big spirit item, the spirit
// build. `include_item_ids` does this server-side, and each conditioned response
// carries its own win rate and match count — so "which archetype wins" is free.
//
// Finer labels (Tracklock's "Initiator-Spirit", "Burst-Gun") come from community
// build *tags*, not match stats — a separate effort. This is the Gun/Spirit start.

import type {
  Archetype,
  ArchetypeKey,
  ArchetypeSet,
  Hero,
  Item,
  ItemFlowStats,
} from '../types';
import { generateBuild } from './buildGenerator';

const SIG_MIN_TIER = 3; // signatures must be scaling items, not lane fillers
// A hero is flex only if both archetypes are well-played (≥ MIN), neither is so
// near-universal (≤ MAX) that its signature is just a staple everyone buys, and the
// two camps are actually DISTINCT — not a hybrid hero where the same players buy both
// signatures (Paradox: ~half of "gun" players also bought the spirit item).
const FLEX_MIN_SHARE = 0.3;
const FLEX_MAX_SHARE = 0.8;
const FLEX_MAX_OVERLAP = 0.4; // max share of the smaller camp that also bought the other signature

export interface Signatures {
  gun?: number;
  spirit?: number;
}

/** Pick the most-played T3+ weapon and spirit items as archetype signatures. */
export function pickSignatures(flow: ItemFlowStats, items: Map<number, Item>): Signatures {
  const players = new Map<number, number>();
  for (const n of flow.nodes) players.set(n.item_id, (players.get(n.item_id) ?? 0) + n.players);

  const ranked = [...players.entries()]
    .map(([id, n]) => ({ id, n, item: items.get(id) }))
    .filter((x) => x.item && x.item.tier >= SIG_MIN_TIER)
    .sort((a, b) => b.n - a.n);

  return {
    gun: ranked.find((x) => x.item!.slot === 'weapon')?.id,
    spirit: ranked.find((x) => x.item!.slot === 'spirit')?.id,
  };
}

export interface ArchetypeFlows {
  all: ItemFlowStats;
  gun?: ItemFlowStats;
  spirit?: ItemFlowStats;
}

/** Build each archetype from its (already-fetched) conditioned flow. Pure. */
export function assembleArchetypes(
  hero: Hero,
  rankLabel: string,
  items: Map<number, Item>,
  buyTimes: Map<number, number>,
  sellTimes: Map<number, number>,
  flows: ArchetypeFlows,
  sig: Signatures,
): ArchetypeSet {
  const baseMatches = flows.all.baseline.matches || 1;

  // Conditioning on a rare item can return an empty/baseline-less response — guard it.
  const make = (
    key: ArchetypeKey,
    label: string,
    flow: ItemFlowStats | undefined,
    sigId?: number,
  ): Archetype | undefined => {
    if (!flow?.baseline) return undefined;
    return {
      key,
      label,
      signature: sigId ? items.get(sigId) : undefined,
      winRate: winRateOf(flow),
      matches: flow.baseline.matches,
      share: flow.baseline.matches / baseMatches,
      build: generateBuild(hero, rankLabel, items, flow, buyTimes, sellTimes),
    };
  };

  const all = make('all', 'All builds', flows.all)!; // base always has a baseline
  const gun = make('gun', 'Gun', flows.gun, sig.gun);
  const spirit = make('spirit', 'Spirit', flows.spirit, sig.spirit);

  const inRange = (a: Archetype) => a.share >= FLEX_MIN_SHARE && a.share <= FLEX_MAX_SHARE;
  // Distinctness: how much of the smaller camp also bought the other signature. The
  // count of players who bought BOTH is already in the gun flow — the spirit
  // signature's node there counts gun-buyers who also bought it — so there's no need
  // for a separate query conditioned on both.
  const bothMatches = flows.gun && sig.spirit ? sumPlayers(flows.gun, sig.spirit) : 0;
  const bothShare = bothMatches / baseMatches;
  const overlap = gun && spirit ? bothShare / Math.min(gun.share, spirit.share) : 1;

  const bothViable = !!gun && !!spirit && inRange(gun) && inRange(spirit);
  const flex = bothViable && overlap <= FLEX_MAX_OVERLAP;

  if (flex) {
    const split = [gun!, spirit!].sort((a, b) => b.winRate - a.winRate); // best win rate first
    const note = `Two distinct builds — ${split[0].label} wins more (${pct(split[0].winRate)} vs ${pct(split[1].winRate)}). Pick a style.`;
    return { flex: true, kind: 'flex', note, archetypes: [...split, all] };
  }

  if (bothViable) {
    return {
      flex: false,
      kind: 'hybrid',
      note: 'Hybrid hero — most players build weapon and spirit together, so this is one blended build.',
      archetypes: [all],
    };
  }

  const lean = leanLabel(gun, spirit);
  return {
    flex: false,
    kind: 'mono',
    note: lean ? `${lean}-focused hero — one core build.` : 'One core build.',
    archetypes: [all],
  };
}

/** Which damage type the hero leans on, for the mono-hero note. */
function leanLabel(gun?: Archetype, spirit?: Archetype): string | undefined {
  if (gun && spirit) return spirit.share >= gun.share ? 'Spirit' : 'Gun';
  if (spirit) return 'Spirit';
  if (gun) return 'Gun';
  return undefined;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function winRateOf(flow: ItemFlowStats): number {
  const decided = flow.baseline.wins + flow.baseline.losses;
  return decided > 0 ? flow.baseline.wins / decided : 0;
}

/** Total players who bought `itemId`, summed across phase columns (one buy per game). */
function sumPlayers(flow: ItemFlowStats, itemId: number): number {
  return flow.nodes.reduce((a, n) => (n.item_id === itemId ? a + n.players : a), 0);
}
