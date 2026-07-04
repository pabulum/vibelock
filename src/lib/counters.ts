// Per-enemy "true counters": items whose win rate climbs more than the matchup as a whole
// when you face a chosen enemy. We query one enemy at a time (the caller passes per-enemy
// stats), so each item keeps a per-enemy breakdown — an item can answer Seven hard and
// Lash barely, and we show exactly that instead of blending the comp into one muddy number.
//
// Crucially we *center* each item's gain on the general matchup lean: if the hero is just
// favored vs an enemy, every item's win rate floats up by roughly the same amount, and
// tagging all of them is noise. The signal is the item that beats that lean — so we
// subtract the sample-weighted mean shift and keep the item's *centered* edge.
//
// The lean is estimated PER GAME PHASE (the same buy-time buckets as the display labels),
// shrunk toward the matchup's global lean. One number per matchup is confounded by phase for
// spike/falloff enemies: vs Seven the 30m+ bucket runs +1.1–1.7 pts above his global lean
// (he falls off late), so under a global lean every late-bought T4 stat item read as a
// "counter" merely for being bought in the phase where Seven is weak — corr(avg buy minute,
// centered edge) measured ≈ +0.72 vs Seven, and Lucky Shot/Frenzy outranked Knockdown.
// Phase-centering removes exactly that: an item now has to beat the lean *for its own buy
// phase*. See LEAN_PRIOR_K for the shrink calibration.
//
// The edge is left *diluted*, deliberately. The baseline slice includes the games that
// contain the enemy (Seven is on the enemy team in ~25% of low-rank games), so the raw delta
// understates the enemy-present-vs-absent contrast by ×(1−presence). Scaling it back up
// ("de-diluting") sounds more truthful but is wrong for every decision this number feeds:
// the item's *overall* WR already banks its counter games in proportion to presence, so
// overall WR + the diluted delta IS the conditional "WR given this comp" — the re-rank adds
// the edge onto an overall-WR ranking, and de-diluting would double-count the counter effect.
// The marks stay coherent too: "vs Seven this item beats its expected showing by +X" is a
// statement made entirely inside vs-Seven games.
//
// Ranking the centered edge — recall over precision. This is a build *recommender*: hiding a
// plausibly-good counter (a false negative) costs the player more than surfacing a marginal one,
// so we mirror the build generator's machinery (empirical-Bayes shrinkage + lower-confidence-bound,
// see buildGenerator.ts) rather than a hard significance gate. Two reasons this beats the old
// whole-grid Benjamini-Hochberg FDR gate it replaces:
//   1. FDR is precision-oriented — it controls the *share of fluke marks*, the opposite trade from
//      the rest of this app (which deliberately runs a loose z = 1.28 bar to favor recall). On a big
//      grid of mostly-null tests, a lone real counter needed a ~13-pt edge at n≈150 to clear it, so
//      almost nothing surfaced.
//   2. It didn't even help the common case. When you select a single tough enemy, the "whole grid"
//      *is* just that one enemy's items — per-enemy FDR families would change nothing there. The gate
//      itself was the problem, not the family size.
// The shrink+lower-bound is still honest about noise: a thin sample has a wide interval and a low
// bound, so it self-rejects — we get recall without minting flukes. Thin marks are flagged for the UI.

import type { ItemCounters, Item, ItemStat } from "../types";
import { GATE_Z } from "./stats";

const PHASE_BOUNDS_S = [540, 1200, 1800]; // 9m / 20m / 30m
const PHASE_LABELS = ["Lane", "Early mid", "Mid", "Late"];

const MIN_SAMPLE = 50; // candidacy floor: below this a cell can't inform the lean or earn a mark. Kept low
// because the shrink + lower-bound below does the real noise control — it's not a hard significance cutoff.
const LOW_SAMPLE = 150; // below this, show but flag as shaky
const MIN_EDGE = 0.01; // effect floor: the *shrunk* edge must still clear ~1 pt to be worth surfacing
// (a confident-but-trivial edge isn't a counter). Calibrated to the real scale of single-item counter
// effects: phase-centered, the best item vs a given enemy measures ≈ +2 pts and genuine answers like
// Knockdown vs low-rank Seven sit at +1–2, so the old 1.5-pt floor cut away much of the true range.
// 1 pt = one extra win per hundred games from a single slot. The confidence bar (GATE_Z · sd) is
// separate and untouched — thin samples still self-reject.
const COUNTER_PRIOR_K = 60; // empirical-Bayes prior strength, in "equivalent games", for shrinking each
// centered edge toward 0 (the null "no counter"). ~60 games of evidence before we trust an edge: thin
// cells get pulled to ~no-edge, well-sampled ones keep theirs. Lower ⇒ more recall (trust small samples
// sooner); higher ⇒ more caution. Modest on purpose — the lower-confidence bound is the main guard.
const LEAN_PRIOR_K = 40_000; // prior strength (in slot-samples) for shrinking each phase bucket's lean
// toward the matchup's global lean. The phase gradient is real but ENEMY-SPECIFIC — measured 2026-07
// (5 enemies × 2 rank bands, aggregate N so the offsets are noise-free): Seven's late bucket +1.1/+1.7 pt
// (falls off), Haze at high ranks −1.4 pt late (scales), Abrams/Lash/Vindicta ≈ flat ±0.1 — so thin
// buckets must not be allowed to invent a gradient that mostly doesn't exist. Derived like EDGE_PRIOR_K:
// K = c·p(1−p)/τ² with τ ≈ 0.43 pt (RMS true bucket offset across those 40 bucket measurements) and
// c ≈ 3 for within-game clustering — one game lands ~3 of the hero's item-cells in the same bucket, all
// sharing that game's outcome, so a slot-sample carries ~1/3 of an independent game's information.
// 3 × 0.25/0.0043² ≈ 40k. A bucket with no weight, or far under K, just uses the global lean — the
// pre-phase behavior — so this strictly refines, never degrades, the centering.
const EDGE_PRIOR_K = 4000; // prior strength for the comp-edge RANKING pathway — much stiffer than the
// marks' K, because no downstream confidence gate protects the re-rank: the posterior mean must be honest
// on its own. Derived, not tuned: K = p(1−p)/τ_c², where τ_c is the TRUE cross-item spread of per-enemy
// centered edges, measured as the cross-half covariance of edges over two disjoint time halves (noise is
// independent across halves, so it cancels in the covariance — immune to the correlated-SE problem where
// item cells share matches). Measured over Paradox and Seven vs 5 enemies each (Emissary+, ~5-week
// halves): τ_c ≈ 0.6–1.2pt with a couple of enemies at ~0 (vs Abrams/Geist item choice barely moves WR);
// median ≈ 0.8pt ⇒ K ≈ 0.25/0.008² ≈ 3,900. Raw sums without this shrink split-half replicate at only
// r ≈ 0.14 — i.e. mostly noise — so the shrink is what makes ranking on the sum defensible. (τ_c was
// measured under the old global-lean centering; phase-centering removes some spurious cross-item spread,
// so if anything τ_c is now a touch smaller and this K errs slightly loose — acceptable, recall-first.)

/** An item's signed comp edge with its sampling error, so downstream decisions (the build
 * re-rank's "weak vs comp" demote) can require *confidence*, not just a threshold on the
 * point estimate. The edge is the SUM of the per-enemy shrunk centered edges (see below for
 * why sum, not mean), so `se` sums the variances too: √(Σ nᵢ·pᵢ(1−pᵢ)/(nᵢ+K)²) — more
 * enemies means a bigger possible edge *and* more accumulated noise, and the demote gate
 * pays for both. */
export interface CompEdge {
  edge: number;
  se: number;
}

/** Join per-enemy item stats to the baseline. Returns:
 *  - `counters`: one entry per item that genuinely over-performs vs ≥1 enemy (above that
 *    enemy's matchup lean), with per-enemy marks (strongest first) — for the build tags.
 *  - `edgeByItem`: every item's *signed* comp edge with its standard error — used to re-rank
 *    the build for the comp and to gate the "weak vs comp" demote on significance.
 *
 * The comp edge is the SUM of the per-enemy shrunk centered edges, not their mean. Each
 * per-enemy edge is a conditional measured in real games where that enemy was 1-of-6 (the
 * exposure dilution is already priced into the conditional), and centering on the matchup
 * lean removes the background contribution of typical co-occurring enemies — so under an
 * additive model, summing the centered conditionals approximates conditioning on the whole
 * selected comp. A mean would cap a full 6-enemy team at single-matchup scale: three enemies
 * your item answers at +2 pts each should read +6, not +2. Enemies below the sample floor
 * contribute 0 (the shrink null), so partial coverage degrades conservatively, and each
 * cell is shrunk toward 0 by K games *before* summing so one thin cell can't swing the total. */
export function computeItemCounters(
  baseline: ItemStat[],
  perEnemy: Array<{ enemyHeroId: number; stats: ItemStat[] }>,
  items: Map<number, Item>,
): { counters: ItemCounters[]; edgeByItem: Map<number, CompEdge> } {
  const baseWr = new Map<number, number>();
  for (const r of baseline) {
    const n = r.wins + r.losses;
    if (n > 0) baseWr.set(r.item_id, r.wins / n);
  }

  const byItem = new Map<number, ItemCounters>();
  const edgeSum = new Map<number, number>(); // Σ over enemies of the shrunk centered edge
  const edgeVarSum = new Map<number, number>(); // Σ of each shrunk edge's variance
  for (const { enemyHeroId, stats } of perEnemy) {
    // Pass 1: raw deltas for every item over the sample floor, plus the matchup lean
    // (sample-weighted mean shift) — what an "average" item does vs this enemy — both
    // globally and per buy-time phase bucket.
    const raw: Array<{
      item: Item;
      winRate: number;
      rawDelta: number;
      n: number;
      buyT: number;
    }> = [];
    let shiftSum = 0;
    let shiftWeight = 0;
    const bucketShiftSum = new Array<number>(PHASE_LABELS.length).fill(0);
    const bucketShiftWeight = new Array<number>(PHASE_LABELS.length).fill(0);
    for (const r of stats) {
      const n = r.wins + r.losses;
      if (n < MIN_SAMPLE) continue;
      const item = items.get(r.item_id);
      const base = baseWr.get(r.item_id);
      if (!item || base === undefined) continue;
      const winRate = r.wins / n;
      const rawDelta = winRate - base;
      raw.push({ item, winRate, rawDelta, n, buyT: r.avg_buy_time_s });
      shiftSum += rawDelta * n;
      shiftWeight += n;
      const b = bucketForTime(r.avg_buy_time_s);
      bucketShiftSum[b] += rawDelta * n;
      bucketShiftWeight[b] += n;
    }
    const globalLean = shiftWeight > 0 ? shiftSum / shiftWeight : 0;
    // Each phase's lean, shrunk toward the global lean by LEAN_PRIOR_K: well-fed buckets keep
    // their measured phase offset (Seven's late-game falloff), thin ones fall back to the
    // matchup-wide lean rather than minting a gradient from noise.
    const leanByBucket = bucketShiftSum.map((sum, b) => {
      const w = bucketShiftWeight[b];
      if (w <= 0) return globalLean;
      return globalLean + (w / (w + LEAN_PRIOR_K)) * (sum / w - globalLean);
    });

    // Pass 2: the centered edge per item — each item against the lean *for its own buy phase*.
    // Accumulate the signed average (all items, for the build re-rank), then shrink each edge toward
    // the "no counter" null and keep it only if we're confident (lower bound positive) *and* it's
    // practically meaningful (shrunk edge ≥ the effect floor).
    for (const x of raw) {
      const edge = x.rawDelta - leanByBucket[bucketForTime(x.buyT)];
      // Empirical-Bayes shrink toward 0 (prior = no counter, worth COUNTER_PRIOR_K games), then a
      // lower-confidence bound on the edge: shrunk mean − GATE_Z posterior SDs. The edge's noise is the
      // per-enemy mark's binomial SE — the reference (item's overall WR + the bucket lean) is a large
      // aggregate whose own noise is negligible: the LEAN_PRIOR_K shrink bounds a thin bucket's residual
      // lean error near τ ≈ 0.4 pt, an order under the item SE at the sample floor (~5 pts at n = 50).
      // Regularized by the prior to concentration n + K; mirrors buildGenerator's shrinkToBaseline /
      // lowerConfidenceWinRate, but on the centered edge.
      const shrunkEdge = (x.n * edge) / (x.n + COUNTER_PRIOR_K);
      // Comp edge: sum this enemy's shrunk edge into the item's total — with the stiff
      // EDGE_PRIOR_K, not the marks' loose K (see the constants). Var of the shrunk mean
      // by the delta method: (n/(n+K))²·p(1−p)/n = n·p(1−p)/(n+K)².
      edgeSum.set(
        x.item.id,
        (edgeSum.get(x.item.id) ?? 0) + (x.n * edge) / (x.n + EDGE_PRIOR_K),
      );
      edgeVarSum.set(
        x.item.id,
        (edgeVarSum.get(x.item.id) ?? 0) +
          (x.n * x.winRate * (1 - x.winRate)) / (x.n + EDGE_PRIOR_K) ** 2,
      );

      const sd = Math.sqrt(
        (x.winRate * (1 - x.winRate)) / (x.n + COUNTER_PRIOR_K + 1),
      );
      // Effect floor *and* confidence in one bar (the significantlyHigher idiom): a small sample needs a
      // bigger observed edge to clear GATE_Z·sd, a large one only needs to clear the effect floor.
      if (shrunkEdge < Math.max(MIN_EDGE, GATE_Z * sd)) continue;

      let entry = byItem.get(x.item.id);
      if (!entry) {
        entry = {
          item: x.item,
          phaseLabel: phaseForTime(x.buyT),
          marks: [],
          topDelta: 0,
        };
        byItem.set(x.item.id, entry);
      }
      entry.marks.push({
        enemyHeroId,
        winRate: x.winRate,
        delta: shrunkEdge,
        // Backfill-blended rows carry fractional effective samples; round for display.
        sample: Math.round(x.n),
        lowSample: x.n < LOW_SAMPLE,
      });
      entry.topDelta = Math.max(entry.topDelta, shrunkEdge);
    }
  }

  // Each per-enemy cell was already shrunk toward 0 before summing, so the total needs no
  // second shrink; the summed SE keeps the demote gate honest as enemies stack up.
  const edgeByItem = new Map<number, CompEdge>();
  for (const [id, s] of edgeSum)
    edgeByItem.set(id, {
      edge: s,
      se: Math.sqrt(edgeVarSum.get(id) ?? 0),
    });

  const counters = [...byItem.values()];
  for (const e of counters) e.marks.sort((a, b) => b.delta - a.delta);
  counters.sort((a, b) => b.topDelta - a.topDelta);
  return { counters, edgeByItem };
}

function bucketForTime(s: number): number {
  let i = 0;
  while (i < PHASE_BOUNDS_S.length && s >= PHASE_BOUNDS_S[i]) i++;
  return i;
}

function phaseForTime(s: number): string {
  return PHASE_LABELS[bucketForTime(s)];
}
