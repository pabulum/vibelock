// Deadlock rank tiers, as served by /v1/assets/ranks.
// The analytics endpoints filter on `average_badge`, an integer encoded as
// (tier * 10 + subtier). E.g. Eternus (tier 11) spans 110–116.
// We filter by a *rank floor*: "this tier and above".

export interface RankTier {
  tier: number;
  name: string;
}

export const RANK_TIERS: RankTier[] = [
  { tier: 0, name: 'Obscurus' },
  { tier: 1, name: 'Initiate' },
  { tier: 2, name: 'Seeker' },
  { tier: 3, name: 'Alchemist' },
  { tier: 4, name: 'Arcanist' },
  { tier: 5, name: 'Ritualist' },
  { tier: 6, name: 'Emissary' },
  { tier: 7, name: 'Archon' },
  { tier: 8, name: 'Oracle' },
  { tier: 9, name: 'Phantom' },
  { tier: 10, name: 'Ascendant' },
  { tier: 11, name: 'Eternus' },
];

/** Lowest average_badge value that counts as `tier` (subtier I). */
export function tierToMinBadge(tier: number): number {
  return tier * 10;
}

export function rankFloorLabel(tier: number): string {
  const name = RANK_TIERS.find((t) => t.tier === tier)?.name ?? `Tier ${tier}`;
  return tier >= 11 ? name : `${name}+`;
}
