// Relationship annotations on a finished build: "builds toward", "swap for", and the
// core-later / rush-if-ahead clues.

import type {
  BuildItem,
  BuildPhase,
  Item,
  ItemFlowStats,
  PairGames,
} from "../../types";
import { significantlyHigher } from "../stats";
import {
  PAIR_MIN_N,
  PHASE_META,
  SUBSTITUTE_OVERLAP_MAX,
  withinCostBand,
} from "./phaseFill";

// Effect-size floor for retracting "rush if ahead". We default to *rush* and only downgrade to "buy
// later" when the later core phase wins both meaningfully (>this margin on the point estimate) *and*
// significantly (clear of sampling noise) more than the early buy — see significantlyHigher, which scales
// the noise half by each phase's sample. Kept small because it's now purely the "gap I care about" knob;
// the old flat 1.5pt was doing double duty as margin *and* noise cushion, so it ignored sample size and
// mis-tagged thin-sample wobble as "buy later" and real large-sample gaps as "rush".
const RUSH_MARGIN = 0.005;

/**
 * Attach "learn about this item" relationship clues, mutating the phases' items:
 *  - `buildsToward`: the item this is a component of, ranked by how often this hero's players
 *    actually made that jump (flow `edges`), then by overall pick — i.e. its real upgrade.
 *  - `swapFor` (situational only): the same-slot core pick whose cost is closest — the slot
 *    this situational item is competing for.
 */
export function annotateRelations(
  phases: BuildPhase[],
  flow: ItemFlowStats,
  items: Map<number, Item>,
): void {
  // Edge weights: players who went from item X to item Y next, summed across columns.
  const edgeW = new Map<number, Map<number, number>>();
  for (const e of flow.edges) {
    let m = edgeW.get(e.from_item_id);
    if (!m) edgeW.set(e.from_item_id, (m = new Map()));
    m.set(e.to_item_id, (m.get(e.to_item_id) ?? 0) + e.matches);
  }
  // How many of this hero's players touch each item at all (relevance gate + tiebreak).
  const flowPlayers = new Map<number, number>();
  for (const n of flow.nodes)
    flowPlayers.set(n.item_id, (flowPlayers.get(n.item_id) ?? 0) + n.players);
  // Reverse component tree: component id → items built from it.
  const builtFrom = new Map<number, Item[]>();
  for (const it of items.values())
    for (const c of it.componentIds) {
      const arr = builtFrom.get(c);
      if (arr) arr.push(it);
      else builtFrom.set(c, [it]);
    }

  const buildsToward = (
    id: number,
  ): { id: number; name: string } | undefined => {
    // Only upgrades this hero's players actually make (in the flow), best transition first.
    const cands = (builtFrom.get(id) ?? []).filter((y) =>
      flowPlayers.has(y.id),
    );
    if (cands.length === 0) return undefined;
    const w = edgeW.get(id);
    cands.sort(
      (a, b) =>
        (w?.get(b.id) ?? 0) - (w?.get(a.id) ?? 0) ||
        (flowPlayers.get(b.id) ?? 0) - (flowPlayers.get(a.id) ?? 0),
    );
    return { id: cands[0].id, name: cands[0].name };
  };

  for (const p of phases) {
    // Transient core picks already say "builds into X"; don't double up.
    for (const b of p.core)
      if (!b.transient) b.buildsToward = buildsToward(b.item.id);
    for (const s of p.situational) s.buildsToward = buildsToward(s.item.id);
  }
}

/**
 * Slot-relative clues — `coreLater` ("core by Mid, rush if ahead") and `swapFor` (the same-slot
 * comparable-cost core pick this is an alternative to). With pair data, a situational pick is
 * never paired as a "swap for" a core pick it measurably co-occurs with — buying both isn't a
 * swap (Paradox lane: 76% of High-Velocity Rounds buyers also buy Headshot Booster, so HVR is a
 * co-buy that missed core, not HB's alternative). Pure over phases and *resets first*, so it can
 * be re-run after a comp re-rank shuffles core membership without leaving stale pairings.
 */
export function annotateSlotRelations(
  phases: BuildPhase[],
  pairGames?: PairGames,
): void {
  // Measured co-buys make a nonsensical "swap for" pairing; unmeasurable pairs stay eligible.
  const coBuys = (a: BuildItem, b: BuildItem): boolean => {
    const pg = pairGames?.(a.item.id, b.item.id);
    return (
      pg !== undefined &&
      Math.min(pg.totalA, pg.totalB) >= PAIR_MIN_N &&
      pg.joint / Math.min(pg.totalA, pg.totalB) >= SUBSTITUTE_OVERLAP_MAX
    );
  };
  // Each item's later core appearances, keyed by column, so a situational pick can find both the phase
  // it becomes core in *and* that phase's win rate (to decide whether rushing it early is supported).
  const coreCols = new Map<
    number,
    Array<{ column: number; adjWr: number; decided: number }>
  >();
  for (const p of phases)
    for (const b of p.core) {
      const entry = {
        column: p.column,
        adjWr: b.adjustedWinRate,
        decided: b.decided,
      };
      const arr = coreCols.get(b.item.id);
      if (arr) arr.push(entry);
      else coreCols.set(b.item.id, [entry]);
    }

  for (const p of phases) {
    for (const b of p.core) {
      b.swapFor = undefined;
      b.coreLater = undefined;
      b.coreRush = undefined;
    }
    for (const s of p.situational) {
      s.swapFor = undefined;
      s.coreLater = undefined;
      s.coreRush = undefined;
      // Explicit substitution link (held out of core as an alternative to a specific pick): pair to
      // that rival when it's still core here, not to the merely cost-closest pick below.
      if (s.swapForId !== undefined) {
        const rival = p.core.find((c) => c.item.id === s.swapForId);
        if (rival) {
          s.swapFor = { id: rival.item.id, name: rival.item.name };
          continue;
        }
      }
      // Same item core in a later phase ⇒ it becomes core by then. Default to a *rush* target ("buy early
      // if ahead"); only retract to "buy later" when the later core phase wins both meaningfully *and*
      // significantly more than this early buy — i.e. the data genuinely argues against rushing, not just a
      // sampling wobble. significantlyHigher scales the noise bar by each phase's own sample.
      const later = (coreCols.get(s.item.id) ?? []).find(
        (c) => c.column > p.column,
      );
      if (later !== undefined) {
        s.coreLater = PHASE_META[later.column].label;
        s.coreRush = !significantlyHigher(
          later.adjWr,
          later.decided,
          s.adjustedWinRate,
          s.decided,
          RUSH_MARGIN,
        );
        continue;
      }
      // Else pair with a same-slot core pick of *comparable cost* — a real alternative, not a
      // 6.4k item dressed up as a swap for a 1.6k one, and not a pick it demonstrably co-occurs with.
      const peers = p.core.filter(
        (c) =>
          c.item.slot === s.item.slot &&
          withinCostBand(c.item.cost, s.item.cost) &&
          !coBuys(c, s),
      );
      if (peers.length) {
        const closest = peers.reduce((best, c) =>
          Math.abs(c.item.cost - s.item.cost) <
          Math.abs(best.item.cost - s.item.cost)
            ? c
            : best,
        );
        s.swapFor = { id: closest.item.id, name: closest.item.name };
      }
    }
  }
}
