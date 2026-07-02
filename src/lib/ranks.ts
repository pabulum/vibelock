// Deadlock rank tiers, as served by /v1/assets/ranks.
// The analytics endpoints filter on `average_badge`, an integer encoded as
// (tier * 10 + subtier). E.g. Eternus (tier 11) spans 110–116.
// Two selection shapes: a *rank floor* ("this tier and above") or a *band*
// ("around my rank": a floor tier through a ceiling tier, inclusive). The band
// exists because match volume piles up at high-mid ranks (mode ≈ Oracle), so a
// floor below the mode is dominated by games well above the player — a capped
// band actually is their neighborhood.

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

/** Highest average_badge value inside `tier` (subtier VI). */
export function tierToMaxBadge(tier: number): number {
  return tier * 10 + 6;
}

export function rankFloorLabel(tier: number): string {
  const name = RANK_TIERS.find((t) => t.tier === tier)?.name ?? `Tier ${tier}`;
  return tier >= 11 ? name : `${name}+`;
}

const tierName = (t: number) =>
  RANK_TIERS.find((x) => x.tier === t)?.name ?? `Tier ${t}`;

/** A band's display label, e.g. "Ritualist–Archon" (or a single tier's plain name). */
export function rankBandLabel(lo: number, hi: number): string {
  return lo === hi ? tierName(lo) : `${tierName(lo)}–${tierName(hi)}`;
}

/** A rank selection: a floor tier ("Emissary+") or an inclusive tier band ("around my rank"). */
export type RankSel = number | { lo: number; hi: number };

/** The profile-anchored default band for a player at `tier`: their own tier through two above
 * (clamped). Anchored where matchmaking actually puts them, tilted toward the ranks they're
 * climbing into — and capped, so the high-mid population pile-up can't dominate the slice. */
export function bandForTier(tier: number): { lo: number; hi: number } {
  const lo = Math.max(0, Math.min(tier, 11));
  return { lo, hi: Math.min(lo + 2, 11) };
}

/** The average_badge window a selection queries: floor ⇒ min only; band ⇒ min and max. */
export function rankSelToBadges(sel: RankSel): {
  minBadge: number;
  maxBadge?: number;
} {
  if (typeof sel === "number") return { minBadge: tierToMinBadge(sel) };
  return { minBadge: tierToMinBadge(sel.lo), maxBadge: tierToMaxBadge(sel.hi) };
}

/** Display label for either selection shape. */
export function rankSelLabel(sel: RankSel): string {
  return typeof sel === "number"
    ? rankFloorLabel(sel)
    : rankBandLabel(sel.lo, sel.hi);
}
