// Component/upgrade *line* machinery: which items build into which, what an upgrade really costs
// once owned components absorb into it, and the line-aware model (survivorship shrink +
// down-payment upside) behind the experimental lineAware toggle.

import type { BuildItem, BuildPhase, Item, ItemFlowStats } from "../../types";
import { UNIVERSAL_PICK, meritWr } from "./scoring";

// --- Line-aware down-payment (opts.lineAware) ---
// How much a component's *future upgrade upside* counts toward its early-phase core ranking, so a Lane
// stat-stick that builds into a winning later pick outranks a dead-end one of equal WR (you keep 100% of the
// souls upgrading vs 50% selling it later). Gated by the two-pass commitment check (see generateBuild): the
// bonus only fires for a component whose upgrade the build actually seats in a later phase, which is what
// stops the naive one-pass over-fire (verified on Paradox @ Emissary+: it had promoted Compress Cooldown
// +0.3 over Enchanter's Emblem +2.2 for a Superior Cooldown that never seated). Mirrors SYNERGY_WEIGHT's
// magnitude — a tiebreak, not an override. 0 = off (also skips pass 1).
export const DOWNPAYMENT_WEIGHT = 0.5;

/** Item ids in `pool` that are a (transitive) component of some *other* item in `pool` — the parts
 * you've already built into a finished item, so they shouldn't hold their own endgame slot. */
export function supersededComponents(
  pool: BuildItem[],
  items: Map<number, Item>,
): Set<number> {
  const poolIds = new Set(pool.map((b) => b.item.id));
  const out = new Set<number>();
  const walk = (item: Item) => {
    for (const c of item.componentIds) {
      if (poolIds.has(c)) out.add(c);
      const comp = items.get(c);
      if (comp) walk(comp);
    }
  };
  for (const b of pool) walk(b.item);
  return out;
}

/** Every item id that's a (transitive) component of an already-committed (`owned`) item — i.e. it's
 * already been "spent" building that upgrade. Deadlock won't sell you a component standalone once
 * its upgrade is owned (only a *different* item built from the same component, at full price), so a
 * later phase must never re-offer one of these as its own pick — it's not a real purchase, just the
 * upgrade you already bought under a different name. */
export function componentsConsumedByOwned(
  owned: Set<number>,
  items: Map<number, Item>,
): Set<number> {
  const out = new Set<number>();
  const walk = (item: Item) => {
    for (const c of item.componentIds) {
      if (!out.has(c)) {
        out.add(c);
        const comp = items.get(c);
        if (comp) walk(comp);
      }
    }
  };
  for (const id of owned) {
    const it = items.get(id);
    if (it) walk(it);
  }
  return out;
}

/** Per-item survivorship shrink + down-payment upside for line-aware generation (see BuildOptions.lineAware). */
export interface LineModel {
  /** upgrade id → how to shrink its rank WR toward its main component: `compWr + λ·(itemWr − compWr)`. */
  shrinkOf: Map<number, { compWr: number; lambda: number }>;
  /** component id → each in-flow upgrade of it with positive shrunk upside, its id, and its home phase.
   * Pass 2 picks the best upgrade the build *actually committed to* later (see committedCore). */
  downpaymentOf: Map<
    number,
    Array<{ upgradeId: number; upside: number; upgradeCol: number }>
  >;
}

/**
 * Build the {@link LineModel} once per generation. Each item's *primary-phase profile* (the column where the
 * most players buy it, with that column's pick rate and adjusted win rate) stands in for its "broad"
 * behaviour. Then:
 *  - shrinkOf: for every item with a direct component present in the flow, pick the component the most
 *    players buy (the main line), and record λ = min(1, pickUpgrade / pickComponent) — the share of the
 *    component's buyers who reach the upgrade — plus the component's win rate. buildPhase uses these to pull
 *    a survivorship-inflated upgrade WR back toward its component (few reach it ⇒ small λ ⇒ big shrink).
 *  - downpaymentOf: for every component, each in-flow upgrade with positive shrunk upside
 *    `max(0, λ·(WR_up − WR_comp))`, its id, and its home column. The fill rewards buying the component early
 *    when it builds into a winner the build *commits to* in a later phase — the commitment gate (pass 1's
 *    committedCore) is what stops a naive one-pass from promoting a component for an upgrade that never seats.
 */
export function buildLineModel(
  flow: ItemFlowStats,
  items: Map<number, Item>,
): LineModel {
  const profile = new Map<number, { col: number; pick: number; wr: number }>();
  for (const n of flow.nodes) {
    const reached =
      flow.reached_per_column[n.column] || flow.baseline.matches || 1;
    const pick = reached > 0 ? n.players / reached : 0;
    const cur = profile.get(n.item_id);
    if (!cur || pick > cur.pick)
      profile.set(n.item_id, {
        col: n.column,
        pick,
        wr: n.adjusted_win_rate,
      });
  }

  const shrinkOf = new Map<number, { compWr: number; lambda: number }>();
  for (const [id, up] of profile) {
    const item = items.get(id);
    if (!item) continue;
    // Main component = the direct component with in-flow data the most players buy.
    let main: { pick: number; wr: number } | undefined;
    for (const cid of item.componentIds) {
      const cp = profile.get(cid);
      if (cp && (!main || cp.pick > main.pick)) main = cp;
    }
    if (!main || main.pick <= 0) continue;
    const lambda = Math.min(1, up.pick / main.pick);
    shrinkOf.set(id, { compWr: main.wr, lambda });
  }

  // Reverse tree: component id → the items built directly from it (that have flow data).
  const builtFrom = new Map<number, number[]>();
  for (const [id, item] of items)
    if (profile.has(id))
      for (const cid of item.componentIds)
        if (profile.has(cid))
          (builtFrom.get(cid) ?? builtFrom.set(cid, []).get(cid)!).push(id);

  const downpaymentOf = new Map<
    number,
    Array<{ upgradeId: number; upside: number; upgradeCol: number }>
  >();
  for (const [cid, ups] of builtFrom) {
    const comp = profile.get(cid)!;
    const arr: Array<{
      upgradeId: number;
      upside: number;
      upgradeCol: number;
    }> = [];
    for (const uid of ups) {
      const up = profile.get(uid)!;
      const lambda = comp.pick > 0 ? Math.min(1, up.pick / comp.pick) : 0;
      const upside = Math.max(0, lambda * (up.wr - comp.wr));
      if (upside > 0) arr.push({ upgradeId: uid, upside, upgradeCol: up.col });
    }
    if (arr.length) downpaymentOf.set(cid, arr);
  }

  return { shrinkOf, downpaymentOf };
}

/**
 * Line-collapse (lineAware). When a phase already surfaces both a component (in core) and a direct upgrade
 * of it (in situational), and the upgrade is at least as good on *merit* (shrunk win rate — so a
 * survivorship trap like Headhunter does NOT qualify), promote the upgrade into core. The very next step,
 * {@link dropSamePhaseComponents}, then folds the component into it — so the phase shows the finished item
 * (Opening Rounds) in place of the terminal component (High-Velocity Rounds), same slot, cost credited by
 * {@link recomputeCosts}. This is what makes the build recommend the *upgrade you actually play* instead of
 * the stat-stick you'd otherwise be shown holding until you sell it.
 *
 * Scoped deliberately tight: same phase only (the component is core and the upgrade situational *here*),
 * direct component→upgrade, and only upgrades not already core elsewhere. The merit gate `meritWr(up) ≥
 * meritWr(comp)` is the keep-vs-upgrade call — when the upgrade is more niche/worse after the shrink
 * (Slowing Bullets → Weighted Shots) the component keeps its slot and nothing collapses. Run after
 * dedupeAcrossPhases (membership settled) and before dropSamePhaseComponents (which does the fold).
 */
export function collapseLines(phases: BuildPhase[]): void {
  const coreAnywhere = new Set<number>();
  for (const p of phases) for (const b of p.core) coreAnywhere.add(b.item.id);
  for (const p of phases) {
    for (const comp of [...p.core]) {
      // The best same-phase situational upgrade built directly from this component, worth upgrading into.
      let best: BuildItem | undefined;
      for (const s of p.situational) {
        if (!s.item.componentIds.includes(comp.item.id)) continue;
        if (coreAnywhere.has(s.item.id)) continue; // already core in some phase — don't duplicate
        if (meritWr(s) + 1e-9 < meritWr(comp)) continue; // upgrade not worth it ⇒ keep the component
        if (!best || meritWr(s) > meritWr(best)) best = s;
      }
      if (!best) continue;
      p.situational = p.situational.filter((s) => s.item.id !== best!.item.id);
      p.core.push({
        ...best,
        role: best.pickRate >= UNIVERSAL_PICK ? "universal" : "value",
      });
      coreAnywhere.add(best.item.id);
    }
  }
}

/**
 * True when `item` is built (transitively) from any id in `roots` — i.e. it's an upgrade of one of
 * them. Used to keep a benched substitute's whole line out of core: the slot a swap vacates is real
 * and should be filled, but not by the swap's own upgrade (Opening Rounds is built from
 * High-Velocity Rounds) — that would put the upgrade in core *and* the component as its swap.
 */
export function buildsFromAny(
  item: Item,
  roots: Set<number>,
  items: Map<number, Item>,
): boolean {
  if (roots.size === 0) return false;
  return item.componentIds.some((c) => {
    if (roots.has(c)) return true;
    const comp = items.get(c);
    return comp ? buildsFromAny(comp, roots, items) : false;
  });
}

/**
 * Each in-build component → the single recommended upgrade that absorbs it. A component can only be
 * consumed once, so when two kept items build from the same one (Trophy Collector and Enduring Speed
 * both build from Sprint Boots) only one absorbs it — the other pays full price. Last in core order
 * (≈ buy order) wins, so the "builds into" note and the cost refund always name the same upgrade.
 */
export function absorptionMap(core: BuildItem[]): Map<number, Item> {
  const coreIds = new Set(core.map((b) => b.item.id));
  const into = new Map<number, Item>();
  for (const b of core)
    for (const compId of b.item.componentIds)
      if (coreIds.has(compId)) into.set(compId, b.item);
  return into;
}

/**
 * What an item costs *once the components you already own are absorbed into it* — Deadlock refunds a
 * built item's components when you upgrade, so owning High-Velocity Rounds (800) drops Opening Rounds
 * from its 1600 sticker to an 800 marginal. `owns(id)` answers "is this component already in the
 * build". Only *direct* components are credited (the discount Deadlock actually applies); a chain
 * (A→B→C, all kept) nets to the top item's price because each link credits the one below it. Floored
 * at 0 so a malformed cost can't go negative.
 */
export function marginalCost(
  item: Item,
  owns: (id: number) => boolean,
  items: Map<number, Item>,
): number {
  let c = item.cost;
  for (const compId of item.componentIds)
    if (owns(compId)) c -= items.get(compId)?.cost ?? 0;
  return Math.max(0, c);
}
