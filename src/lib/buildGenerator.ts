// Assembles an *opinionated, buildable* build — not a ranked list.
//
// Why this is more than sorting: a build is a correlated set under a budget, not
// the top-N items judged independently. The fix isn't conditional locking (that
// collapses the sample — requiring a player to have bought 3 exact items can match
// <2% of games); it's two cheaper ideas that together make a coherent build:
//
//   1. Budget — each phase's item count and soul spend come from what real players
//      of this hero+rank actually do (the "5.6 items / 7.1k souls early" number).
//   2. Pick-rate core — the universal core is chosen by pick rate, and items that
//      are each in 60–70% of builds necessarily co-occur, so co-occurrence is baked
//      in for free. Value picks (best adjusted win rate) fill the rest of the budget.
//
// Items within a phase are ordered by average buy time, so top-to-bottom reads as
// buy order.
//
// This file is the orchestrator: generateBuild wires the per-phase fill together and
// finalizes the cross-phase bookkeeping. The machinery lives in ./buildgen/ —
// scoring (EB shrinkage, ranking, gates), candidates (flow → items), lines
// (component/upgrade trees + line-aware model), phaseFill (the per-column fill),
// slotEconomy (slot cap, transients, costs), overtime, winState, annotate, and
// compRerank. Everything the app and tests import is re-exported below, so this
// module's public surface is unchanged by the split.

import type {
  BuildPhase,
  GeneratedBuild,
  Hero,
  Item,
  ItemFlowStats,
  PairGames,
} from "../types";
import { priorStrength } from "./buildgen/scoring";
import { primaryColumnByItem } from "./buildgen/candidates";
import {
  DOWNPAYMENT_WEIGHT,
  buildLineModel,
  collapseLines,
} from "./buildgen/lines";
import {
  PHASE_META,
  buildPhase,
  type BuildOptions,
} from "./buildgen/phaseFill";
import {
  SLOT_CAP,
  capStandingSlots,
  countItemsBought,
  dedupeAcrossPhases,
  dropSamePhaseComponents,
  markTransient,
  recomputeCosts,
} from "./buildgen/slotEconomy";
import { annotateRelations, annotateSlotRelations } from "./buildgen/annotate";
import {
  finalizeOvertimeBuys,
  overtimeCandidates,
  overtimeSellList,
} from "./buildgen/overtime";

export { SLOT_CAP };
export type { BuildOptions };
export {
  finalizeOvertimeBuys,
  overtimeBuyList,
  overtimeCandidates,
  overtimeSellList,
} from "./buildgen/overtime";
export { annotateSlotRelations } from "./buildgen/annotate";
export { unreliableAdjustedNodes } from "./buildgen/candidates";
export {
  LAB_EXCESS_MIN,
  LAB_WPBUY_AHEAD,
  LAB_WPBUY_BEHIND,
  WIN_STATE_GAP,
  WIN_STATE_WR_FLOOR,
  classifyWinState,
  phaseTempo,
} from "./buildgen/winState";
export type { LabWinState, PhaseTempo, WinState } from "./buildgen/winState";
export { isWeakVsComp, rerankBuildForComp } from "./buildgen/compRerank";
export { itemVerdict } from "./buildgen/verdict";
export type { ItemVerdict, VerdictStats } from "./buildgen/verdict";

/**
 * Pure: turns one (unlocked) flow response into a phased build. `buyTimes`/`sellTimes`
 * map item id → average buy/sell time in seconds (buy: ordering; sell: transient flags).
 */
export function generateBuild(
  hero: Hero,
  rankLabel: string,
  items: Map<number, Item>,
  flow: ItemFlowStats,
  buyTimes: Map<number, number>,
  sellTimes: Map<number, number>,
  opts: BuildOptions = {},
): GeneratedBuild {
  const baseWins = flow.baseline.wins + flow.baseline.losses;
  const baselineWinRate = baseWins > 0 ? flow.baseline.wins / baseWins : 0.5;

  // Empirical-Bayes prior strength for shrinking item win rates toward baseline, learned once from the
  // spread of *all* this hero's item win rates (every flow node is one item×phase observation). One
  // hero-wide K is steadier than re-estimating per phase, and the shrink itself still uses each item's
  // own decided-game count, so a thin pick in any phase is pulled back regardless.
  const priorK = priorStrength(
    flow.nodes.map((n) => ({
      winRate: n.adjusted_win_rate,
      decided: n.wins + n.losses,
    })),
    baselineWinRate,
  );

  // Measured co-purchase lookup: joint games from the permutation pairs, whole-game decided totals
  // from the flow (summed across columns — a player buys an item once). Undefined when either item
  // never appears in the flow; each *reader* applies its own sample gate (the overlap coefficient
  // needs both sides past PAIR_MIN_N, the continuation share only the component's side). Threaded
  // through the substitute call, the transient labels, and the swap pairing, and carried on the
  // returned build so the comp re-rank applies the same decisions.
  let pairGames: PairGames | undefined;
  if (opts.jointGamesOf) {
    const jointOf = opts.jointGamesOf;
    const totalDecided = new Map<number, number>();
    for (const n of flow.nodes)
      totalDecided.set(
        n.item_id,
        (totalDecided.get(n.item_id) ?? 0) + n.wins + n.losses,
      );
    pairGames = (a, b) => {
      const totalA = totalDecided.get(a) ?? 0;
      const totalB = totalDecided.get(b) ?? 0;
      if (totalA <= 0 || totalB <= 0) return undefined;
      return { joint: jointOf(a, b), totalA, totalB };
    };
  }

  // Each item's primary phase = the column where the highest fraction of players buy it. The core
  // fill skips an item outside its primary phase, because dedupeAcrossPhases keeps it only there —
  // filling an earlier phase's slot with a mostly-bought-later item just leaves that slot empty.
  const primaryCol = primaryColumnByItem(flow);
  // Line-aware model (survivorship shrink + down-payment upside), computed once. Undefined unless the
  // toggle is on, so the default path is untouched.
  const lineModel = opts.lineAware ? buildLineModel(flow, items) : undefined;

  // Down-payment needs to know which upgrades the build *commits to* in later phases before it can reward
  // buying their components early. Pass 1 (dp off — committedCore undefined) builds the phases just to learn
  // that: item id → earliest phase it's core. This runs only when line-aware + the weight is live, so it's
  // 2× the phase sweeps inside this call *only then* (and this call already runs once per archetype — no
  // deeper nesting). buildLineModel above is computed once and shared across both passes.
  let committedCore: Map<number, number> | undefined;
  if (lineModel && DOWNPAYMENT_WEIGHT > 0) {
    const owned1 = new Set<number>();
    const claimed1 = new Set<number>();
    committedCore = new Map<number, number>();
    for (let col = 0; col < PHASE_META.length; col++) {
      const p = buildPhase(
        col,
        flow,
        items,
        baselineWinRate,
        buyTimes,
        sellTimes,
        opts,
        primaryCol,
        owned1,
        claimed1,
        priorK,
        pairGames,
        lineModel,
        // committedCore intentionally omitted ⇒ dp off in pass 1
      );
      for (const b of p.core) {
        if (!committedCore.has(b.item.id)) committedCore.set(b.item.id, col);
        owned1.add(b.item.id);
      }
    }
  }

  // Phases are built in order so each can see what earlier phases committed to buy (`owned`): an
  // upgrade is discounted by a component you already hold, both when gating what fits the soul budget
  // and in the displayed spend. `claimed` tracks components already absorbed by an upgrade so a single
  // component can't discount two of them (Sprint Boots → Enduring Speed *or* Trophy Collector, not
  // both); buildPhase reads it for the discount and adds to it as it seats absorbing picks.
  const owned = new Set<number>();
  const claimed = new Set<number>();
  const phases: BuildPhase[] = [];
  for (let col = 0; col < PHASE_META.length; col++) {
    const phase = buildPhase(
      col,
      flow,
      items,
      baselineWinRate,
      buyTimes,
      sellTimes,
      opts,
      primaryCol,
      owned,
      claimed,
      priorK,
      pairGames,
      lineModel,
      committedCore,
    );
    phases.push(phase);
    for (const b of phase.core) owned.add(b.item.id);
  }

  dedupeAcrossPhases(phases);
  if (lineModel) collapseLines(phases); // promote a worthy upgrade over its terminal component (same phase)
  dropSamePhaseComponents(phases, items); // a component+upgrade in one phase ⇒ keep only the upgrade
  countItemsBought(phases); // buy count per phase, crediting same-phase folded components
  recomputeCosts(phases, items); // finalize marginal costs against post-dedupe membership
  markTransient(phases, sellTimes); // flag builds-into / often-sold placeholders
  const standingSlots = capStandingSlots(phases, SLOT_CAP); // sell weakest cheap picks to fit the slot cap
  annotateRelations(phases, flow, items);
  annotateSlotRelations(phases, pairGames);

  // Items the build already commits to buying — by the time overtime starts they're owned, so the
  // overtime list must not re-offer them (items are unique; a repeat is an impossible purchase).
  const coreIds = new Set(phases.flatMap((p) => p.core.map((b) => b.item.id)));
  const overtimePool = overtimeCandidates(flow, items, baselineWinRate, priorK);

  return {
    hero,
    rankLabel,
    population: {
      matches: flow.baseline.matches,
      avgDurationS: flow.baseline.avg_duration_s,
      baselineWinRate,
    },
    phases,
    standingSlots,
    overtimePool,
    overtimeBuys: finalizeOvertimeBuys(overtimePool, items, coreIds),
    overtimeSell: overtimeSellList(phases),
    pairGames,
  };
}
