// Lane matchups: who actually beats you in the 2v2, in souls.
//
// This is the read hero-counter-stats cannot give. That endpoint is whole-game presence — "this
// hero was on the enemy team" — which conflates a lane bully with a late-game problem, and the two
// have opposite answers (one changes how you play the first ten minutes, the other changes what you
// build for the last ten). The lane number comes from `assigned_lane` in the harvested shards and
// is a genuine soul differential at the 10-minute mark.
//
// The number to read is the RESIDUAL, not the raw differential. Lanes are 2v2, so a raw "hero A vs
// hero B" figure carries both lane partners and mostly restates how well each hero farms — measured
// on a full day, an additive per-hero lane-strength fit absorbs ~76% of the raw variance (sd 438
// souls raw → 105 residual). Reporting the raw number would rediscover "Seven farms well" once per
// opponent, which is exactly the mistake Bradley-Terry de-noising fixes for the counter matrix
// (lib/matchups). The bake does the fit; this file reads what survived it.

import type { WpStats } from "../api/wpStats";

/** Souls of residual before a matchup is worth showing. At the 10-minute tick a player holds
 * roughly 9,000 souls, so this is ~1.7% of net worth — about a third of a tier-1 item, and a bit
 * over one standard deviation of the residual distribution. Below it the "matchup" is the fit's
 * noise floor rather than rock-paper-scissors. */
const MIN_EDGE = 150;

/** Pairs thinner than this are dropped even though the bake already applies its own floor — the
 * bake's floor decides what is worth SHIPPING, this one decides what is worth SHOWING. */
const MIN_SAMPLE = 400;

const TOP = 5;

export interface LaneRead {
  enemyHeroId: number;
  n: number;
  /** Observed soul differential at the tick, positive = you ahead. Context only; it mostly
   * measures the two heroes' farming, which is why `resid` exists. */
  rawDiff: number;
  /** What survives removing both heroes' fitted lane strengths — the matchup itself. */
  resid: number;
}

export interface LaneMatchups {
  /** Game time the differential is measured at, seconds. */
  tickS: number;
  /** This hero's own fitted lane strength in souls, centred on 0 across the roster. Positive =
   * out-farms the average laner regardless of opponent. */
  strength: number;
  /** Enemies whose residual is meaningfully against you, worst first. */
  hard: LaneRead[];
  /** Enemies you beat beyond what farming alone explains, best first. */
  good: LaneRead[];
}

/**
 * The selected hero's notable lane matchups, or null when the bake carries no lane block — the
 * state of every deployed build until the first bake that emits one, so callers must hide on null.
 */
export function laneMatchups(
  wp: WpStats | null,
  heroId: number,
): LaneMatchups | null {
  const lane = wp?.lane;
  if (!lane) return null;
  const row = lane.matchups[String(heroId)];
  if (!row) return null;

  const all: LaneRead[] = [];
  for (const [enemy, tuple] of Object.entries(row)) {
    const [n, rawDiff, resid] = tuple;
    if (n < MIN_SAMPLE) continue;
    all.push({ enemyHeroId: Number(enemy), n, rawDiff, resid });
  }

  return {
    tickS: lane.tickS,
    strength: lane.strengths[String(heroId)] ?? 0,
    hard: all
      .filter((m) => m.resid <= -MIN_EDGE)
      .sort((a, b) => a.resid - b.resid)
      .slice(0, TOP),
    good: all
      .filter((m) => m.resid >= MIN_EDGE)
      .sort((a, b) => b.resid - a.resid)
      .slice(0, TOP),
  };
}

/** The lane read for one specific enemy, whether or not it clears the display thresholds — used to
 * annotate an enemy the player has already picked, where "this matchup is even" is a real answer
 * and hiding the row would read as missing data. Null when the pair was never baked. */
export function laneReadFor(
  wp: WpStats | null,
  heroId: number,
  enemyHeroId: number,
): LaneRead | null {
  const tuple = wp?.lane?.matchups[String(heroId)]?.[String(enemyHeroId)];
  if (!tuple) return null;
  const [n, rawDiff, resid] = tuple;
  return { enemyHeroId, n, rawDiff, resid };
}

/** Whether a residual is big enough to act on — shared with the UI so the "even" wording and the
 * hard/good lists can never disagree about where the line is. */
export function laneEdgeIsReal(resid: number): boolean {
  return Math.abs(resid) >= MIN_EDGE;
}

/**
 * Plain-language read for one lane matchup. Deliberately never says "you win this lane": the
 * residual is a soul differential, not a win rate, and the honest instruction is about how to play
 * the first ten minutes rather than a predicted outcome.
 */
export function laneInsight(read: LaneRead, enemyName: string): string {
  if (!laneEdgeIsReal(read.resid))
    return `${enemyName} is an even lane — ${signed(read.resid)} souls at 10 min once farming ability is removed.`;
  return read.resid < 0
    ? `${enemyName} beats you in lane by ${Math.abs(read.resid)} souls at 10 min beyond what farming explains — play it safe and scale.`
    : `You out-lane ${enemyName} by ${read.resid} souls at 10 min beyond farming — take the early tempo.`;
}

const signed = (n: number) =>
  `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n)}`;

/** How the hero lanes in general, independent of opponent. Positive strengths out-farm the roster
 * average; the wording avoids "good/bad" because a weak laning scaler is not a weak hero. */
export function laneStrengthNote(strength: number, heroName: string): string {
  if (Math.abs(strength) < 100)
    return `${heroName} lanes about average — ${signed(strength)} souls at 10 min vs the roster.`;
  return strength > 0
    ? `${heroName} out-farms the average laner by ${strength} souls at 10 min.`
    : `${heroName} farms ${Math.abs(strength)} souls behind the average laner at 10 min — the lane is not where this hero wins.`;
}
