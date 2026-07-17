// Flow → candidate construction: turning one flow node into a rankable BuildItem, spotting nodes
// whose upstream adjustment is corrupt, and finding each item's primary (most-bought) phase.

import type { BuildItem, FlowNode, Item, ItemFlowStats } from "../../types";

export function toCandidate(
  n: FlowNode,
  reached: number,
  items: Map<number, Item>,
  unreliable?: Set<string>,
): BuildItem | null {
  const item = items.get(n.item_id);
  if (!item) return null;
  const decided = n.wins + n.losses;
  // Upstream, an item's `net_worth_at_buy` is the player's FINAL net worth for their first few
  // purchases — so in the lane column `adjusted_win_rate` is standardized against end-of-game wealth
  // and reads a cheap opener as a rich player's buy. Where that's happened the adjustment is worse
  // than none, so fall back to the raw rate (see unreliableAdjustedNodes).
  const bogusAdjustment = unreliable?.has(nodeKey(n)) ?? false;
  const rawWinRate = decided > 0 ? n.wins / decided : 0;
  return {
    item,
    role: "value", // refined by buildPhase
    pickRate: reached > 0 ? n.players / reached : 0,
    adjustedWinRate: bogusAdjustment ? rawWinRate : n.adjusted_win_rate,
    rawWinRate,
    unadjusted: bogusAdjustment || undefined,
    sample: n.players,
    decided,
    avgNetWorthAtBuy: n.avg_net_worth_at_buy,
    why: "",
  };
}

const nodeKey = (n: FlowNode) => `${n.column}:${n.item_id}`;

/** Multiple of a phase's median net-worth-at-buy past which a node's figure can't be real. Measured
 * across heroes: columns 1–3 have NO node above 2× their column median (tight, well-behaved), while
 * the lane column has 9–15 per hero, topping out at ~37k against an average *final* net worth of
 * ~39k. So this fires on the corruption and nothing else, without hardcoding a soul value. */
const NW_CORRUPT_FACTOR = 2;

const unreliableCache = new WeakMap<ItemFlowStats, Set<string>>();

/**
 * Flow nodes whose `adjusted_win_rate` can't be trusted, because the net worth it standardizes on is
 * corrupt.
 *
 * Upstream bug: in the per-match data, an item's `net_worth_at_buy` reports the player's **final**
 * net worth for their first ~4–5 purchases. Those are lane buys, so the lane column's
 * `avg_net_worth_at_buy` is a mixture of true values and end-of-game wealth — Golden Goose Egg (800
 * souls, bought in the opening minutes) reports 38,179, which is the average final net worth. The
 * server then "adjusts" its win rate as though a rich player had bought it, and Golden Goose Egg goes
 * from 53.1% raw to 45.7% adjusted: above baseline to below it, purely from bad data.
 *
 * Even a modest contamination shifts the mean a long way (20% of purchases carrying a ~39k final net
 * worth pulls a true 3k average up past 10k), so the bar is deliberately not "impossible" but
 * "implausible": more than {@link NW_CORRUPT_FACTOR}× the column's median. The median is taken per
 * column so the test self-calibrates to the phase — lane buys and 30-minute buys have legitimately
 * different net worths — and needs no absolute soul threshold.
 *
 * For a flagged node the honest move is to drop the adjustment entirely and rank/display on the raw
 * rate: lane is where the confound the adjustment exists to fix is *weakest* (everyone is poor, so
 * there's little net-worth variance to confound), and a wrong adjustment is worse than none.
 *
 * Exported for tests. Memoized per flow object — every phase asks for it.
 */
export function unreliableAdjustedNodes(flow: ItemFlowStats): Set<string> {
  const hit = unreliableCache.get(flow);
  if (hit) return hit;

  const byColumn = new Map<number, number[]>();
  for (const n of flow.nodes) {
    if (!(n.avg_net_worth_at_buy > 0)) continue;
    const arr = byColumn.get(n.column);
    if (arr) arr.push(n.avg_net_worth_at_buy);
    else byColumn.set(n.column, [n.avg_net_worth_at_buy]);
  }
  const medians = new Map<number, number>();
  for (const [col, vals] of byColumn) {
    vals.sort((a, b) => a - b);
    medians.set(col, vals[vals.length >> 1]);
  }

  const out = new Set<string>();
  for (const n of flow.nodes) {
    const med = medians.get(n.column);
    if (!med) continue;
    if (n.avg_net_worth_at_buy > NW_CORRUPT_FACTOR * med) out.add(nodeKey(n));
  }
  unreliableCache.set(flow, out);
  return out;
}

/** Item id → the column where the largest fraction of players buy it (its primary phase). */
export function primaryColumnByItem(flow: ItemFlowStats): Map<number, number> {
  const best = new Map<number, { col: number; pick: number }>();
  for (const n of flow.nodes) {
    const reached =
      flow.reached_per_column[n.column] || flow.baseline.matches || 1;
    const pick = reached > 0 ? n.players / reached : 0;
    const cur = best.get(n.item_id);
    if (!cur || pick > cur.pick) best.set(n.item_id, { col: n.column, pick });
  }
  const out = new Map<number, number>();
  for (const [id, v] of best) out.set(id, v.col);
  return out;
}
