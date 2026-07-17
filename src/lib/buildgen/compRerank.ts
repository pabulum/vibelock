// Enemy-comp re-rank: re-seat an already-generated build's core/situational membership by each
// item's signed comp edge, preserving the base build's budget and category balance.

import type {
  BuildItem,
  BuildRole,
  GeneratedBuild,
  Item,
  SlotType,
} from "../../types";
import { GATE_Z } from "../stats";
import type { CompEdge } from "../counters";
import { UNIVERSAL_PICK, VALUE_EDGE } from "./scoring";
import { SITUATIONAL_MAX, substituteRival } from "./phaseFill";
import {
  SLOT_CAP,
  capStandingSlots,
  countItemsBought,
  dropSamePhaseComponents,
  recomputeCosts,
} from "./slotEconomy";
import { annotateSlotRelations } from "./annotate";
import { finalizeOvertimeBuys, overtimeSellList } from "./overtime";

const COMP_DEMOTE = 0.015; // effect floor: a pick this far below the matchup lean is "weak vs comp".
// Calibrated to the comp edge's *shrunk* scale (counters.ts EDGE_PRIOR_K): posterior-mean edges on a
// full 6-enemy comp live within roughly ±2pt (true per-enemy spread τ_c ≈ 0.8pt ⇒ comp sd ≈ 2pt), so
// the old 3pt floor — set when edges were noisy raw means — was unreachable. 1.5pt matches the counter
// marks' MIN_EDGE: the same "practically meaningful" bar on both the promote and demote side.

/** The ▼ demote gate: flag a pick weak-vs-comp only when its negative edge clears BOTH the effect
 * floor and {@link GATE_Z} standard errors — the mirror image of `significantlyHigher` and the same
 * bar value-pick/counter marks must clear. Asymmetry is deliberate: the positive marks run
 * recall-first (hiding a good counter costs the player), but a false ▼ *scares them off a fine
 * pick*, so the scary flag is precision-first and must be significant, not just past a cutoff. */
export function isWeakVsComp(e: CompEdge): boolean {
  return e.edge <= -Math.max(COMP_DEMOTE, GATE_Z * e.se);
}

/**
 * Re-rank an already-generated build for a selected enemy comp, using each item's signed
 * comp edge (win-rate gain vs the comp, centered on the matchup lean). The category core-slot
 * counts and the universal staples are preserved — so the budget/category balance the base
 * build worked out survives — while within each category the comp decides which non-staples
 * fill the core slots, the role labels, and the order. Pure: returns a new build.
 */
export function rerankBuildForComp(
  build: GeneratedBuild,
  edgeByItem: Map<number, CompEdge>,
  items: Map<number, Item>,
): GeneratedBuild {
  const baseline = build.population.baselineWinRate;
  // Combined score: general strength over baseline, plus the comp-specific edge.
  const score = (b: BuildItem) =>
    b.adjustedWinRate - baseline + (edgeByItem.get(b.item.id)?.edge ?? 0);
  const annotate = (b: BuildItem): BuildItem => {
    const e = edgeByItem.get(b.item.id);
    return {
      ...b,
      compEdge: e?.edge,
      weakVsComp: e !== undefined && isWeakVsComp(e),
    };
  };

  const cats: SlotType[] = ["weapon", "vitality", "spirit", "unknown"];

  // An item may hold a *core* slot in only one phase. The per-phase re-rank below rebuilds each phase's
  // core independently from that phase's pool (its base core + situational), and a situational pick in an
  // earlier phase is often the *same item* that's core in a later one (a "core by Mid, rush if ahead"
  // pick). Without this guard the comp could lift that situational into core in the earlier phase while it
  // stays core in its home phase — the same item in core twice. The base build avoids this with its
  // cross-phase `owned` tracking + dedupeAcrossPhases; the re-rank has to restate the rule. `coreHome` maps
  // each item to the one phase it's allowed to be core in: its base-build core phase if it has one (already
  // deduped to a single phase), else — for an item that's only ever situational but repeats across phases —
  // its highest-pick-rate phase (mirroring dedupeAcrossPhases' choice).
  const coreHome = new Map<number, number>();
  for (const phase of build.phases)
    for (const b of phase.core) coreHome.set(b.item.id, phase.column);
  const situHomePick = new Map<number, number>();
  for (const phase of build.phases)
    for (const b of phase.situational) {
      if (coreHome.has(b.item.id)) continue; // pinned to its base-core phase already
      const cur = situHomePick.get(b.item.id);
      if (cur === undefined || b.pickRate > cur) {
        situHomePick.set(b.item.id, b.pickRate);
        coreHome.set(b.item.id, phase.column);
      }
    }
  const coreEligibleHere = (b: BuildItem, column: number) =>
    coreHome.get(b.item.id) === column;

  const phases = build.phases.map((phase) => {
    const pool = [...phase.core, ...phase.situational].map(annotate);
    // Items the base build already surfaced here — preserved through the re-rank so a comp pick
    // re-orders and *adds* but never silently drops a pick we'd otherwise show.
    const situIds = new Set(phase.situational.map((b) => b.item.id));
    const newCore: BuildItem[] = [];
    let leftover: BuildItem[] = [];

    for (const cat of cats) {
      const catItems = pool.filter((b) => b.item.slot === cat);
      const coreSlots = phase.core.filter((b) => b.item.slot === cat).length;
      const universals = catItems
        .filter((b) => b.pickRate >= UNIVERSAL_PICK)
        .sort((a, b) => score(b) - score(a));
      const others = catItems
        .filter((b) => b.pickRate < UNIVERSAL_PICK)
        .sort((a, b) => score(b) - score(a));

      // Staples hold their slots; the comp picks which non-staples fill what's left. Same
      // substitution guard as the base build: a universal that doesn't co-occur with one already
      // taken (same-slot, comparable-cost) is benched as a swap, not given a second core slot.
      const coreUniv: BuildItem[] = [];
      const benched: BuildItem[] = [];
      for (const u of universals) {
        // A staple whose core home is another phase stays situational here (it holds its slot there) —
        // promoting it would put the same item in core twice. Otherwise seat it until the slots run out.
        if (
          !coreEligibleHere(u, phase.column) ||
          coreUniv.length >= coreSlots
        ) {
          benched.push(u);
          continue;
        }
        const rival = substituteRival(u, coreUniv, build.pairGames);
        if (rival) benched.push({ ...u, swapForId: rival.item.id });
        else coreUniv.push(u);
      }
      const fill = Math.max(0, coreSlots - coreUniv.length);
      // Only non-staples whose core home is *this* phase can fill the leftover slots; the rest stay
      // situational. The home phase keeps its full count — its own base-core items are eligible here, so
      // there are always at least `coreSlots` candidates — and the duplicate is dropped from the others.
      const eligibleOthers = others.filter((b) =>
        coreEligibleHere(b, phase.column),
      );
      const ineligibleOthers = others.filter(
        (b) => !coreEligibleHere(b, phase.column),
      );
      const coreCat = [...coreUniv, ...eligibleOthers.slice(0, fill)];
      leftover = leftover.concat(
        benched,
        eligibleOthers.slice(fill),
        ineligibleOthers,
      );

      for (const b of coreCat) {
        const role: BuildRole =
          b.pickRate >= UNIVERSAL_PICK
            ? "universal"
            : score(b) >= VALUE_EDGE
              ? "value"
              : "filler";
        newCore.push({ ...b, role });
      }
    }

    // Situational: every base-build situational the comp didn't promote into core is kept (with
    // its honest role, now annotated better/worse vs the comp) — nothing already shown is dropped,
    // items only move between core and situational. Core picks the comp demoted out of a slot fill
    // whatever room is left, so the list still surfaces what's weak vs the comp. Strongest first.
    const kept = leftover.filter((b) => situIds.has(b.item.id));
    const demoted = leftover
      .filter((b) => !situIds.has(b.item.id))
      .sort((a, b) => score(b) - score(a))
      .slice(0, Math.max(0, SITUATIONAL_MAX - kept.length))
      .map<BuildItem>((b) => ({ ...b, role: "situational" }));
    const newSitu = [...kept, ...demoted].sort((a, b) => score(b) - score(a));

    // The comp decides *which* items are core (and their roles), but you still buy them in time
    // order — so order the phase by buy time, same as the base build, not by comp relevance. (Buy
    // time is stamped on each item at generation; missing times sort last.)
    newCore.sort(
      (a, b) =>
        (a.buyTimeS ?? Number.POSITIVE_INFINITY) -
        (b.buyTimeS ?? Number.POSITIVE_INFINITY),
    );
    // coreSouls/categorySouls are finalized by recomputeCosts below, once every phase's new core
    // membership is settled (component discounts span phases, so they can't be summed per-phase here).
    return { ...phase, core: newCore, situational: newSitu };
  });

  dropSamePhaseComponents(phases, items); // re-rank can pull a swap into core beside its upgrade — keep one
  countItemsBought(phases); // re-count buys for the re-ranked core membership
  recomputeCosts(phases, items); // marginal costs + coreSouls/categorySouls for the re-ranked core
  const standingSlots = capStandingSlots(phases, SLOT_CAP); // re-fit the cap to the re-ranked membership
  annotateSlotRelations(phases, build.pairGames); // swap/rush pairings for the re-ranked membership

  // Both overtime lists are derived from core membership, which the re-rank just changed — so they
  // have to be rebuilt, not carried over. Otherwise a pick the comp promoted into core still shows
  // in the buy list ("buy this at 30+" for an item the build already owns by 20), and the sell list
  // still names slots the re-ranked build no longer holds.
  const newCoreIds = new Set(
    phases.flatMap((p) => p.core.map((b) => b.item.id)),
  );
  return {
    ...build,
    phases,
    standingSlots,
    overtimeBuys: finalizeOvertimeBuys(build.overtimePool, items, newCoreIds),
    overtimeSell: overtimeSellList(phases),
  };
}
