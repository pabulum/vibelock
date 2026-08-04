// Where you died — the post-game death map.
//
// The one read in the whole app that is spatial rather than statistical, and the reason it exists is
// that "14 deaths, 6 in the mid phase" tells you a count while a map tells you a HABIT. Dying nine
// times in the same corner is a positioning pattern with an obvious fix; dying in nine different
// places is variance, and no table distinguishes them.
//
// TWO RULES:
//
//  1. NO INVENTED ZONE NAMES. A place may be named only when the name is DERIVED — the map frame
//     (scripts/bake-death-map.mjs) locates the cores, guardians and walkers in world coordinates
//     from objective-destruction data, and every label here is either one of those structures or a
//     property of the display itself (left/mid/right, which half). What is still forbidden is
//     community geography — "the jungle", "the flank", "high ground" — because nothing in the data
//     says where those are, and a confident wrong name is worse than silence.
//  2. The population layer is CONTEXT, not a grade. Deaths concentrate where the game is played, so
//     a death in a hot cell is the most ordinary thing there is. The interesting signal is a cluster
//     of YOUR deaths, not agreement with the crowd.
//
// EVERYTHING HERE IS IN THE VIEWER'S OWN FRAME: their base at negative y, the enemy's at positive,
// so "deeper" always means "further into the enemy half" for either team. The map is 180°-rotation
// symmetric (measured — see the bake), so a Team1 player's whole game rotates onto Team0's frame
// exactly, and one set of landmarks serves both. Rotating rather than mirroring is the correct
// transform and also the one that matches the game: a mirror would swap the player's left and right.
//
// The coordinates were in the payload the whole time (`death_pos`, `killer_pos`); they simply were
// not parsed. See api/schemas.MatchDeathSchema.

import type { MatchDeath } from "../types";
import { PHASE_LABELS } from "./phases";

/**
 * Half-width of the square world box the map covers, in world units.
 *
 * Duplicated from the bake (scripts/bake-death-map.mjs HALF_EXTENT) so the client can place a
 * player's deaths BEFORE — or entirely without — the population asset. The baked value always wins
 * when it's present; this is the fallback that lets the map draw on a fresh session or a failed
 * fetch. Measured 2026-08-03 over 3h of ranked deaths: x ∈ [−9445, 9284], y ∈ [−10725, 10890].
 */
export const WORLD_HALF_EXTENT = 11520;

/**
 * A population density grid: one byte per cell, row-major, `size`×`size`.
 *
 * ROW 0 IS THE TOP OF THE MAP (highest world y). The bake flips world rows into screen order so the
 * grid is drawable as-is against deaths placed by {@link worldToUnit}, which flips too. If the two
 * ever disagree the field renders mirrored against the dots — and on a near-symmetric map that
 * looks completely plausible, so the convention is pinned in both files rather than inferred.
 */
export interface DeathDensity {
  size: number;
  /** Half-width of the square world box the grid covers, in world units. */
  halfExtent: number;
  /** Decoded cell bytes, 0–255, already normalized against the phase's peak cell. */
  cells: Uint8Array;
}

/** Decode a base64 grid from the baked asset. Returns null when the payload doesn't match the
 * declared size, so a shape change degrades to "no underlay" rather than a scrambled map. */
export function decodeDensity(
  b64: string,
  size: number,
  halfExtent: number,
): DeathDensity | null {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  if (bin.length !== size * size) return null;
  const cells = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) cells[i] = bin.charCodeAt(i);
  return { size, halfExtent, cells };
}

/**
 * Where grid cell `i` draws inside a `boxPx`-wide square.
 *
 * Extracted from the component purely so this convention is pinned by a TEST rather than by a
 * comment. It is the client half of the row-order contract described on {@link DeathDensity}, and
 * its failure mode is invisible: mirror it and the density field still looks like a plausible map,
 * just flipped against the death dots drawn over it. That already happened once.
 */
export function cellRect(
  i: number,
  size: number,
  boxPx: number,
): { x: number; y: number; w: number } {
  const px = boxPx / size;
  return {
    x: (i % size) * px,
    // Row 0 is the TOP of the map, matching how the bake writes rows and how worldToUnit flips
    // world y — so this is a plain top-down walk with no second flip anywhere.
    y: Math.floor(i / size) * px,
    // A half-pixel of overlap: adjacent cells are one continuous field, not tiles, and exact-width
    // rects leave hairline seams at fractional scales.
    w: px + 0.5,
  };
}

/** A world point as a fraction of the map box, both in [0,1] with y already flipped for screen
 * space (world +y is up, SVG +y is down). Out-of-box points are clamped rather than dropped: a
 * death just outside the baked extent is still a real death and belongs on the edge. */
export function worldToUnit(
  x: number,
  y: number,
  halfExtent: number,
): { u: number; v: number } {
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return {
    u: clamp((x + halfExtent) / (2 * halfExtent)),
    v: clamp(1 - (y + halfExtent) / (2 * halfExtent)),
  };
}

/**
 * Which way to rotate a player's world coordinates into the display frame.
 *
 * Team0 already plays from negative y, so its games pass through untouched; Team1's rotate 180°
 * about the origin. After this every player's own base is at the bottom of the map and `y > 0`
 * means "in the enemy half" for both of them.
 */
export function teamSign(team: number): 1 | -1 {
  return team === 1 ? -1 : 1;
}

/** One of the focus player's deaths, placed for drawing. */
export interface DeathMark {
  /** Index in the player's death list — stable key, and the order they happened in. */
  i: number;
  gameTimeS: number;
  /** Build-phase index (0–3) this death falls in, on the same 600s columns as everything else. */
  phase: number;
  /** World coordinates already rotated into the display frame — kept alongside the unit-square
   * position because naming a place is a question about world distances, not screen ones. */
  x: number;
  y: number;
  u: number;
  v: number;
  /** Where the killer stood, when reported — drawn as a short leader so the direction a death came
   * from is visible. Absent on suicides/environment kills. */
  from?: { u: number; v: number };
  /** Seconds spent dead. The real cost of the death, and it grows through the game. */
  deadS?: number;
}

/**
 * Place a player's deaths on the unit square, rotated into the display frame by `sign`
 * ({@link teamSign}). Deaths without a position are dropped — the metadata omits `death_pos` on
 * some kills and a mark at (0,0) would be a fabricated location, and (0,0) is mid.
 */
export function deathMarks(
  deaths: MatchDeath[],
  halfExtent: number,
  sign: 1 | -1 = 1,
): DeathMark[] {
  const out: DeathMark[] = [];
  deaths.forEach((d, i) => {
    if (!d.death_pos) return;
    const x = sign * d.death_pos.x;
    const y = sign * d.death_pos.y;
    const { u, v } = worldToUnit(x, y, halfExtent);
    const from = d.killer_pos
      ? worldToUnit(sign * d.killer_pos.x, sign * d.killer_pos.y, halfExtent)
      : undefined;
    out.push({
      i,
      gameTimeS: d.game_time_s,
      phase: Math.min(PHASE_LABELS.length - 1, Math.floor(d.game_time_s / 600)),
      x,
      y,
      u,
      v,
      from,
      deadS: d.death_duration_s ?? undefined,
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// The map reference: landmarks, and the vocabulary for naming a place.
// ---------------------------------------------------------------------------

/** One structure of the baked frame, in the viewer's own frame (own base at negative y). */
export interface FrameAnchor {
  x: number;
  y: number;
}
export interface MapFrame {
  core: FrameAnchor;
  tier1: Array<FrameAnchor & { lane: number }>;
  tier2: Array<FrameAnchor & { lane: number }>;
}

export interface Landmark {
  kind: "core" | "tier1" | "tier2";
  /** Whose it is — the viewer's, or the enemy's. */
  own: boolean;
  x: number;
  y: number;
  u: number;
  v: number;
  side: "left" | "mid" | "right";
}

/** Half-width of the middle corridor, in world units. The three lanes sit at roughly x = −7400, 0
 * and +7400, so anything inside this belongs to the middle one. */
const MID_HALF_WIDTH = 2600;

function sideOf(x: number): Landmark["side"] {
  if (Math.abs(x) < MID_HALF_WIDTH) return "mid";
  return x < 0 ? "left" : "right";
}

/**
 * Both teams' structures, placed for drawing.
 *
 * The enemy's are the NEGATION of the viewer's, which is the whole payoff of the rotational
 * symmetry: the bake measures one set and the client gets the other for free. Note this is not a
 * left-right mirror — the enemy's left-lane structure is the negation of the viewer's RIGHT-lane
 * one, which is exactly how it sits in the game.
 */
export function landmarks(frame: MapFrame, halfExtent: number): Landmark[] {
  const out: Landmark[] = [];
  const add = (kind: Landmark["kind"], a: FrameAnchor, own: boolean) => {
    const x = own ? a.x : -a.x;
    const y = own ? a.y : -a.y;
    out.push({
      kind,
      own,
      x,
      y,
      side: sideOf(x),
      ...worldToUnit(x, y, halfExtent),
    });
  };
  for (const own of [true, false]) {
    add("core", frame.core, own);
    for (const t of frame.tier1) add("tier1", t, own);
    for (const t of frame.tier2) add("tier2", t, own);
  }
  return out;
}

/** How close a point has to be to a structure to be described as "at" it. The structures are
 * ~3,000 world units apart at their tightest, so this can't put a death at the wrong one. */
const AT_LANDMARK = 1600;

/** Past this far from the midline, a point is "deep" rather than merely in one half. */
const DEEP = 5500;
/** Inside this, a point is at the midline rather than in either half. */
const MIDLINE = 900;

const KIND_LABEL: Record<Landmark["kind"], string> = {
  core: "base",
  tier1: "tier-1",
  tier2: "tier-2",
};

/**
 * Name a place, in the player's own orientation.
 *
 * Every branch is derived: a structure name comes from the API's own objective enum and a measured
 * position, and the fallback describes the display frame itself ("their half, on the left"), which
 * is true by construction. Nothing here reaches for community geography.
 */
export function placeName(x: number, y: number, lms: Landmark[]): string {
  let best: Landmark | null = null;
  let bestD = AT_LANDMARK;
  for (const l of lms) {
    const d = Math.hypot(l.x - x, l.y - y);
    if (d < bestD) {
      bestD = d;
      best = l;
    }
  }
  if (best) {
    const where = best.side === "mid" ? "in mid" : `on the ${best.side}`;
    return `${best.own ? "your" : "their"} ${KIND_LABEL[best.kind]} ${where}`;
  }
  const side = sideOf(x);
  const flank = side === "mid" ? "" : ` on the ${side}`;
  if (Math.abs(y) < MIDLINE) return `around the midline${flank}`;
  const half = y > 0 ? "their half" : "your own half";
  return `${Math.abs(y) > DEEP ? "deep in " : "in "}${half}${flank}`;
}

// ---------------------------------------------------------------------------
// Depth: the one death statistic a player can act on directly.
// ---------------------------------------------------------------------------

/** Population share of deaths past the midline, for one phase and one outcome. */
export interface DepthNorm {
  enemyHalf: number;
  n: number;
}

export interface DepthRead {
  /** Deaths of the player's that were past the midline, and the total placed. */
  past: number;
  total: number;
  observed: number;
  /**
   * What the population share would be for a player whose deaths fell in the SAME phases — direct
   * standardization. Without it a player whose deaths happen to be late looks reckless purely
   * because everyone dies deeper late, which is a fact about the clock, not about them.
   */
  expected: number;
  /** True when the gap clears the binomial noise of a dozen deaths (see {@link depthRead}). */
  real: boolean;
}

/**
 * How deep the player died, against a population matched on both phase and outcome.
 *
 * The significance gate matters more here than almost anywhere else in the app: a ten-death sample
 * has a binomial standard error near 15 percentage points, so an eyeballed "you died deep this
 * game" is wrong about a third of the time. Nothing is claimed under two standard errors.
 */
export function depthRead(
  marks: DeathMark[],
  norms: Array<DepthNorm | null>,
  minGap = 2,
): DepthRead | null {
  const usable = marks.filter((m) => norms[m.phase]);
  if (usable.length < 4) return null;
  const past = usable.filter((m) => m.y > 0).length;
  const total = usable.length;
  const observed = past / total;
  const expected =
    usable.reduce((s, m) => s + (norms[m.phase]?.enemyHalf ?? 0), 0) / total;
  const se = Math.sqrt((expected * (1 - expected)) / total) || 1;
  return {
    past,
    total,
    observed,
    expected,
    real: Math.abs(observed - expected) >= minGap * se,
  };
}

/** The depth sentence, or null when the gap is inside the noise. */
export function depthInsight(r: DepthRead | null): string | null {
  if (!r || !r.real) return null;
  const them = Math.round(r.expected * r.total);
  const deep = r.observed > r.expected;
  return (
    `${r.past} of your ${r.total} placed deaths were in the enemy half — about ${them} would be ` +
    `typical for deaths at these points of a game that ended the way yours did. ` +
    (deep
      ? `You are dying further forward than the result supports, which is the one positioning habit that costs souls twice: the death, and the walk back.`
      : `You are dying further back than most, which is where deaths happen when the map is being taken from you rather than by you.`)
  );
}

/** Fraction of the map's width that counts as "the same place". Deaths inside this of each other are
 * one cluster. 12% of ~19,000 world units is roughly 2,300 units — close enough that the same
 * approach, the same choke or the same ward covers all of them. */
const CLUSTER_RADIUS = 0.12;

/** A repeat spot needs both a count and a share before it's a habit rather than a coincidence of a
 * long game — the same two-part test `deathsSummary` applies to a nemesis. */
const CLUSTER_MIN = 3;
const CLUSTER_MIN_SHARE = 0.35;

export interface DeathCluster {
  /** Cluster centre on the unit square. */
  u: number;
  v: number;
  /** The same centre in world coordinates, for naming the place it sits in. */
  x: number;
  y: number;
  count: number;
  share: number;
  /** Total seconds spent dead from this cluster, when the payload reported durations. */
  deadS?: number;
}

/**
 * The one spot the player keeps dying in, or null.
 *
 * Deliberately greedy and single-pass rather than a real clustering algorithm: with a dozen points
 * the difference is nil, and the question is only "is there ONE place that dominates", not "what is
 * the full cluster structure". Returns null when no spot clears both thresholds — most games have
 * no pattern, and inventing one is exactly the failure this file is trying to avoid.
 */
export function deathCluster(marks: DeathMark[]): DeathCluster | null {
  if (marks.length < CLUSTER_MIN) return null;
  let best: DeathMark[] = [];
  for (const seed of marks) {
    const near = marks.filter(
      (m) => Math.hypot(m.u - seed.u, m.v - seed.v) <= CLUSTER_RADIUS,
    );
    if (near.length > best.length) best = near;
  }
  const share = best.length / marks.length;
  if (best.length < CLUSTER_MIN || share < CLUSTER_MIN_SHARE) return null;
  const deadS = best.every((m) => m.deadS !== undefined)
    ? best.reduce((s, m) => s + (m.deadS ?? 0), 0)
    : undefined;
  const mean = (f: (m: DeathMark) => number) =>
    best.reduce((s, m) => s + f(m), 0) / best.length;
  return {
    u: mean((m) => m.u),
    v: mean((m) => m.v),
    x: mean((m) => m.x),
    y: mean((m) => m.y),
    count: best.length,
    share,
    deadS,
  };
}

/**
 * The plain-language read.
 *
 * Names the spot when a map frame is available, because "you keep dying at their tier-2 on the
 * left" is a finding a player can do something with and "you keep dying in one place" is barely
 * one. Without a frame it degrades to the placeless wording rather than guessing — the underlay is
 * a lazily-fetched extra and may not have arrived, or ever.
 */
export function clusterInsight(
  c: DeathCluster | null,
  total: number,
  lms?: Landmark[],
): string | null {
  if (!c) {
    return total >= 6
      ? `Your ${total} deaths are spread across the map rather than repeating in one spot — no positioning habit to fix here, so read the timing instead.`
      : null;
  }
  const cost =
    c.deadS !== undefined && c.deadS > 60
      ? ` That one spot cost you ${Math.round(c.deadS / 60)} minutes dead.`
      : "";
  const where = lms && lms.length > 0 ? `, ${placeName(c.x, c.y, lms)}` : "";
  return (
    `${c.count} of your ${total} deaths happened within a stone's throw of each other${where} — ` +
    `${Math.round(c.share * 100)}% of them in one place, which is a positioning habit rather than ` +
    `bad luck.${cost}`
  );
}

/** Total seconds the player spent dead, when durations were reported. This is the number that makes
 * deaths concrete: it converts a count into lost time, which is lost farm. */
export function timeDead(deaths: MatchDeath[]): number | null {
  const known = deaths.filter((d) => d.death_duration_s != null);
  if (known.length === 0) return null;
  return known.reduce((s, d) => s + (d.death_duration_s ?? 0), 0);
}
