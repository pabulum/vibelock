// Shared statistical primitives. These live here (rather than in buildGenerator) because the significance
// gates are used by both the build generator and the per-enemy counters analysis.
//
// The job here is *significance*: deciding whether an observed win-rate gap is real evidence or could
// easily be sampling noise. That's a different question from "what's our best estimate of the rate"
// (the empirical-Bayes shrinkage / lower-bound machinery in buildGenerator) — so it's kept separate.

// How many sampling errors a gap must clear to count as "real, not noise". z = 1.28 is a ~90% one-sided
// bar — a genuine significance test, but deliberately gentler than the textbook 95% (z = 1.645): this is a
// build *recommender*, where hiding a plausibly-good pick (a false negative) costs the player more than
// surfacing a marginal one (a false positive), so the error trade-off favors the looser bar. Raise toward
// 1.645 for stricter, scientific-grade gates. NOTE: these gates run on many items at once, and testing many
// gaps at one threshold lets some fire by luck (the multiple-comparisons problem); controlling that
// false-discovery rate is a separate, later step.
export const GATE_Z = 1.28;

/**
 * Standard error of a win rate observed over `n` decided games — the binomial SE √(p(1−p)/n), i.e. how
 * much the measured rate would wobble from sampling alone. Returns Infinity for n ≤ 0 so an empty sample
 * never reads as certain.
 */
export function winRateSE(winRate: number, n: number): number {
  if (n <= 0) return Number.POSITIVE_INFINITY;
  return Math.sqrt((winRate * (1 - winRate)) / n);
}

/**
 * True when win rate `a` (over `na` decided games) is *both* meaningfully and significantly higher than
 * reference `b` (over `nb` games):
 *   - **effect size** — the gap clears `margin` on the point estimates (a practically meaningful difference);
 *   - **significance** — the gap is at least {@link GATE_Z} sampling errors wide (unlikely to be a fluke).
 *
 * Equivalent to requiring `a − b ≥ max(margin, GATE_Z·SE)`: a small sample needs a *bigger* observed gap
 * to pass, a large sample only needs to clear the effect floor. Pass `nb = Infinity` for a fixed,
 * well-sampled reference (e.g. the hero baseline or an aggregated lean), whose own noise is negligible.
 */
export function significantlyHigher(a: number, na: number, b: number, nb: number, margin = 0): boolean {
  if (a < b + margin) return false; // effect-size floor: clear the threshold on the point estimate first
  const se = Math.hypot(winRateSE(a, na), nb === Number.POSITIVE_INFINITY ? 0 : winRateSE(b, nb));
  if (se === 0) return true; // no sampling noise at all ⇒ the effect-size pass already settles it
  return (a - b) / se >= GATE_Z;
}
