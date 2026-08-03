// Soul pace: the ladder's net-worth curve for a (hero, rank), and where one game falls off it.
//
// This is the diagnosis half of the app. The fundamentals card answers "is your farm good?" with a
// single whole-game percentile, and a single number is exactly what hides the thing worth knowing:
// a player who wins lane at p60 and then flatlines at p18 once the map opens has the same souls/min
// average as one who is mediocre throughout, and a completely different problem. So the ladder is
// read per PHASE, on the same 600s columns the build itself is filled against (lib/phases), and the
// weakest phase is named.
//
// Two honesty rules, both inherited from how the norms are baked (scripts/bake-wp-stats.mjs):
//  - LEVELS ARE SURVIVORSHIP-BIASED. A tick is only recorded for games that reached it, so the late
//    band describes long games — a closer-fought subset. Fine for "am I on pace at 20 minutes",
//    wrong for "the average game has this much at 36". The UI says which it is.
//  - RATES ARE DESCRIPTIVE, NOT CAUSAL. Farming more in a phase does not cause wins at a fixed
//    total net worth; the measured gradient is ~0. A weak phase is a place to LOOK, not a lever
//    with a win rate attached. Nothing here returns a win probability, deliberately.

import type { WpStats } from "../api/wpStats";
import { PHASE_LABELS } from "./phases";
import { placeOnGrid, TIER_FALLBACK_OFFSETS } from "./matchAnalysis";

/** One baked tick of the ladder's level curve. `lv` is null when the tick was under the bake's
 * sample floor — the arrays stay index-aligned with the shared axis rather than shifting. */
export interface PaceTick {
  /** Game time, seconds. */
  t: number;
  n: number;
  /** Net worth at the cell's level percentiles, or null under the sample floor. */
  lv: number[] | null;
  /** Mean net worth here among games this hero WON / LOST. The pace gap, not a percentile. */
  won: number | null;
  lost: number | null;
}

/** One phase window of the ladder's income rates. */
export interface PaceWindow {
  fromS: number;
  toS: number;
  /** The build column this window is: "Lane", "Early mid", "Mid", "Late". */
  label: string;
  n: number;
  /** Souls/min at the cell's rate percentiles, or null under the sample floor. */
  p: number[] | null;
}

export interface PaceProfile {
  /** Tier the norms are actually from — may differ from the requested one (see `substituted`). */
  tier: number;
  substituted: boolean;
  ticks: PaceTick[];
  windows: PaceWindow[];
  levelPcts: number[];
  ratePcts: number[];
}

/**
 * The ladder's pace curve for a hero at a rank, or null when nothing is baked within
 * {@link TIER_FALLBACK_OFFSETS} of it — the same ±2 policy the farm norms use, and for the same
 * reason: pace drifts hard across ranks, so borrowing from four tiers away would mislead.
 *
 * Returns null (not an empty profile) when the `pace` block is absent entirely, which is the state
 * of every deployed build until the first bake that emits it. Every caller must hide on null.
 */
export function paceProfile(
  wp: WpStats | null,
  heroId: number,
  tier: number,
): PaceProfile | null {
  const pace = wp?.pace;
  if (!pace) return null;

  let usedTier = tier;
  let cell: (typeof pace.cells)[string] | undefined;
  for (const off of TIER_FALLBACK_OFFSETS) {
    const t = tier + off;
    if (t < 0 || t > 11) continue;
    const c = pace.cells[`${heroId}:${t}`];
    if (c) {
      cell = c;
      usedTier = t;
      break;
    }
  }
  if (!cell) return null;

  const ticks: PaceTick[] = pace.ticksS.map((t, i) => ({
    t,
    n: cell.n[i] ?? 0,
    lv: cell.lv[i] ?? null,
    won: cell.won[i] ?? null,
    lost: cell.lost[i] ?? null,
  }));
  const windows: PaceWindow[] = pace.windowsS.map((w, i) => ({
    fromS: w[0],
    toS: w[1],
    label:
      PHASE_LABELS[i] ??
      `${Math.round(w[0] / 60)}–${Math.round(w[1] / 60)} min`,
    n: cell.wn[i] ?? 0,
    p: cell.rt[i] ?? null,
  }));
  // A cell with no usable tick AND no usable window is not a profile, it's noise that happened to
  // be keyed.
  if (!ticks.some((t) => t.lv) && !windows.some((w) => w.p)) return null;

  return {
    tier: usedTier,
    substituted: usedTier !== tier,
    ticks,
    windows,
    levelPcts: pace.levelPcts,
    ratePcts: pace.ratePcts,
  };
}

/**
 * A net-worth lookup over a sampled series, linearly interpolated, anchored at 0 souls at t=0 and
 * clamped past the last sample. Mirrors matchAnalysis.playerNwAt but takes the bare arrays, so the
 * fetch layer can hand back twelve numbers instead of a whole match payload.
 */
export function seriesNwAt(
  times: number[],
  values: number[],
): (t: number) => number {
  const ts = [0, ...times];
  const vs = [0, ...values];
  return (t: number) => {
    if (t <= 0) return 0;
    for (let i = 1; i < ts.length; i++) {
      if (ts[i] >= t) {
        const span = ts[i] - ts[i - 1] || 1;
        return vs[i - 1] + ((t - ts[i - 1]) / span) * (vs[i] - vs[i - 1]);
      }
    }
    return vs[vs.length - 1] ?? 0;
  };
}

/** One phase of a single game, placed on the ladder. */
export interface PaceWindowRead extends PaceWindow {
  /** The player's souls/min across this window. */
  rate: number;
  /** Where that sits on the ladder at this hero + rank, [1,99]. Higher = more income. */
  percentile: number;
  /** The ladder's median rate here — the "what normal looks like" anchor. */
  median: number;
}

/**
 * Place one game's per-phase income on the ladder.
 *
 * `nwAt` is the player's net worth at a time in seconds (interpolated — see
 * matchAnalysis.playerNwAt). Windows the game did not fully play are dropped rather than scaled:
 * a game that ended at 24 minutes has no 20–30 rate, and pro-rating the part it did play would
 * report a full phase's income from a fraction of one.
 */
export function readPaceWindows(
  nwAt: (t: number) => number,
  durationS: number,
  profile: PaceProfile,
): PaceWindowRead[] {
  const out: PaceWindowRead[] = [];
  for (const w of profile.windows) {
    if (!w.p || w.toS > durationS) continue;
    const rate = ((nwAt(w.toS) - nwAt(w.fromS)) / (w.toS - w.fromS)) * 60;
    const mid = profile.ratePcts.indexOf(50);
    out.push({
      ...w,
      rate,
      percentile: Math.round(placeOnGrid(rate, profile.ratePcts, w.p)),
      median: mid >= 0 ? w.p[mid] : w.p[Math.floor(w.p.length / 2)],
    });
  }
  return out;
}

/** How far below the player's own best phase a phase has to sit before it reads as a fall-off
 * rather than ordinary variation. A single game is noisy and percentile gaps are wide; below this
 * the "weakest" phase is just the one that lost the coin flip. */
export const FALLOFF_GAP = 25;

/** A phase weak enough in absolute terms to name on its own, even with nothing to contrast it
 * against — bottom-quartile income for the rank. */
export const WEAK_PACE_PERCENTILE = 30;

export interface PaceDiagnosis {
  /** The phase to look at. */
  weakest: PaceWindowRead;
  /** The player's strongest phase, when there is a real spread to contrast against. */
  strongest: PaceWindowRead | null;
  /** Percentile points between them (0 when there's no contrast). */
  gap: number;
  /** True when the read is "you fall off HERE" rather than "you're behind throughout" — the
   * distinction that decides whether the advice is about a phase or about farming generally. */
  falloff: boolean;
}

/**
 * The one phase worth naming, or null when there is nothing honest to say.
 *
 * Two different findings, and they are not the same advice:
 *  - a FALL-OFF: strong somewhere, much weaker elsewhere. The gap is the finding, and it points at
 *    a specific span of the game.
 *  - a flat deficit: weak everywhere. Naming "your worst phase" there would invent a specific
 *    problem out of a general one, so it only reports when the weakest phase is genuinely low.
 *
 * Returns null when the player is at or above the ladder throughout — the card then says so rather
 * than manufacturing a flaw, matching how climbAdvice already behaves.
 */
export function paceDiagnosis(reads: PaceWindowRead[]): PaceDiagnosis | null {
  if (reads.length === 0) return null;
  const sorted = [...reads].sort((a, b) => a.percentile - b.percentile);
  const weakest = sorted[0];
  const strongest = sorted[sorted.length - 1];
  const gap = strongest.percentile - weakest.percentile;

  if (reads.length > 1 && gap >= FALLOFF_GAP)
    return { weakest, strongest, gap, falloff: true };
  if (weakest.percentile < WEAK_PACE_PERCENTILE)
    return { weakest, strongest: null, gap: 0, falloff: false };
  return null;
}

/** Plain-language read for a diagnosis. Names the span in the same words as the build column, so
 * "your Mid is where it goes" points at a column of items the player can actually look at. */
export function paceInsight(d: PaceDiagnosis): string {
  const mins = (s: number) => Math.round(s / 60);
  const span = `${mins(d.weakest.fromS)}–${mins(d.weakest.toS)} min`;
  if (d.falloff && d.strongest)
    return (
      `Your ${d.strongest.label.toLowerCase()} is p${d.strongest.percentile} but your ` +
      `${d.weakest.label.toLowerCase()} (${span}) is p${d.weakest.percentile} — that's where the ` +
      `game leaves you, not the start of it.`
    );
  return (
    `Your ${d.weakest.label.toLowerCase()} income (${span}) is p${d.weakest.percentile} at this ` +
    `rank — ${Math.round(d.weakest.median)} souls/min is normal here.`
  );
}
