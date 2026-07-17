// Statistical scoring & admission gates for the build generator: the empirical-Bayes shrinkage
// machinery, the lower-confidence-bound ranking, the discretionary core score, and the value /
// buyer-contrast gates. Pure functions of win-rate numbers — no phase or slot bookkeeping here.

import type { BuildItem } from "../../types";
import { significantlyHigher } from "../stats";

// --- Tuning knobs (top of module on purpose; no math needed to adjust) ---
export const MIN_SUPPORT_ABS = 40; // ignore items bought by fewer than this many players
export const MIN_SUPPORT_FRAC = 0.03; // ...or fewer than 3% of the phase's players
export const UNIVERSAL_PICK = 0.3; // ≥30% pick rate ⇒ "build it every game"
export const VALUE_EDGE = 0.02; // value/situational picks must beat the baseline by ≥2 pts — *and* significantly
// so (see isValuePick): a +2pt blip on a thin sample isn't a real edge, so the gap must also clear the
// sampling noise, not just the point cutoff.
export const FILL_WR_FLOOR = 0; // the category ratio is a *soft* bias, not a hard quota: a discretionary
// (sub-universal) pick is only slotted to serve its category's share if it at least breaks even
// (≥ baseline − this). Below that the share yields the slot to a category that *has* a pick worth
// building — encoding "the players who buy it here may simply be wrong." So when every spirit option
// in a phase loses (Paradox lane: Extra Spirit −1.5pt, Mystic Burst −0.5pt), spirit takes no slot and
// the freed slot buys a winning weapon/green instead. Universals bypass this — an everyone-builds
// staple is the backbone even when its raw WR trails (Headshot Booster, 67% pick). Loosen toward a
// small positive tolerance to let near-baseline pickups hold category slots again.

// --- Win-rate core ---
// The discretionary core slots (everything below the genuine ~30%+ universals) are ranked by adjusted
// win rate, shrunk toward baseline by sample (empirical Bayes — see shrinkToBaseline / priorStrength) so a
// thin-pick shiny WR can't outrank a proven pick — the build tilts toward what wins, not merely what's
// popular. Genuine universals are left alone — they're mandatory and sit ~baseline anyway.
const CORE_POP_TILT = 0.3; // mild *multiplicative* popularity bonus on the WR edge (up to +CORE_POP_TILT for a
// 100%-pick item) — a co-occurrence/robustness tiebreak that keeps a widely-bought pick ahead of an equal rarity.
export const SYNERGY_WEIGHT = 0.5; // how much a discretionary pick's *synergy with the already-committed build*
// counts toward its core ranking (#5/#6). The bonus is Σ centered+shrunk pairwise synergy with owned items
// (see lib/synergy.ts), a win-rate-scale quantity added to the edge: ±1.4pt typical, up to ±3.5pt for a
// strong combo, against ~±2–5pt edges — a real tiebreak that tips close calls toward items that reinforce
// the build, but can't override a clearly-better pick or seat one that fails the break-even gate. 0 = off.

// --- Empirical-Bayes shrinkage (toward the hero's baseline win rate) ---
// An item's win rate is shrunk toward baseline by a weighted average with the baseline standing in as a
// prior worth `K` games of evidence: shrunk = (n·wr + K·baseline) / (n + K), where n is the item's decided
// games. Few games ⇒ pulled to baseline; many ⇒ trusted. K isn't hand-tuned — priorStrength learns it from
// how spread out *this hero's* item win rates actually are (wide spread ⇒ real differences ⇒ trust items
// more ⇒ small K; everything bunched at baseline ⇒ differences are noise ⇒ shrink hard ⇒ large K). This
// replaces the old pickRate/(pickRate+half) proxy: it shrinks by the actual win/loss count, not popularity.
const EB_MIN_SAMPLE = MIN_SUPPORT_ABS; // items with fewer decided games than this don't inform the prior fit
const EB_MIN_ITEMS = 8; // need at least this many items to estimate a spread; below it use the default K
export const EB_DEFAULT_K = 300; // fallback prior strength when the spread can't be estimated (~300 games to trust an item)
const EB_MIN_K = 25; // clamp so a freak-wide spread can't make us trust a 40-game item outright
const EB_MAX_K = 4000; // ...or a freak-tight one shrink everything flat to baseline

/** Empirical-Bayes prior mean of an item's win rate: a weighted average of its observed (adjusted) rate
 * and the hero baseline, where the baseline carries the weight of `k` games. `n` = the item's decided
 * games. n≫k ⇒ ≈ the item's own rate; n≪k ⇒ ≈ baseline; n=k ⇒ exactly halfway. */
function shrinkToBaseline(
  winRate: number,
  n: number,
  baseline: number,
  k: number,
): number {
  return (n * winRate + k * baseline) / (n + k);
}

// How many posterior standard deviations below the mean we *rank* by. The shrinkage (mean) already pulls
// thin picks toward baseline; this adds a modest "lean conservative" discount for how *uncertain* an item
// still is, so a proven pick edges out an equally-rated shakier one. ~1 SD ≈ an 84% one-sided floor — a
// gentle nudge, not a hard cutoff (raise toward 1.645 for a stricter 95% floor, toward 0 to rank by the
// mean alone). Hard yes/no gates that need real significance are a separate step (see #3).
const RANK_CONFIDENCE_Z = 1.0;

/**
 * Lower confidence bound on an item's win rate — the win rate we're fairly sure it *at least* has. It's
 * the empirical-Bayes posterior mean ({@link shrinkToBaseline}) minus {@link RANK_CONFIDENCE_Z} posterior
 * standard deviations. The posterior is a Beta with concentration (n + k), so its spread is
 * √(mean·(1−mean)/(n+k+1)): more decided games or a stronger prior ⇒ tighter interval ⇒ bound nearer the
 * mean; a thin-sample pick has a wide interval and a low bound. Ranking by this prefers proven picks over
 * small-sample shines, with both the shrink *and* the uncertainty baked into one number. (Same posterior
 * as #1 — that read the mean; this reads its lower edge.)
 */
export function lowerConfidenceWinRate(
  winRate: number,
  n: number,
  baseline: number,
  k: number,
): number {
  const mean = shrinkToBaseline(winRate, n, baseline, k);
  const sd = Math.sqrt((mean * (1 - mean)) / (n + k + 1));
  return mean - RANK_CONFIDENCE_Z * sd;
}

/**
 * A "value" pick: confidently — and meaningfully — above baseline. The adjusted WR must clear baseline by
 * VALUE_EDGE *and* the gap must be wide relative to the item's sampling noise (see {@link significantlyHigher}),
 * so a small-sample +2pt blip isn't promoted to a real edge. Used for the value/filler label and the
 * situational/staple gates. The baseline is treated as a fixed reference — it's the whole-population win
 * rate, so its own sampling noise is negligible next to a single item's.
 */
export function isValuePick(b: BuildItem, baseline: number): boolean {
  return significantlyHigher(
    meritWr(b),
    b.decided,
    baseline,
    Number.POSITIVE_INFINITY,
    VALUE_EDGE,
  );
}

/** The win rate to rank/gate a pick by: its {@link BuildItem.rankWinRate} when line-aware generation has
 * set one (survivorship-shrunk toward the component), else its plain adjusted win rate. Display always
 * reads `adjustedWinRate` directly, so shrinking never changes the number the player sees. */
export function meritWr(b: BuildItem): number {
  return b.rankWinRate ?? b.adjustedWinRate;
}

/**
 * Empirical-Bayes prior strength K, in "equivalent games", learned from the spread of this hero's item
 * win rates. The observed spread of item win rates around baseline is part real (items differ) and part
 * noise (each item has a finite sample, so its rate wobbles even if its true rate is baseline). We
 * subtract the expected noise to recover the *real* between-item variance, then convert it to K via the
 * Beta relationship K = baseline·(1−baseline)/variance − 1. Wide real spread ⇒ small K (trust items);
 * little real spread ⇒ large K (shrink hard). Falls back to EB_DEFAULT_K when there aren't enough items,
 * and clamps to [EB_MIN_K, EB_MAX_K] so a freak sample can't push the build to one extreme.
 */
export function priorStrength(
  rates: Array<{ winRate: number; decided: number }>,
  baseline: number,
): number {
  const pts = rates.filter((r) => r.decided >= EB_MIN_SAMPLE);
  if (pts.length < EB_MIN_ITEMS) return EB_DEFAULT_K;
  const m = baseline;
  // Total spread of the observed win rates around baseline...
  const observedVar =
    pts.reduce((s, r) => s + (r.winRate - m) ** 2, 0) / pts.length;
  // ...minus the part that's just finite-sample coin-flip noise (a baseline-rate item over n games has
  // sampling variance m(1−m)/n), averaged across items.
  const samplingVar =
    pts.reduce((s, r) => s + (m * (1 - m)) / r.decided, 0) / pts.length;
  const trueVar = observedVar - samplingVar;
  if (trueVar <= 0) return EB_MAX_K; // no real spread beyond noise ⇒ trust the baseline, not the items
  const k = (m * (1 - m)) / trueVar - 1;
  return Math.min(EB_MAX_K, Math.max(EB_MIN_K, k));
}

// Efficiency vs. per-slot power, governed by SLOT scarcity rather than time. While the build still has empty
// slots to fill, souls are the binding constraint, so a pick's WR edge is divided by its soul cost (cheaper =
// more edge per soul). But the standing build is capped (~9 base, up to SLOT_CAP with Walker kills), and once
// slots are the scarce resource two cheap items no longer beat one strong item — what matters is power *per
// slot* (raw WR). So the cost penalty fades from CORE_COST_POWER_MAX (slots empty) to 0 (slots full), driven by
// how many slots the build has already committed before the phase. This adapts per hero: a build that fills its
// slots early flips to per-slot power sooner, where the big carries win. (Set MAX to 0 to recover raw-WR core.)
const CORE_COST_POWER_MAX = 0.6;
// Committed standing slots at which soul-efficiency has fully faded to per-slot power. Set to the 9 *base*
// slots, not SLOT_CAP (12): the 3 flex slots are earned (Walker kills) and shouldn't be assumed, and in
// practice players hit the per-slot regime around Mid as the base slots fill (observed: 12 held by the
// Superior Cooldown / Greater Expansion window). Binding at 9 lets per-slot win rate (the big carries, and
// high-edge-but-pricey picks like Echo Shard) start deciding mid-game instead of waiting for a 12th slot
// that may never unlock. Raise toward SLOT_CAP to keep favoring cheap soul-efficient picks later.
const CORE_SLOT_TARGET = 9;

/** The efficiency weight to use for a phase, given how many standing slots are already committed. Linear fade
 * from CORE_COST_POWER_MAX (nothing committed — souls bind) to 0 (slots full — per-slot power decides). */
export function costPowerForSlots(slotsCommitted: number): number {
  return (
    CORE_COST_POWER_MAX * Math.max(0, 1 - slotsCommitted / CORE_SLOT_TARGET)
  );
}

/** Discretionary core ranking. Combines: the adjusted-WR edge over baseline measured at the item's
 * *lower confidence bound* (so a thin-pick shiny WR — shrunk toward baseline *and* discounted for its wide
 * uncertainty — can't unseat a proven pick; `k` is the learned prior strength from {@link priorStrength});
 * a mild popularity tilt; and a cost penalty whose strength (`costPower`, from {@link costPowerForSlots})
 * fades as the standing build fills — so early picks favor soul-efficiency and, once slots are scarce,
 * per-slot win rate (the big carries) decides. `costK` floors at 1 (1000 souls) so sub-1k stat-sticks get
 * no efficiency boost. `bonus` is the *already-weighted* additive edge bonus (synergy + line-aware
 * down-payment, assembled by the caller) — added straight to the edge. Higher = seat first. */
export function coreWrScore(
  b: BuildItem,
  baselineWinRate: number,
  costPower: number,
  k: number,
  bonus = 0,
): number {
  // Ordering uses the *raw* adjusted WR, not the line-shrunk meritWr: the shrink is an admission gate
  // (seatable / isValuePick), not a fine ranking signal. Shrinking here demoted mainstream upgrades below
  // their own universal components (Trophy Collector losing its slot to a terminal Sprint Boots), so let
  // the gate decide *whether* an upgrade earns a slot and this decide the order among those that do.
  const edge =
    lowerConfidenceWinRate(b.adjustedWinRate, b.decided, baselineWinRate, k) -
    baselineWinRate +
    bonus;
  const popTilt = 1 + CORE_POP_TILT * b.pickRate;
  const costK = Math.max(1, b.item.cost / 1000);
  return (edge * popTilt) / Math.pow(costK, costPower);
}

// --- The universal bypass, made falsifiable (the Headhunter fix) ---
// The pick-rate core seats near-universal items without a win-rate check, and there's a real
// mathematical reason for that: with pick rate p, the population rate decomposes as
//   baseline = p·WR(buyers) + (1−p)·WR(non-buyers)
// so an item's *observable* edge is compressed by its own popularity:
//   WR(buyers) − baseline = (1−p) · [WR(buyers) − WR(non-buyers)].
// A 90%-pick staple mathematically CANNOT show a big edge either way — judging it on that number
// is judging a measurement that can't move, which is why the bypass exists. But the same identity
// lets the bypass be *checked* instead of assumed: dividing the observed edge by (1−p) recovers
// the buyer-vs-non-buyer contrast — the quantity that means the same thing at every pick rate —
// and the bypass is revoked when buyers do significantly AND meaningfully worse than non-buyers
// (Paradox @ Emissary: Headhunter, 32% pick, −3.2pt observed ⇒ buyers ~4.7pt behind non-buyers).
// Significance is transform-invariant (the edge and its SE both divide by (1−p), so z is
// unchanged); only the effect-size margin moves to the contrast scale. Above CONTRAST_MAX_PICK the
// "non-buyer" complement stops being a real comparison population (sold slots, abandoned games,
// meme builds), so the contrast is uninterpretable and the benefit of the doubt stands — which is
// also what protects the true 60–90% staples without a special case.
const CONTRAST_MARGIN = 0.025; // buyers must run ≥2.5pt behind non-buyers (implied) to lose the seat
const CONTRAST_MAX_PICK = 0.7; // past this the non-buyer group is too weird to read

/** True when this pick's buyers do significantly and meaningfully worse than its non-buyers — the
 * evidence that revokes a popular item's core seat. See the contrast identity above. */
export function buyersLoseSignificantly(
  c: BuildItem,
  baseline: number,
): boolean {
  if (c.pickRate > CONTRAST_MAX_PICK) return false;
  // The contrast-scale margin mapped back to the observable scale the test runs on.
  const marginObs = CONTRAST_MARGIN * (1 - c.pickRate);
  return significantlyHigher(
    baseline,
    Number.POSITIVE_INFINITY,
    c.adjustedWinRate,
    c.decided,
    marginObs,
  );
}

/** The implied buyer-vs-non-buyer gap in win-rate points (positive = buyers behind), for the
 * honest "popular but losing" label on a demoted pick. Denominator floored so a data glitch at
 * pick ≈ 1 can't print a silly number. */
export function buyerContrast(c: BuildItem, baseline: number): number {
  return (baseline - c.adjustedWinRate) / Math.max(0.05, 1 - c.pickRate);
}
