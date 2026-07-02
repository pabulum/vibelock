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
import type { Item, ItemStat } from "../types";

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
