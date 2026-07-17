// The overtime shopping list: what to buy (and sell) once the game drags past ~30 minutes with the
// build already bought. See overtimeBuyList for the full rationale.

import type {
  BuildItem,
  BuildPhase,
  BuildRole,
  Item,
  ItemFlowStats,
} from "../../types";
import {
  MIN_SUPPORT_ABS,
  MIN_SUPPORT_FRAC,
  UNIVERSAL_PICK,
  buyersLoseSignificantly,
  lowerConfidenceWinRate,
} from "./scoring";
import { toCandidate, unreliableAdjustedNodes } from "./candidates";
import { supersededComponents } from "./lines";
import { SELL_FOR_SLOTS_MAX_TIER, sellPriority } from "./slotEconomy";
import { PHASE_META } from "./phaseFill";

// --- Overtime buy-list ranking (see overtimeBuyList) ---
const OVERTIME_MIN_TIER = 3; // an overtime buy is an upgrade you spend surplus souls on, never a cheap
// stat-stick you're replacing. T4 dominates the late window, but standout T3s (Kelvin's Rapid Recharge,
// Haze's Fortitude) genuinely top it — so we keep T3+, not T4-only, and let the late win rate rank them.
const OVERTIME_MAX = 10; // a focused priority list, not the whole catalogue
const OVERTIME_COMMIT_WEIGHT = 0.05; // a small bonus per unit pick rate, so a widely-bought late
// pick edges out an equally-rated rarity.

/**
 * The overtime shopping list for games that drag past the ~30-minute mark with the build already
 * full. Not a phase, and not one ranking: by then souls stop being the constraint and slots become
 * it, so the real decision is "sell a low-tier leftover, buy which upgrade?" — {@link
 * overtimeSellList} is the sell side of that swap. Judged on the **late window only** (the 30+ flow
 * column): a pick that's great at 20 minutes isn't necessarily what wins a 60-minute base race.
 * Anything already core in the build is dropped — the column's premise is the build is bought, so
 * those are owned, and items are unique (a repeat is an impossible purchase); picks that only appear
 * as optional swaps stay eligible. What's left splits the way a phase does:
 *
 *   - **Default upgrades** (`"universal"`) — admitted by adoption (≥{@link UNIVERSAL_PICK} of late
 *     players buy them), NOT by a positive-edge gate: a staple everyone buys late sits at ~baseline
 *     edge by construction (its observable edge is compressed by (1−pick) — see the universal-bypass
 *     note in scoring.ts), so demanding edge > 0 would drop exactly the proven picks while keeping
 *     selection-inflated rarities. Same falsifiable bypass as the core: a staple whose buyers run
 *     significantly behind its non-buyers is a trap, not a default, and is dropped.
 *   - **Situational** (`"situational"`) — sub-universal picks whose late edge is *confidently*
 *     positive (lower confidence bound above baseline, the same regularization as everywhere else)
 *     and that clear the same abs+fractional support floor as the phase fill, so a 1–2%-pick luxury
 *     with a shiny thin-sample win rate doesn't make the list. Their edge is
 *     conditional by nature — people buy Curse/Metal Skin/Unstoppable when the game calls for it and
 *     win when it fits — so they're flagged situational and presented as "if your game calls for
 *     it", never as a fixed buy order.
 *
 * Within each group, strongest regularized late edge first, with a small commit bonus so a
 * widely-bought pick edges out an equally-rated rarity. Components of a listed upgrade drop out
 * (buy the finished item). Exported for tests.
 */
export function overtimeBuyList(
  flow: ItemFlowStats,
  items: Map<number, Item>,
  baselineWinRate: number,
  k: number,
  coreIds: Set<number>,
): BuildItem[] {
  return finalizeOvertimeBuys(
    overtimeCandidates(flow, items, baselineWinRate, k),
    items,
    coreIds,
  );
}

/** The ranked overtime pool, before the "already core" exclusion (see {@link finalizeOvertimeBuys}).
 * Split out from {@link overtimeBuyList} because core membership isn't settled until after any comp
 * re-rank, so the exclusion has to be applied later — and twice. */
export function overtimeCandidates(
  flow: ItemFlowStats,
  items: Map<number, Item>,
  baselineWinRate: number,
  k: number,
): BuildItem[] {
  // Read the LATE column only — the 30+ minute window is the relevant signal for a long game, so an
  // item is judged on what it does *then*, not on its blended-across-the-game average.
  let maxCol = 0;
  for (const n of flow.nodes) if (n.column > maxCol) maxCol = n.column;
  const lateCol = Math.min(PHASE_META.length - 1, maxCol);
  const reached =
    flow.reached_per_column[lateCol] || flow.baseline.matches || 1;
  // Same support floor as the phase fill (abs AND fraction-of-reached). The fraction matters most
  // here: the patch blend caps each node's *decided* evidence (see blendFlow), so the LCB shrink
  // alone can't tell a 1%-pick rarity from a 5%-pick staple once both are near the cap — the
  // player-count floor is the guard that still sees the real adoption gap (the Magic Carpet fix:
  // 1% pick / n=65 topping Paradox overtime on a +13.7pt thin-sample shine).
  const minSupport = Math.max(MIN_SUPPORT_ABS, MIN_SUPPORT_FRAC * reached);

  const unreliable = unreliableAdjustedNodes(flow);
  const pool = flow.nodes
    .filter((n) => n.column === lateCol)
    .map((n) => toCandidate(n, reached, items, unreliable))
    .filter(
      (c): c is BuildItem =>
        c !== null &&
        c.item.tier >= OVERTIME_MIN_TIER &&
        c.sample >= minSupport,
    );

  // Lower-confidence-bound edge for ranking: the item's win-rate edge at its conservative floor (shrunk
  // toward baseline by its decided games *and* discounted for uncertainty), so a small-sample shine
  // (Refresher, 2% pick / n≈130 / +18pt) can't outrank the proven late picks. A small commit bonus still
  // nudges a widely-bought late pick past an equally-rated rarity.
  const rankEdge = (b: BuildItem) =>
    lowerConfidenceWinRate(b.adjustedWinRate, b.decided, baselineWinRate, k) -
    baselineWinRate;
  const score = (b: BuildItem) =>
    rankEdge(b) + OVERTIME_COMMIT_WEIGHT * b.pickRate;
  const byScore = (a: BuildItem, b: BuildItem) => score(b) - score(a);
  const finalize = (b: BuildItem, role: BuildRole): BuildItem => ({
    ...b,
    role,
    effectiveCost: b.item.cost,
    why: b.item.effect ?? "",
  });

  const staples = pool
    .filter(
      (b) =>
        b.pickRate >= UNIVERSAL_PICK &&
        !buyersLoseSignificantly(b, baselineWinRate),
    )
    .sort(byScore)
    .map((b) => finalize(b, "universal"));
  const situational = pool
    .filter((b) => b.pickRate < UNIVERSAL_PICK && rankEdge(b) > 0)
    .sort(byScore)
    .map((b) => finalize(b, "situational"));

  return [...staples, ...situational];
}

/**
 * Applies the "you already own it" exclusion to the ranked overtime pool and trims it to the
 * displayed length. Anything core in the *final* build is dropped — the column's premise is that the
 * build is bought, and items are unique, so re-offering a core pick is an impossible purchase. Picks
 * that are only optional swaps stay eligible: you may well not have bought those.
 *
 * Separate from {@link overtimeCandidates} because it runs twice. `generateBuild` excludes against
 * the base core; a comp re-rank then moves items between core and situational, so
 * {@link rerankBuildForComp} re-applies it against the re-ranked core. Doing it once at generation
 * let a comp-promoted item sit in both the build and the overtime list at the same time.
 *
 * Components of a listed upgrade drop out here too (buy the finished item), computed against the
 * eligible set rather than the whole pool — a component whose upgrade is core is itself moot.
 */
export function finalizeOvertimeBuys(
  pool: BuildItem[],
  items: Map<number, Item>,
  coreIds: Set<number>,
): BuildItem[] {
  const eligible = pool.filter((b) => !coreIds.has(b.item.id));
  const superseded = supersededComponents(eligible, items);
  return eligible
    .filter((b) => !superseded.has(b.item.id))
    .slice(0, OVERTIME_MAX);
}

/**
 * The sell side of overtime (see {@link overtimeBuyList}): the ≤T2 picks still holding a standing
 * slot once the build is bought — the slots you free, weakest first, when an overtime buy needs
 * room. Picks the build already marks transient (sold for the slot cap, consumed by an upgrade)
 * are excluded: the build has already told you what happens to those. Exported for tests.
 */
export function overtimeSellList(phases: BuildPhase[]): BuildItem[] {
  return phases
    .flatMap((p) => p.core)
    .filter((b) => !b.transient && b.item.tier <= SELL_FOR_SLOTS_MAX_TIER)
    .sort(sellPriority);
}
