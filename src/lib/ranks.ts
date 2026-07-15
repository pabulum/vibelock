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
  { tier: 0, name: "Obscurus" },
  { tier: 1, name: "Initiate" },
  { tier: 2, name: "Seeker" },
  { tier: 3, name: "Alchemist" },
  { tier: 4, name: "Arcanist" },
  { tier: 5, name: "Ritualist" },
  { tier: 6, name: "Emissary" },
  { tier: 7, name: "Archon" },
  { tier: 8, name: "Oracle" },
  { tier: 9, name: "Phantom" },
  { tier: 10, name: "Ascendant" },
  { tier: 11, name: "Eternus" },
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

/** The profile-anchored default band for a player at `tier`: one major rank either side,
 * clamped. The anchor (the API's MMR estimate) tracks the average badge of the lobbies the
 * player actually lands in — for a duo it sits *between* the partners' own badges — and
 * ranked lobbies stay within about one major rank of their average. So a centered band IS
 * "the games you end up in"; the old [tier, tier+2] floor-style band skewed the slice toward
 * lobbies two ranks up, which is also the statistically expensive direction (measured item-WR
 * drift: one band down ≈ 0.9pt, one band up ≈ 1.7pt). */
export function bandForTier(tier: number): { lo: number; hi: number } {
  const t = Math.max(1, Math.min(tier, 11));
  return { lo: Math.max(1, t - 1), hi: Math.min(t + 1, 11) };
}

/** The tier a selection is anchored on: a floor's own tier, or a band's centre. */
export function tierOf(sel: RankSel): number {
  return typeof sel === "number" ? sel : Math.round((sel.lo + sel.hi) / 2);
}

/**
 * The benchmark band for *climbing*: the rank a player at `tier` is trying to reach, not their own.
 * "How should I play to rank up" is answered by the tier above, so the fundamentals card and the
 * post-game read both grade against one tier up (clamped at Eternus). A single tier, not a wide
 * band, so the target is concrete ("Oracle farm this many camps"), and it's the up direction the
 * player cares about — their own-rank peers are, by definition, where they already are.
 */
export function climbBand(tier: number): { lo: number; hi: number } {
  const t = Math.min(11, Math.max(0, Math.round(tier)) + 1);
  return { lo: t, hi: t };
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
