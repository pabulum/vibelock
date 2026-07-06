// Backfills a young patch's flow stats with the window that preceded it, so a build generated the
// day after a patch is complete and sanely ranked instead of starved by its own significance gates.
//
// The statistical framing is a *power prior* (hierarchical borrowing across time): the pre-patch
// window is treated as prior evidence about each item, worth at most `K` decided games — where K is
// not a hand-tuned blend knob but the equivalent-sample value of "how much do item win rates actually
// move across a patch". If item WRs typically drift ~1.5pt, the old window is worth
// K = p(1−p)/σ²_drift ≈ 1,000 games per item. The blend then self-anneals with no scheduling: on day
// one the prior dominates (day-one meta ≈ old meta), and as the new patch accumulates games the
// fresh term outweighs it and the prior fades out.
//
// Two honest complications, both handled here:
//   - Items the patch actually changed are where a naive blend lies. Per item we test whether the
//     fresh data *contradicts* the prior (two-proportion z on the adjusted rates) and smoothly
//     discount the borrowing as the contradiction grows (a "commensurate prior") — an untouched item
//     keeps its thousand-game prior, a gutted one is dropped as fast as the data can support.
//   - New items have no prior; they pass through untouched and surface as real support accumulates
//     (the generator's usual baseline shrinkage handles their thin samples).
//
// Everything downstream (empirical-Bayes shrinkage, support gates, significance gates) runs on the
// blended counts unchanged: a node's wins+losses is its *effective* decided sample, so the gates are
// well-defined on day one instead of vacuously failing.

import type {
  FlowEdge,
  FlowNode,
  FlowSummary,
  ItemFlowStats,
  ItemStat,
} from "../types";

/** How far before the patch the borrow window reaches. This is where the old "last 30 days" default
 * went: instead of mixing patches at full weight, the pre-patch month enters as a *capped* prior. */
export const PRIOR_WINDOW_S = 30 * 86400;

// --- Prior strength K (equivalent decided games the pre-patch window is worth, per item) ---
// Learned from the data when possible (see estimatePatchK): the observed spread of fresh−prior
// win-rate gaps decomposes into sampling noise + true patch drift, and K = p(1−p)/driftVar — the
// same observedVar−samplingVar trick as priorStrength in buildGenerator, applied across time instead
// of across items. On day one few items have enough fresh games to measure drift, so we fall back to
// the default, which encodes "a patch typically moves an item's WR ~1.5pt" (0.25/0.015² ≈ 1100).
export const PATCH_K_DEFAULT = 1000;
export const PATCH_K_MIN = 200; // even a violent patch leaves most items' data mostly informative
export const PATCH_K_MAX = 8000; // even a no-op patch shouldn't let the past drown a week of fresh data
const DRIFT_MIN_N = 40; // an item informs the drift fit only with this many decided games in BOTH windows
const DRIFT_MIN_PAIRS = 8; // need this many such items to trust the fit at all

// Contradiction discount: how sharply borrowing fades as the fresh data disagrees with the prior.
// The per-item discount is 1/(1+(z/CONTRADICT_Z)²) where z is the two-proportion gap between the
// windows' adjusted rates — smooth (no cliff at a significance bar), halves the prior at z = 2, and
// leaves it intact when the fresh sample is too thin to disagree (z ≈ 0), which is exactly when the
// prior is needed most.
const CONTRADICT_Z = 2;

/** A blended flow plus the honesty numbers the UI surfaces. */
export interface BlendResult {
  flow: ItemFlowStats;
  /** Share of the effective win-rate evidence borrowed from the pre-patch window (0..1) — "this
   * build leans 84% on pre-patch data". Falls toward 0 as the patch matures. */
  borrowedShare: number;
  /** The prior strength used, in equivalent decided games per item (learned or default). */
  patchK: number;
  /** Total games in each *raw* window (before blending) — the honest per-window denominators for a
   * pick-rate comparison across the patch (see findAdoptionMovers). The blended flow mixes windows,
   * so its own baseline can't measure adoption. */
  freshGames: number;
  priorGames: number;
}

const nodeKey = (n: FlowNode) => `${n.column}:${n.item_id}`;
const edgeKey = (e: FlowEdge) =>
  `${e.from_column}:${e.from_item_id}:${e.to_item_id}`;

/**
 * Prior strength K from the two windows themselves. For items well-sampled in both, the variance of
 * the fresh−prior gap is sampling noise plus true patch drift; subtracting the expected noise leaves
 * driftVar, and K = p(1−p)/driftVar converts it to equivalent games (small drift ⇒ trust the past a
 * lot; big drift ⇒ borrow little). Falls back to {@link PATCH_K_DEFAULT} when too few items qualify
 * (day one), and to {@link PATCH_K_MAX} when the measured drift is indistinguishable from zero.
 */
export function estimatePatchK(
  fresh: ItemFlowStats,
  prior: ItemFlowStats,
  baseline: number,
): number {
  const priorByKey = new Map(prior.nodes.map((n) => [nodeKey(n), n]));
  const pairs: RatePair[] = [];
  for (const n of fresh.nodes) {
    const q = priorByKey.get(nodeKey(n));
    if (!q) continue;
    const nN = n.wins + n.losses;
    const nP = q.wins + q.losses;
    if (nN < DRIFT_MIN_N || nP < DRIFT_MIN_N) continue;
    pairs.push({ d: n.adjusted_win_rate - q.adjusted_win_rate, nN, nP });
  }
  return kFromPairs(pairs, baseline * (1 - baseline));
}

interface RatePair {
  d: number; // fresh rate − prior rate for one item
  nN: number; // decided games behind the fresh rate
  nP: number; // ...and the prior rate
}

/** The shared drift-fit core behind {@link estimatePatchK} and {@link blendItemStats}: K in
 * equivalent games from the fresh−prior rate gaps of well-sampled items. `v` = p(1−p). */
function kFromPairs(pairs: RatePair[], v: number): number {
  if (pairs.length < DRIFT_MIN_PAIRS) return PATCH_K_DEFAULT;
  const observedVar = pairs.reduce((s, x) => s + x.d * x.d, 0) / pairs.length;
  const samplingVar =
    pairs.reduce((s, x) => s + v * (1 / x.nN + 1 / x.nP), 0) / pairs.length;
  const driftVar = observedVar - samplingVar;
  if (driftVar <= 0) {
    // The windows agree — but "no drift measured" only means something if the fit had the power to
    // see typical drift. On day one every pair is thin, samplingVar swamps the drift the default K
    // encodes (v/K), and driftVar ≤ 0 is guaranteed regardless of the truth — absence of evidence.
    // Only trust it (and borrow at the max) once the noise floor is below that default drift size.
    return samplingVar < v / PATCH_K_DEFAULT ? PATCH_K_MAX : PATCH_K_DEFAULT;
  }
  return Math.min(PATCH_K_MAX, Math.max(PATCH_K_MIN, v / driftVar));
}

/** Smooth per-item borrowing discount for fresh-vs-prior disagreement (see CONTRADICT_Z). 1 when
 * either window is empty — a thin fresh sample can't contradict anything, and that's when borrowing
 * matters most. */
function contradictionDiscount(
  adjN: number,
  nN: number,
  adjP: number,
  nP: number,
  baseline: number,
): number {
  if (nN <= 0 || nP <= 0) return 1;
  const v = baseline * (1 - baseline);
  const se = Math.sqrt(v * (1 / nN + 1 / nP));
  if (se === 0) return 1;
  const z = Math.abs(adjN - adjP) / se;
  return 1 / (1 + (z / CONTRADICT_Z) ** 2);
}

/** Weighted average that tolerates an empty side. */
function wavg(a: number, wa: number, b: number, wb: number): number {
  const w = wa + wb;
  return w > 0 ? (a * wa + b * wb) / w : 0;
}

/**
 * One summary borrowed into another with prior weight capped at K decided games, contradiction-
 * discounted like the nodes (a hero whose baseline the patch visibly moved borrows less). Counts are
 * rounded — they're displayed ("12,345 matches") — while the rates stay exact.
 */
function blendSummary(f: FlowSummary, q: FlowSummary, K: number): FlowSummary {
  const nN = f.wins + f.losses;
  const nP = q.wins + q.losses;
  const adjN = nN > 0 ? f.wins / nN : 0.5;
  const adjP = nP > 0 ? q.wins / nP : 0.5;
  const baseline = wavg(adjN, nN, adjP, nP) || 0.5;
  const disc = contradictionDiscount(adjN, nN, adjP, nP, baseline);
  const scale = nP > 0 ? Math.min(nP, K * disc) / nP : 0;
  return {
    matches: Math.round(f.matches + scale * q.matches),
    players: Math.round(f.players + scale * q.players),
    wins: f.wins + scale * q.wins,
    losses: f.losses + scale * q.losses,
    avg_duration_s: wavg(f.avg_duration_s, nN, q.avg_duration_s, scale * nP),
    avg_net_worth: wavg(f.avg_net_worth, nN, q.avg_net_worth, scale * nP),
  };
}

/**
 * Blend a (possibly day-old) patch window `fresh` with the pre-patch window `prior` into one
 * synthetic ItemFlowStats the build generator consumes unchanged.
 *
 * Win rates borrow per item×phase: the prior node contributes at most K·discount decided games, so
 * the blended adjusted rate is (n·adjNew + m·adjPrior)/(n+m) and wins+losses = n+m is the honest
 * effective sample the downstream shrinkage and gates run on.
 *
 * Pick rates borrow per *column* with a single scale β = min(1, K/reachedPrior), applied to every
 * prior node's players and to reached_per_column alike — one shared denominator keeps every item's
 * blended pick rate a genuine fraction of the same population (a per-item scale would break that).
 */
export function blendFlow(
  fresh: ItemFlowStats,
  prior: ItemFlowStats,
): BlendResult {
  // Pooled baseline win rate, used only as the variance scale p(1−p) in the drift fit and z tests.
  const bw = fresh.baseline.wins + prior.baseline.wins;
  const bd = bw + fresh.baseline.losses + prior.baseline.losses;
  const baseline = bd > 0 ? bw / bd : 0.5;
  const K = estimatePatchK(fresh, prior, baseline);

  // Per-column pick-rate borrowing scale + blended reached counts.
  const cols = Math.max(
    fresh.reached_per_column.length,
    prior.reached_per_column.length,
  );
  const beta: number[] = [];
  const reached: number[] = [];
  for (let c = 0; c < cols; c++) {
    const rP = prior.reached_per_column[c] ?? 0;
    const b = rP > 0 ? Math.min(1, K / rP) : 0;
    beta.push(b);
    reached.push(Math.round((fresh.reached_per_column[c] ?? 0) + b * rP));
  }

  const priorByKey = new Map(prior.nodes.map((n) => [nodeKey(n), n]));
  const freshKeys = new Set(fresh.nodes.map(nodeKey));
  let borrowed = 0;
  let total = 0;

  const blendNode = (
    f: FlowNode | undefined,
    q: FlowNode | undefined,
  ): FlowNode => {
    const src = (f ?? q)!;
    const nN = f ? f.wins + f.losses : 0;
    const nP = q ? q.wins + q.losses : 0;
    const adjN = f?.adjusted_win_rate ?? 0;
    const adjP = q?.adjusted_win_rate ?? 0;
    const disc =
      f && q ? contradictionDiscount(adjN, nN, adjP, nP, baseline) : 1;
    const m = q ? Math.min(nP, K * disc) : 0; // prior evidence admitted, in decided games
    const den = nN + m;
    const rawN = nN > 0 && f ? f.wins / nN : 0;
    const rawP = nP > 0 && q ? q.wins / nP : 0;
    const raw = den > 0 ? wavg(rawN, nN, rawP, m) : 0;
    borrowed += m;
    total += den;

    const b = beta[src.column] ?? 0;
    const wN = f?.players ?? 0;
    const wP = b * (q?.players ?? 0);
    return {
      column: src.column,
      item_id: src.item_id,
      wins: raw * den,
      losses: (1 - raw) * den,
      players: Math.round(wN + wP),
      matches: Math.round((f?.matches ?? 0) + b * (q?.matches ?? 0)),
      adjusted_win_rate: den > 0 ? wavg(adjN, nN, adjP, m) : 0,
      avg_net_worth_at_buy: wavg(
        f?.avg_net_worth_at_buy ?? 0,
        wN,
        q?.avg_net_worth_at_buy ?? 0,
        wP,
      ),
      total_kills: Math.round(
        (f?.total_kills ?? 0) + b * (q?.total_kills ?? 0),
      ),
      total_deaths: Math.round(
        (f?.total_deaths ?? 0) + b * (q?.total_deaths ?? 0),
      ),
      total_assists: Math.round(
        (f?.total_assists ?? 0) + b * (q?.total_assists ?? 0),
      ),
    };
  };

  const nodes: FlowNode[] = fresh.nodes.map((f) =>
    blendNode(f, priorByKey.get(nodeKey(f))),
  );
  // Prior-only nodes: an item nobody in the thin fresh sample happened to buy yet still deserves its
  // (β-scaled) seat at the table — dropping these is exactly the day-one incompleteness bug.
  for (const q of prior.nodes)
    if (!freshKeys.has(nodeKey(q))) nodes.push(blendNode(undefined, q));

  // Edges only rank "builds toward" clues, so they take the simple column-β borrow.
  const priorEdges = new Map(prior.edges.map((e) => [edgeKey(e), e]));
  const freshEdgeKeys = new Set(fresh.edges.map(edgeKey));
  const scaleEdge = (
    f: FlowEdge | undefined,
    q: FlowEdge | undefined,
  ): FlowEdge => {
    const src = (f ?? q)!;
    const b = beta[src.from_column] ?? 0;
    return {
      from_column: src.from_column,
      from_item_id: src.from_item_id,
      to_item_id: src.to_item_id,
      wins: (f?.wins ?? 0) + b * (q?.wins ?? 0),
      losses: (f?.losses ?? 0) + b * (q?.losses ?? 0),
      matches: Math.round((f?.matches ?? 0) + b * (q?.matches ?? 0)),
    };
  };
  const edges: FlowEdge[] = fresh.edges.map((f) =>
    scaleEdge(f, priorEdges.get(edgeKey(f))),
  );
  for (const q of prior.edges)
    if (!freshEdgeKeys.has(edgeKey(q))) edges.push(scaleEdge(undefined, q));

  return {
    flow: {
      nodes,
      edges,
      summary: blendSummary(fresh.summary, prior.summary, K),
      baseline: blendSummary(fresh.baseline, prior.baseline, K),
      reached_per_column: reached,
    },
    borrowedShare: total > 0 ? borrowed / total : 0,
    patchK: K,
    freshGames: fresh.baseline.matches,
    priorGames: prior.baseline.matches,
  };
}

/** A blended item-stats slice plus what the *base* (unconditioned) blend learned, so the
 * enemy-conditioned slices of a counters query can borrow consistently with it. */
export interface ItemStatsBlend {
  stats: ItemStat[];
  /** Prior strength used (learned here, or inherited from the base blend). */
  k: number;
  /** Per-item contradiction discounts. On the base blend these are *learned* (the base slice has
   * the sample to detect a patch change); per-enemy blends *apply* them. */
  discounts: Map<number, number>;
  borrowedShare: number;
}

/**
 * Power-prior blend for flat item-stats rows (the counters queries). Same machinery as
 * {@link blendFlow}, with one extra rule for the *conditioned* slices: a counter is a difference
 * (item-vs-enemy WR minus the base), and if the two sides borrow differently the difference is an
 * artifact. A patch-changed item's fresh base data pulls away from its prior (big sample, real
 * contradiction) while its thin per-enemy slice can't contradict anything and stays anchored to
 * pre-patch — the mismatch would read as a fake counter signal. So the per-item discount is
 * learned ONCE on the base pair — where the evidence about "did the patch change this item" lives —
 * and passed via `shared` to every per-enemy blend, keeping both sides of each delta leaning on the
 * past by the same amount. Items missing from `shared` (seen vs an enemy but not the base slice)
 * fall back to their locally-computed discount.
 */
export function blendItemStats(
  fresh: ItemStat[],
  prior: ItemStat[],
  shared?: Pick<ItemStatsBlend, "k" | "discounts">,
): ItemStatsBlend {
  // Pooled rate for the variance scale, from everything in both windows.
  let w = 0;
  let d = 0;
  for (const r of [...fresh, ...prior]) {
    w += r.wins;
    d += r.wins + r.losses;
  }
  const p = d > 0 ? w / d : 0.5;
  const v = p * (1 - p);

  const priorById = new Map(prior.map((r) => [r.item_id, r]));
  const freshIds = new Set(fresh.map((r) => r.item_id));

  let k = shared?.k;
  if (k === undefined) {
    const pairs: RatePair[] = [];
    for (const f of fresh) {
      const q = priorById.get(f.item_id);
      if (!q) continue;
      const nN = f.wins + f.losses;
      const nP = q.wins + q.losses;
      if (nN < DRIFT_MIN_N || nP < DRIFT_MIN_N) continue;
      pairs.push({ d: f.wins / nN - q.wins / nP, nN, nP });
    }
    k = kFromPairs(pairs, v);
  }

  const discounts = new Map<number, number>();
  let borrowed = 0;
  let total = 0;
  const blendRow = (
    f: ItemStat | undefined,
    q: ItemStat | undefined,
  ): ItemStat => {
    const src = (f ?? q)!;
    const nN = f ? f.wins + f.losses : 0;
    const nP = q ? q.wins + q.losses : 0;
    const rateN = nN > 0 && f ? f.wins / nN : 0;
    const rateP = nP > 0 && q ? q.wins / nP : 0;
    const disc =
      shared?.discounts.get(src.item_id) ??
      (f && q ? contradictionDiscount(rateN, nN, rateP, nP, p) : 1);
    discounts.set(src.item_id, disc);
    const m = q ? Math.min(nP, k! * disc) : 0;
    const scale = nP > 0 ? m / nP : 0;
    borrowed += m;
    total += nN + m;
    // A 0 sell time means "rarely sold", not zero seconds — averaging it in would fabricate an
    // early sale, so a zero side just yields to the other.
    const timeBlend = (a: number, b: number) =>
      a > 0 && b > 0 ? wavg(a, nN, b, m) : a > 0 ? a : b;
    return {
      item_id: src.item_id,
      wins: (f?.wins ?? 0) + scale * (q?.wins ?? 0),
      losses: (f?.losses ?? 0) + scale * (q?.losses ?? 0),
      matches: Math.round((f?.matches ?? 0) + scale * (q?.matches ?? 0)),
      players: Math.round((f?.players ?? 0) + scale * (q?.players ?? 0)),
      avg_buy_time_s: timeBlend(f?.avg_buy_time_s ?? 0, q?.avg_buy_time_s ?? 0),
      avg_sell_time_s: timeBlend(
        f?.avg_sell_time_s ?? 0,
        q?.avg_sell_time_s ?? 0,
      ),
    };
  };

  const stats = fresh.map((f) => blendRow(f, priorById.get(f.item_id)));
  for (const q of prior)
    if (!freshIds.has(q.item_id)) stats.push(blendRow(undefined, q));

  return {
    stats,
    k,
    discounts,
    borrowedShare: total > 0 ? borrowed / total : 0,
  };
}
