// "What changed this patch" — the items whose win rate for this hero verifiably moved across the
// patch boundary, computed from the post-patch window and the equal-length window immediately
// before it (lib/patchWindows moversWindowFor). This is the flip side of the blend's contradiction
// discount: there it *protects* estimates from patch-changed items; here it *names* them.
//
// Everything is measured RELATIVE TO THE HERO'S OWN WIN RATE in each window, because the raw rates
// answer the wrong question. When a patch nerfs the hero, every item they buy loses win rate
// together, and testing raw rates turns one hero change into a strip full of item movers: measured
// on 07-28-2026, Haze's baseline fell 1.99pt and the raw test reported 8 "movers", all negative
// (Hunter's Aura −13.1pt, Magic Carpet −11.5pt …), every one of which vanished once the hero-level
// shift was taken out. An item moved this patch only if it moved *against its hero*.
//
// Rigor notes: every sufficiently-sampled item is tested (two-proportion z on the re-based rates),
// the family is FDR-controlled with Benjamini-Hochberg — day one tests ~100 items at once, and
// without it ~10 would "move" by luck — and an effect floor keeps a significant-but-trivial 0.4pt
// drift on a huge sample from headlining. Items with no pre-patch record are reported separately as
// new, once they have a real sample (there's nothing to test them against).

import { benjaminiHochberg, normalCdf } from "./stats";
import type { BuildItem, GeneratedBuild, Item, ItemStat } from "../types";

const MOVER_MIN_N = 40; // decided games needed in BOTH windows to test an item at all
const MOVER_FDR = 0.1; // expected share of false movers among those we call
const MOVER_MIN_DELTA = 0.02; // effect floor: a headline mover moved ≥2pts, not just "significantly"
const NEW_ITEM_MIN_N = 100; // a brand-new item needs this many decided games before we announce it
const MOVERS_MAX = 8; // a glanceable list, biggest movement first

/** The hero's own record in each of the two windows — the reference every item is measured
 * against, so that a hero buff or nerf doesn't read as its whole item pool moving. Decided counts
 * come along because on day one the post-patch baseline is itself a small sample. */
export interface HeroWindows {
  freshRate: number;
  freshDecided: number;
  prevRate: number;
  prevDecided: number;
}

export interface PatchMover {
  item: Item;
  /** Raw win rate in the pre-patch window (0 for a new item) — for display. */
  prevWinRate: number;
  /** Raw win rate since the patch — for display. */
  newWinRate: number;
  /** The same rates as a gap against the hero's win rate in that window. These are what moved:
   * `delta` is their difference, and a mover with a big raw swing but a flat edge is the hero
   * moving, not the item. */
  prevEdge: number;
  newEdge: number;
  /** newEdge − prevEdge, in win-rate points: how much the item gained or lost *on its hero*. */
  delta: number;
  /** Decided games behind each side. */
  nNew: number;
  nPrev: number;
  /** No pre-patch record at all — added (or first made viable) by this patch. */
  isNew?: boolean;
  /** The patch notes name this item as a change subject (lib/patchChanges) — the move is caused by
   * the patch, not a meta shift. Annotated post-hoc in useBuildData; absent when notes are missing. */
  changed?: boolean;
}

/**
 * The FDR-controlled patch movers for one hero+rank, biggest |Δ| first, plus well-sampled new items
 * at the end. `fresh`/`prev` are the post-patch and matched pre-patch item-stats windows; pass the
 * raw (unblended) rows — the whole point is to compare the windows, so blended inputs would test
 * the prior against itself. `hero` is the hero's record in those same two windows; without it there
 * is nothing to separate an item moving from its hero moving, so an empty baseline yields no movers.
 */
export function findPatchMovers(
  fresh: ItemStat[],
  prev: ItemStat[],
  items: Map<number, Item>,
  hero: HeroWindows,
): PatchMover[] {
  if (hero.freshDecided <= 0 || hero.prevDecided <= 0) return [];
  const prevById = new Map(prev.map((r) => [r.item_id, r]));

  // Variance of the hero-baseline shift we subtract from every item. Both windows are the hero's
  // whole population, so this term is usually small next to the item's own — but on day one the
  // post-patch baseline is thin enough to matter, and ignoring it would let baseline noise leak
  // through as item movement. Note the item's games are a *subset* of the hero's, so the two rates
  // are positively correlated and adding the variances overstates the standard error; that errs
  // toward calling fewer movers, which is the right way to be wrong here.
  const basePooled =
    (hero.freshRate * hero.freshDecided + hero.prevRate * hero.prevDecided) /
    (hero.freshDecided + hero.prevDecided);
  const baseVar =
    basePooled *
    (1 - basePooled) *
    (1 / hero.freshDecided + 1 / hero.prevDecided);

  // Candidates: testable pairs (both windows sampled). p-values for the whole family first —
  // BH needs every test, not a pre-filtered subset (pre-filtering on the noisy delta biases the
  // null p-values and breaks the FDR guarantee; same ordering lesson as the counters gate).
  const tested: Array<{ mover: PatchMover; p: number }> = [];
  for (const f of fresh) {
    const q = prevById.get(f.item_id);
    const item = items.get(f.item_id);
    if (!q || !item) continue;
    const nN = f.wins + f.losses;
    const nP = q.wins + q.losses;
    if (nN < MOVER_MIN_N || nP < MOVER_MIN_N) continue;
    const rN = f.wins / nN;
    const rP = q.wins / nP;
    const newEdge = rN - hero.freshRate;
    const prevEdge = rP - hero.prevRate;
    const pooled = (f.wins + q.wins) / (nN + nP);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / nN + 1 / nP) + baseVar);
    const z = se > 0 ? (newEdge - prevEdge) / se : 0;
    const p = 2 * (1 - normalCdf(Math.abs(z)));
    tested.push({
      mover: {
        item,
        prevWinRate: rP,
        newWinRate: rN,
        prevEdge,
        newEdge,
        delta: newEdge - prevEdge,
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
    if (prevById.has(f.item_id)) continue;
    const item = items.get(f.item_id);
    const n = f.wins + f.losses;
    if (!item || n < NEW_ITEM_MIN_N) continue;
    news.push({
      item,
      prevWinRate: 0,
      newWinRate: f.wins / n,
      prevEdge: 0,
      newEdge: f.wins / n - hero.freshRate,
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
// post-patch vs the equal-length window right before the patch. A real adoption jump splits by
// whether it's paying off:
//   - RISING + winning above baseline  ⇒ a breakout (get ahead of it).
//   - RISING + at/below baseline       ⇒ hype: being tried, not (yet) working — the honest caution
//     (measured live: Drifter's Melee-Lifesteal build rose +7pt adoption while losing 1.7pt).
//
// The comparator window has to be the matched one, not the 30-day borrow window: adoption trends
// run for weeks, so against a monthly *average* an item halfway up an existing ramp shows the
// biggest "jump" of all, and every breakout this surfaced on 07-28-2026 turned out to already be at
// its post-patch pick rate before the patch (see lib/patchWindows moversWindowFor).
//
// The other half of getting this right is the denominator, which is the more dangerous half because
// it moves every item at once. A pick rate is a *ratio* of two numbers the API reports separately,
// and on short historical windows they disagree: for Abrams' 40h pre-patch window, hero-stats
// reported 23,292 games while item-stats and flow-stats independently implied ~14,500 (they agree
// with each other, and with the ~17 purchase-events per game that holds on every window where all
// three agree). Divide by the wrong one and every item's pre-patch pick rate reads ~40% too low,
// which is a strip full of fabricated breakouts — Melee Charge showed 48%→79% that way, against a
// true 78%→79%. So the comparator's size is derived from the item-stats payloads themselves rather
// than from any reported game count: the two windows are put on one scale by their total purchase
// volume, which cancels the discrepancy exactly because numerator and denominator then come from
// the same response.

const ADOPT_MIN_RISE = 0.04; // pick rate must climb ≥4pt post-patch to count as "being adopted"
const ADOPT_MIN_N = 200; // decided post-patch games needed to read its win rate at all
const ADOPT_WIN_MARGIN = 0.005; // above baseline by this ⇒ "breakout"; within/below ⇒ "hype"
const ADOPT_MAX = 6;
// The rise must also clear sampling noise. At day-one volumes the 4pt floor is already ~8σ, so this
// binds only where a window is genuinely thin — a high rank floor on a young patch — which is
// exactly where a 4pt "rise" is otherwise free. No FDR here: the effect floor does the heavy
// filtering, and unlike the win-rate movers this family is small and pre-filtered by that floor.
const ADOPT_MIN_Z = 3;

export interface AdoptionMover {
  item: Item;
  /** Pick rate in the comparator window, expressed on the post-patch window's scale (see the
   * denominator note above) — comparable to `pickNew`, which is what it exists for. */
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
  /** The patch notes name this item as a change subject (lib/patchChanges) — a breakout the patch
   * actually caused, vs one just riding a meta shift. Annotated post-hoc in useBuildData. */
  changed?: boolean;
}

/**
 * Items the player base is moving toward this patch, biggest pick-rate rise first. `fresh`/`prev`
 * are the raw item-stats windows (a row's `matches` = games the item was bought in) — the post-patch
 * window and the matched one before it, fetched at the SAME `min_matches` floor, since the totals
 * below are sums over the rows that survived it. `gFresh` is the post-patch window's game count, used
 * only to put the shares on a familiar scale; `baseline` is the hero's win rate *in the post-patch
 * window* (not a blended one — the win edge below is otherwise a comparison across two populations).
 * Returns [] when either window is empty.
 */
export function findAdoptionMovers(
  fresh: ItemStat[],
  prev: ItemStat[],
  gFresh: number,
  baseline: number,
  items: Map<number, Item>,
): AdoptionMover[] {
  const buysFresh = fresh.reduce((s, r) => s + r.matches, 0);
  const buysPrev = prev.reduce((s, r) => s + r.matches, 0);
  if (gFresh <= 0 || buysFresh <= 0 || buysPrev <= 0) return [];
  // The comparator's size on the post-patch window's own scale: same purchases per game in both
  // windows (a property of how long games run, not of the patch), so their total purchase volumes
  // stand in for their game counts — and unlike the reported counts, these two numbers come from
  // the same pair of responses as the numerators they divide.
  const gPrev = gFresh * (buysPrev / buysFresh);
  const prevById = new Map(prev.map((r) => [r.item_id, r]));
  const out: AdoptionMover[] = [];
  for (const f of fresh) {
    const item = items.get(f.item_id);
    if (!item) continue;
    const nNew = f.wins + f.losses;
    if (nNew < ADOPT_MIN_N) continue; // need a real post-patch WR to classify it
    const q = prevById.get(f.item_id);
    const pickNew = f.matches / gFresh;
    const pickPrev = q ? q.matches / gPrev : 0; // no prior row ⇒ adoption from ~zero
    const pickDelta = pickNew - pickPrev;
    if (pickDelta < ADOPT_MIN_RISE) continue;
    const pooled = (f.matches + (q?.matches ?? 0)) / (gFresh + gPrev);
    const pickSe = Math.sqrt(pooled * (1 - pooled) * (1 / gFresh + 1 / gPrev));
    if (pickSe > 0 && pickDelta / pickSe < ADOPT_MIN_Z) continue;
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
