// Deadlock rank tiers, as served by /v1/assets/ranks.
// The analytics endpoints filter on `average_badge`, an integer encoded as
// (tier * 10 + subtier). E.g. Eternus (tier 11) spans 110–116.
// Two selection shapes: a *rank floor* ("this tier and above") or a *band*
// ("around my rank": a floor tier through a ceiling tier, inclusive). The band
// exists because match volume piles up at high-mid ranks (mode ≈ Oracle), so a
// floor below the mode is dominated by games well above the player — a capped
// band actually is their neighborhood.

import type { BadgeDistributionRow } from "../types";

export interface RankTier {
  tier: number;
  name: string;
}

/** Share of a window's matches a rank FLOOR must still hold to be offered as the default.
 * Deliberately low: this is an "is this slice effectively empty" guard, not a quality bar. The
 * top of the ladder is always thin — Eternus+ is ~3% of matches in a normal week and is a perfectly
 * good default — so anything stricter would quietly drag the default down the ladder for no reason. */
const FLOOR_MIN_SHARE = 0.01;

// Renamed by the 2026-07-30 Ranked-mode rewrite and verified against /v1/assets/ranks after
// deadlock-api picked the change up: Alchemist→Acolyte, Arcanist→Sentinel, Archon is gone, and
// Mystic is inserted at 5 — which shifts Ritualist and Emissary up one slot each. The tier
// NUMBERS are unchanged (still 12 tiers × 6 subranks), so the badge encoding, every saved URL,
// and every cached query key survive the rename untouched; only the labels move.
//
// READING OLDER COMMENTS: calibration notes written before 2026-07-30 name their rank slice in the
// OLD scheme, where the same word can mean a different tier. Map them through this table before
// re-deriving anything against a rank:
//
//   tier   3          4          5           6           7          8
//   old    Alchemist  Arcanist   Ritualist   Emissary    Archon     Oracle
//   new    Acolyte    Sentinel   Mystic      Ritualist   Emissary   Oracle
//
// So a pre-rename "Paradox @ Emissary+" was measured at tier 6, which is now called Ritualist+;
// tiers 0–2 and 8–11 kept both their number and their name.
export const RANK_TIERS: RankTier[] = [
  { tier: 0, name: "Obscurus" },
  { tier: 1, name: "Initiate" },
  { tier: 2, name: "Seeker" },
  { tier: 3, name: "Acolyte" },
  { tier: 4, name: "Sentinel" },
  { tier: 5, name: "Mystic" },
  { tier: 6, name: "Ritualist" },
  { tier: 7, name: "Emissary" },
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

const SUBRANK = ["", "I", "II", "III", "IV", "V", "VI"];

/** A full badge — tier·10 + subrank, the form Valve reports per ranked match — as its display
 * name, e.g. 92 → "Phantom II". Subrank 0 is the bare tier, which is also what an account with no
 * ranked result yet reports (badge 0 = Obscurus). */
export function badgeLabel(badge: number): string {
  const tier = Math.floor(badge / 10);
  const sub = badge % 10;
  return sub > 0 && sub < SUBRANK.length
    ? `${tierName(tier)} ${SUBRANK[sub]}`
    : tierName(tier);
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

/**
 * The highest rank floor that still has data in this window — the honest default when nobody has
 * told us a rank.
 *
 * A floor of `t` queries `average_badge >= t*10`, so what matters is the CUMULATIVE share at or
 * above `t`, not that tier's own slice. Preferring the top of the ladder is deliberate: high-rank
 * games have the cleanest, most converged builds. But the top can be genuinely empty — after the
 * 2026-07-30 ranked reset, calibration capped everyone at Oracle VI, so tiers 9–11 held *zero*
 * matches while the app still defaulted to Eternus and rendered a confident, item-less build over
 * a sample of nothing. This walks down from the top until it finds a floor that actually exists.
 *
 * Returns null when the window has no matches at all, so the caller can keep its own fallback
 * rather than be handed a fabricated tier.
 */
export function highestPopulatedFloor(
  rows: BadgeDistributionRow[],
  minShare: number = FLOOR_MIN_SHARE,
): number | null {
  const total = rows.reduce((s, r) => s + r.total_matches, 0);
  if (total <= 0) return null;
  for (let tier = 11; tier >= 1; tier--) {
    const atOrAbove = rows.reduce(
      (s, r) =>
        s + (r.badge_level >= tierToMinBadge(tier) ? r.total_matches : 0),
      0,
    );
    if (atOrAbove / total >= minShare) return tier;
  }
  return null;
}
