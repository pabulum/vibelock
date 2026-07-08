// "What changed this patch" — the items whose win rate for this hero verifiably moved across the
// patch boundary, computed from the same two item-stats windows the backfill blend already fetches
// (so the panel is free: no extra queries). This is the flip side of the blend's contradiction
// discount: there it *protects* estimates from patch-changed items; here it *names* them.
//
// Rigor notes: every sufficiently-sampled item is tested (two-proportion z across the windows), the
// family is FDR-controlled with Benjamini-Hochberg — day one tests ~100 items at once, and without
// it ~10 would "move" by luck — and an effect floor keeps a significant-but-trivial 0.4pt drift on a
// huge sample from headlining. Items with no pre-patch record are reported separately as new, once
// they have a real sample (there's nothing to test them against).

import { benjaminiHochberg, normalCdf } from "./stats";
import type {
  BuildItem,
  GeneratedBuild,
  Item,
  ItemStat,
} from "../types";

const MOVER_MIN_N = 40; // decided games needed in BOTH windows to test an item at all
const MOVER_FDR = 0.1; // expected share of false movers among those we call
const MOVER_MIN_DELTA = 0.02; // effect floor: a headline mover moved ≥2pts, not just "significantly"
const NEW_ITEM_MIN_N = 100; // a brand-new item needs this many decided games before we announce it
const MOVERS_MAX = 8; // a glanceable list, biggest movement first

export interface PatchMover {
  item: Item;
  /** Win rate in the pre-patch window (0 for a new item). */
  prevWinRate: number;
  /** Win rate since the patch. */
  newWinRate: number;
  /** newWinRate − prevWinRate, in win-rate points. */
  delta: number;
  /** Decided games behind each side. */
  nNew: number;
  nPrev: number;
  /** No pre-patch record at all — added (or first made viable) by this patch. */
  isNew?: boolean;
}

/**
 * The FDR-controlled patch movers for one hero+rank, biggest |Δ| first, plus well-sampled new items
 * at the end. `fresh`/`prior` are the two item-stats windows; pass the raw (unblended) rows — the
 * whole point is to compare the windows, so blended inputs would test the prior against itself.
 */
export function findPatchMovers(
  fresh: ItemStat[],
  prior: ItemStat[],
  items: Map<number, Item>,
): PatchMover[] {
  const priorById = new Map(prior.map((r) => [r.item_id, r]));

  // Candidates: testable pairs (both windows sampled). p-values for the whole family first —
  // BH needs every test, not a pre-filtered subset (pre-filtering on the noisy delta biases the
  // null p-values and breaks the FDR guarantee; same ordering lesson as the counters gate).
  const tested: Array<{ mover: PatchMover; p: number }> = [];
  for (const f of fresh) {
    const q = priorById.get(f.item_id);
    const item = items.get(f.item_id);
    if (!q || !item) continue;
    const nN = f.wins + f.losses;
    const nP = q.wins + q.losses;
    if (nN < MOVER_MIN_N || nP < MOVER_MIN_N) continue;
    const rN = f.wins / nN;
    const rP = q.wins / nP;
    const pooled = (f.wins + q.wins) / (nN + nP);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / nN + 1 / nP));
    const z = se > 0 ? (rN - rP) / se : 0;
    const p = 2 * (1 - normalCdf(Math.abs(z)));
    tested.push({
      mover: {
        item,
        prevWinRate: rP,
        newWinRate: rN,
        delta: rN - rP,
        nNew: nN,
        nPrev: nP,
      },
      p,
    });
  }

  const accepted = benjaminiHochberg(
    tested.map((t) => t.p),
    MOVER_FDR,
  );
  const movers = tested
    .filter((t, i) => accepted[i] && Math.abs(t.mover.delta) >= MOVER_MIN_DELTA)
    .map((t) => t.mover)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, MOVERS_MAX);

  // New this patch: no pre-patch record, real sample. Reported, not tested (nothing to compare to).
  const news: PatchMover[] = [];
  for (const f of fresh) {
    if (priorById.has(f.item_id)) continue;
    const item = items.get(f.item_id);
    const n = f.wins + f.losses;
    if (!item || n < NEW_ITEM_MIN_N) continue;
    news.push({
      item,
      prevWinRate: 0,
      newWinRate: f.wins / n,
      delta: 0,
      nNew: n,
      nPrev: 0,
      isNew: true,
    });
  }
  news.sort((a, b) => b.nNew - a.nNew);

  return [...movers, ...news];
}

// --- Adoption movers (the "emerging meta" surface) ---------------------------------------------
// A patch mover asks "did this item's WIN RATE move". This asks the orthogonal question "is the
// player base moving TOWARD this item" — the leading signal that a new build is materializing, which
// is the whole point of the app (surface good-but-underplayed picks before they're consensus). We
// measure it from the same two windows: each item's pick rate (games it was bought in ÷ total games)
// post-patch vs pre-patch. A real adoption jump splits by whether it's paying off:
//   - RISING + winning above baseline  ⇒ a breakout (get ahead of it).
//   - RISING + at/below baseline       ⇒ hype: being tried, not (yet) working — the honest caution
//     (measured live: Drifter's Melee-Lifesteal build rose +7pt adoption while losing 1.7pt).
// Pick rate needs a per-window game total; the raw windows give it (BlendResult.fresh/priorGames).

const ADOPT_MIN_RISE = 0.04; // pick rate must climb ≥4pt post-patch to count as "being adopted"
const ADOPT_MIN_N = 200; // decided post-patch games needed to read its win rate at all
const ADOPT_WIN_MARGIN = 0.005; // above baseline by this ⇒ "breakout"; within/below ⇒ "hype"
const ADOPT_MAX = 6;

export interface AdoptionMover {
  item: Item;
  pickPrev: number;
  pickNew: number;
  /** pickNew − pickPrev, in pick-rate points (always ≥ ADOPT_MIN_RISE here). */
  pickDelta: number;
  /** Post-patch win rate, and its gap vs the hero's baseline. */
  winRate: number;
  winEdge: number;
  nNew: number;
  /** Rising *and* winning above baseline — surface it. False ⇒ rising but not paying off (hype). */
  breakout: boolean;
}

/**
 * Items the player base is moving toward this patch, biggest pick-rate rise first. `fresh`/`prior`
 * are the raw item-stats windows (a row's `matches` = games the item was bought in); `gFresh`/`gPrior`
 * are the total games per window (from {@link BlendResult}); `baseline` is the hero's current win
 * rate, to split breakouts from hype. Returns [] when there's no prior window (gPrior ≤ 0).
 */
export function findAdoptionMovers(
  fresh: ItemStat[],
  prior: ItemStat[],
  gFresh: number,
  gPrior: number,
  baseline: number,
  items: Map<number, Item>,
): AdoptionMover[] {
  if (gFresh <= 0 || gPrior <= 0) return [];
  const priorById = new Map(prior.map((r) => [r.item_id, r]));
  const out: AdoptionMover[] = [];
  for (const f of fresh) {
    const item = items.get(f.item_id);
    if (!item) continue;
    const nNew = f.wins + f.losses;
    if (nNew < ADOPT_MIN_N) continue; // need a real post-patch WR to classify it
    const q = priorById.get(f.item_id);
    const pickNew = f.matches / gFresh;
    const pickPrev = q ? q.matches / gPrior : 0; // no prior row ⇒ adoption from ~zero
    const pickDelta = pickNew - pickPrev;
    if (pickDelta < ADOPT_MIN_RISE) continue;
    const winRate = f.wins / nNew;
    out.push({
      item,
      pickPrev,
      pickNew,
      pickDelta,
      winRate,
      winEdge: winRate - baseline,
      nNew,
      breakout: winRate - baseline >= ADOPT_WIN_MARGIN,
    });
  }
  // Breakouts first (they're the actionable signal), each group by how fast it's rising.
  return out
    .sort(
      (a, b) =>
        Number(b.breakout) - Number(a.breakout) || b.pickDelta - a.pickDelta,
    )
    .slice(0, ADOPT_MAX);
}

// --- Folding breakouts into the build ---
const TREND_MAX_PER_PHASE = 1; // one emerging pick per phase keeps it a hint, not a second build
const TREND_MAX_TOTAL = 3; // ...and a few across the whole build — a short list of new ideas

/**
 * Fold current breakouts (rising *and* winning adoption movers) into a build as tagged situational
 * options — the "emerging meta" surfaced where you already look for flex picks. Breakouts already
 * somewhere in the build are left untouched (the caller tags those in place from the same list, so
 * they read "🔥 and I'm already building it"); a breakout NOT anywhere in the build (nor its overtime
 * list) becomes a synthetic situational pick in the phase its tier suggests (T1→Lane … T4→Late),
 * capped per-phase and overall so the section stays a short list, not a dumping ground. The synthetic
 * pick carries the raw post-patch win rate (item-stats has no adjusted rate — same basis as a
 * counter-add row). Pure; returns a new build (never mutates), or the input unchanged when nothing
 * new qualifies. Low-risk by construction: it only ever *adds* optional rows.
 */
export function foldTrendingBreakouts(
  build: GeneratedBuild,
  breakouts: AdoptionMover[],
): GeneratedBuild {
  if (breakouts.length === 0) return build;
  const present = new Set<number>();
  for (const p of build.phases)
    for (const b of [...p.core, ...p.situational]) present.add(b.item.id);
  for (const b of build.overtimeBuys) present.add(b.item.id);

  const additions = new Map<number, BuildItem[]>(); // phase column → synthetic picks
  let added = 0;
  for (const a of breakouts) {
    if (added >= TREND_MAX_TOTAL) break;
    if (present.has(a.item.id)) continue;
    const col = Math.max(0, Math.min(3, a.item.tier - 1));
    const arr = additions.get(col) ?? [];
    if (arr.length >= TREND_MAX_PER_PHASE) continue;
    arr.push({
      item: a.item,
      role: "situational",
      pickRate: a.pickNew,
      adjustedWinRate: a.winRate,
      rawWinRate: a.winRate,
      sample: a.nNew,
      decided: a.nNew,
      avgNetWorthAtBuy: 0,
      effectiveCost: a.item.cost,
      why: `📈 trending up this patch — ${Math.round(a.pickPrev * 100)}%→${Math.round(a.pickNew * 100)}% pick, ${(a.winRate * 100).toFixed(0)}% WR`,
    });
    additions.set(col, arr);
    present.add(a.item.id);
    added++;
  }
  if (added === 0) return build;
  return {
    ...build,
    phases: build.phases.map((p) =>
      additions.has(p.column)
        ? {
            ...p,
            situational: [...p.situational, ...(additions.get(p.column) ?? [])],
          }
        : p,
    ),
  };
}
