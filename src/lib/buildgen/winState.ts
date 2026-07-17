// Win-state character (win-more vs comeback) and the per-phase tempo guidance derived from it.

import type { BuildItem, BuildPhase } from "../../types";

// Raw vs adjusted win-rate gap that flags a pick's win-state character: raw ≫ adj ⇒ "win more" (the win
// rate leans on already being ahead), adj ≫ raw ⇒ "comeback" (holds up when bought from behind). Only on a
// pick that's at least roughly viable — a clear loser tagged "win more" would read as a snowball option
// when it's just bad and correlated with leads.
export const WIN_STATE_GAP = 0.035;
export const WIN_STATE_WR_FLOOR = 0.03;
export type WinState = "winmore" | "comeback";

/** Roster-wide purchase-context measurement for one item, from the nightly wp-stats bake (see
 * api/wpStats): `wpBuy` = mean win probability at the moment it's bought, `excess` = its buyers'
 * outcomes minus that. Direct measurement of the same character the raw-vs-adjusted gap infers. */
export interface LabWinState {
  wpBuy: number;
  excess: number;
}

// Lab-evidence cutoffs. wpBuy is centered near 0.50 by construction; T4 items average ~0.56 purely
// because expensive items are bought when ahead, so "characteristically bought ahead" starts above
// that (0.57), and "bought from behind" well below the center (0.49 — Metal Skin sits at 0.43).
// The excess sign must AGREE (flattered when bought ahead / holds up when bought behind); when the
// two lab signals disagree we stay quiet rather than guess.
export const LAB_WPBUY_AHEAD = 0.57;
export const LAB_WPBUY_BEHIND = 0.49;
export const LAB_EXCESS_MIN = 0.005;

/** A pick's win-state character. Primary evidence is the hero-conditional raw vs adjusted
 * (wealth-corrected) win-rate gap; when that gap is within noise, the roster-wide lab measurement
 * (win probability at buy + outcome vs it) can still supply a tag — it's a direct reading of the
 * same "bought ahead / bought behind" character, just not hero-specific. Undefined when neither
 * source is confident or the pick isn't viable enough to read as a snowball/comeback option. */
export function classifyWinState(
  rawWr: number,
  adjWr: number,
  baseline: number,
  lab?: LabWinState,
): WinState | undefined {
  if (adjWr < baseline - WIN_STATE_WR_FLOOR) return undefined; // a clear loser isn't "win more", just bad
  const gap = rawWr - adjWr;
  if (gap >= WIN_STATE_GAP) return "winmore";
  if (gap <= -WIN_STATE_GAP) return "comeback";
  if (lab) {
    if (lab.wpBuy >= LAB_WPBUY_AHEAD && lab.excess <= -LAB_EXCESS_MIN)
      return "winmore";
    if (lab.wpBuy <= LAB_WPBUY_BEHIND && lab.excess >= LAB_EXCESS_MIN)
      return "comeback";
  }
  return undefined;
}

/** Per-phase tempo guidance: what to do when you're ahead of (or behind) the phase's soul pace. */
export interface PhaseTempo {
  /** Ahead of pace: pull these later-core picks forward now instead of adding a situational — the
   * phase's "rush if ahead" picks (`coreRush`). */
  rush: BuildItem[];
  /** Behind: favor these — they hold up bought from behind ("comeback": adj ≫ raw). */
  lean: BuildItem[];
  /** Behind: these lean on already being ahead ("win more": raw ≫ adj), so they're the riskier spend. */
  hold: BuildItem[];
}

const TEMPO_LIST_MAX = 3; // cap each tempo list so a phase stays a glance, not a paragraph

/**
 * Tempo guidance for one phase, derived purely from signals already on the build — no new data. If you're
 * *ahead* of the phase's soul pace, the cleanest spend is to pull a later-core pick forward (its
 * `coreRush` picks) rather than add another situational; if you're *behind*, favor the resilient
 * "comeback" picks and treat the snowbally "win-more" ones as the riskier buy. Returns null when no list
 * has confident signal, so a phase stays quiet rather than inventing advice (signal high, noise low). Pure.
 */
export function phaseTempo(
  phase: BuildPhase,
  baseline: number,
  labOf?: (itemId: number) => LabWinState | undefined,
): PhaseTempo | null {
  const rush = phase.situational
    .filter((b) => b.coreRush && b.coreLater)
    .sort((a, b) => b.adjustedWinRate - a.adjustedWinRate)
    .slice(0, TEMPO_LIST_MAX);

  const all = [...phase.core, ...phase.situational];
  const byState = (want: WinState, strength: (b: BuildItem) => number) =>
    all
      .filter(
        (b) =>
          classifyWinState(
            b.rawWinRate,
            b.adjustedWinRate,
            baseline,
            labOf?.(b.item.id),
          ) === want,
      )
      .sort((a, b) => strength(b) - strength(a))
      .slice(0, TEMPO_LIST_MAX);
  const lean = byState("comeback", (b) => b.adjustedWinRate - b.rawWinRate);
  const hold = byState("winmore", (b) => b.rawWinRate - b.adjustedWinRate);

  if (!rush.length && !lean.length && !hold.length) return null;
  return { rush, lean, hold };
}
