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

/** Error function, Abramowitz & Stegun 7.1.26 rational approximation (|error| ≤ 1.5e-7) — used by the
 * normal CDF below. JS has no built-in erf. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Standard-normal CDF Φ(z): the probability a standard normal draw is ≤ z. */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * Benjamini-Hochberg false-discovery-rate control. Given p-values for many simultaneous tests, returns a
 * boolean[] (aligned to the input) marking which to call significant while keeping the *expected fraction
 * of false positives among the calls* at or below `q`.
 *
 * Why it's needed: testing m things each at level q lets ~q of all the truly-null ones fire by luck, so
 * with many tests a large share of the "discoveries" can be noise. BH adapts the bar to m: sort the
 * p-values ascending, find the largest rank k (1-based) with p(k) ≤ (k/m)·q, and accept every test with a
 * p-value at or below that one. Few tests ⇒ lenient; many ⇒ strict.
 */
export function benjaminiHochberg(pValues: number[], q: number): boolean[] {
  const m = pValues.length;
  const accept = new Array<boolean>(m).fill(false);
  if (m === 0) return accept;
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  let cutoffRank = -1; // largest 0-based rank whose p clears (k/m)·q
  for (let r = 0; r < m; r++) if (order[r].p <= ((r + 1) / m) * q) cutoffRank = r;
  for (let r = 0; r <= cutoffRank; r++) accept[order[r].i] = true; // accept all up to the cutoff
  return accept;
}
