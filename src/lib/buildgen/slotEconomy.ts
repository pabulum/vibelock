// Slot economy: the standing-slot cap, transient (builds-into / sell-fodder) flags, cross-phase
// membership dedupe, buy counting, and the marginal-cost recompute — everything about what the build
// *holds* and *sells* rather than what it picks.

import type { BuildItem, BuildPhase, BuildRole, Item } from "../../types";
import { absorptionMap, buildsFromAny } from "./lines";

export const SLOT_CAP = 12; // 9 base + 3 flex slots (unlocked via Walker kills)
const SELL_BEFORE_S = 1500; // a cheap item that leaves inventory before ~25 min is a placeholder (the
// "leave" is usually an upgrade-consumption, not a literal sale — avg_sell_time_s conflates the two; see markTransient)
export const SELL_FOR_SLOTS_MAX_TIER = 2; // only cheap stat-sticks/components (≤T2) are sold to free a slot; T3+
// are "build complete" and never sold for room unless you're giga-late (which we don't assume — see
// capStandingSlots). This is why builds read fine without a hard cap: the overflow is the stuff you sell.
const SOLD_FOR_SLOTS = "sell late for a slot"; // imperative — it's an instruction, unlike the passive kinds

/** Keep each core item only in the phase where it's most commonly bought (you buy it once). */
export function dedupeAcrossPhases(phases: BuildPhase[]): void {
  const bestPhase = new Map<number, number>(); // item id → phase index with highest pick rate
  phases.forEach((p, i) => {
    for (const b of p.core) {
      const cur = bestPhase.get(b.item.id);
      if (
        cur === undefined ||
        b.pickRate >
          phases[cur].core.find((x) => x.item.id === b.item.id)!.pickRate
      ) {
        bestPhase.set(b.item.id, i);
      }
    }
  });
  phases.forEach((p, i) => {
    p.core = p.core.filter((b) => bestPhase.get(b.item.id) === i);
  });
}

/**
 * Drop a component when the upgrade that absorbs it sits in the *same* phase. Queuing the upgrade in
 * the shop auto-queues its components, so listing both is redundant — and worse, the rows are ordered
 * by buy time (or, with a comp selected, by comp score), which can place the component *after* the
 * upgrade it's the only path into (you'd never buy High-Velocity Rounds once you already hold the
 * Opening Rounds it builds into) while the upgrade still shows the component's price knocked off. We
 * keep only the upgrade, at full sticker: recomputeCosts credits a refund only for components still in
 * core, so dropping the component restores its price and the phase's soul total is unchanged (full
 * sticker = component + marginal). The dropped component is still a real purchase you make this phase
 * — {@link countItemsBought} adds it back to the phase's buy count so the "N/targetItems items"
 * readout compares like with like (targetItems counts that component too), and the soul total already
 * bills it via the kept upgrade's full sticker. Cross-phase components are left alone — there you
 * really do buy the cheap item in an earlier phase and upgrade later, so it holds a genuine
 * (transient) slot and earns its row. Run after dedupe (final membership known) and before
 * recomputeCosts (so the kept upgrade prices at full sticker).
 *
 * The *situational* list gets the same treatment, for the same reason: buying a same-phase core
 * upgrade auto-queues its whole component tree, so offering one of those parts as a separate
 * optional pickup is redundant (Paradox early-mid: Extra Health surfacing situational while
 * Fortitude, which builds from it, is already core). This arm is *transitive* — the upgrade pulls
 * in the full tree, not just its direct parts — and it's scoped to same-phase core: a component
 * that's core/optional in an *earlier* phase and upgraded here is the legitimate "buy cheap, upgrade
 * later" path and keeps its row (that cross-phase case is handled by `consumedByOwned` in buildPhase).
 */
export function dropSamePhaseComponents(
  phases: BuildPhase[],
  items: Map<number, Item>,
): void {
  for (const p of phases) {
    const absorbedHere = absorptionMap(p.core); // component id → its same-phase absorbing upgrade
    if (absorbedHere.size > 0)
      p.core = p.core.filter((b) => !absorbedHere.has(b.item.id));
    // A situational pick that's a (transitive) component of something still core this phase folds
    // into that upgrade's shop queue — don't offer it as its own optional buy.
    if (p.core.length && p.situational.length)
      p.situational = p.situational.filter(
        (s) =>
          !p.core.some((c) =>
            buildsFromAny(c.item, new Set([s.item.id]), items),
          ),
      );
  }
}

/**
 * Set each phase's `itemsBought` — the buy count the "N/targetItems items" readout compares. It's
 * `core.length` plus every component a core upgrade absorbs that's first bought *this* phase: those
 * were dropped as their own rows by {@link dropSamePhaseComponents}, but you still buy them (Swift
 * Striker folds in a Rapid Rounds purchase), and the soul budget already bills them, so the count
 * should too. A component owned from an earlier phase is already counted there — the later upgrade is
 * just its marginal buy, not a second component purchase. Mirrors {@link marginalCost} in crediting
 * only *direct* components (the buy Deadlock actually rolls into the upgrade). Run after
 * dropSamePhaseComponents, when core membership is final.
 */
export function countItemsBought(phases: BuildPhase[]): void {
  const ownedBefore = new Set<number>(); // finished core items from earlier phases
  for (const p of phases) {
    const coreIds = new Set(p.core.map((b) => b.item.id));
    let bought = 0;
    for (const b of p.core) {
      bought += 1; // the item itself
      // Components folded into this upgrade and first bought here (not owned earlier, not their own
      // row) — each is a real purchase you pass through on the way to the finished item.
      for (const compId of b.item.componentIds)
        if (!ownedBefore.has(compId) && !coreIds.has(compId)) bought += 1;
    }
    p.itemsBought = bought;
    for (const b of p.core) ownedBefore.add(b.item.id);
  }
}

/**
 * Flags core items that don't hold a permanent slot — they build into another recommended item (a
 * shared slot) or they're a cheap stat-stick that leaves your inventory before the game's back half —
 * and returns the count of items that *do* hold a slot. Mutates the phases' core items.
 *
 * Only the first case gets a *reason* string ("builds into X"), and only when X is itself in the build
 * so the note names a pick the player is actually holding. The cheap-early case is flagged sell-fodder
 * (kind "sold", same SELL badge as capStandingSlots' picks — you only ever sell because slots bind, so
 * the UI doesn't split hairs) with no text: we used to print "often sold ~mm:ss" from item-stats'
 * `avg_sell_time_s`, but that field counts a
 * component being absorbed into its upgrade as a "sell" — verified against Paradox @ Emissary+, where a
 * single-upgrade component's `avg_sell_time_s` lands within a minute of its upgrade's buy time (HVR
 * "sold" 6:55 = Opening Rounds bought 6:37; Extra Health "sold" 17:47 = Fortitude bought 17:06). So the
 * time was an *upgrade* time, not a sell, and the label misread nearly every early stat-stick. The
 * flag itself still stands — a T1 stick gone before {@link SELL_BEFORE_S} isn't a permanent slot whether
 * it left via upgrade or sale, which is what the slot accounting needs — we just no longer assert a time.
 */
export function markTransient(
  phases: BuildPhase[],
  sellTimes: Map<number, number>,
): number {
  const core = phases.flatMap((p) => p.core);
  const buildsInto = absorptionMap(core); // component → the one upgrade that absorbs it

  for (const b of core) {
    const upgrade = buildsInto.get(b.item.id);
    const leaveTime = sellTimes.get(b.item.id); // time it leaves inventory (mostly upgrade-consumption)
    if (upgrade) {
      b.transient = true;
      b.transientKind = "part";
      b.transientReason = `builds into ${upgrade.name}`;
    } else if (
      b.item.tier <= 1 &&
      leaveTime !== undefined &&
      leaveTime > 0 &&
      leaveTime < SELL_BEFORE_S
    ) {
      b.transient = true; // a cheap stat-stick that's gone early — sell-fodder, but no (unreliable) time label
      b.transientKind = "sold";
    }
  }

  return core.filter((b) => !b.transient).length;
}

/**
 * Deadlock holds at most {@link SLOT_CAP} items (9 base + 3 flex). A kept build over that isn't a bug — in
 * game you *sell* your cheapest stat-sticks to fit your late upgrades — so we model that sale rather than
 * refuse the strong late picks (which is why builds read fine without a hard cap; the overflow is exactly
 * the stuff you'd sell). When the standing (kept, non-transient) build is over `cap`, mark the weakest cheap
 * picks transient ("{@link SOLD_FOR_SLOTS}"), weakest-first ({@link sellPriority}), until it fits.
 * "Build-complete" picks (tier > {@link SELL_FOR_SLOTS_MAX_TIER}) are
 * never sold for room — you'd only do that giga-late, which we don't assume — so if every standing pick left
 * is a keeper the build is honestly left over the cap (features/BuildMeta warns). Idempotent: it clears *its own* prior
 * flags first (leaving builds-into / cheap-early alone), so it's safe to re-run after a comp re-rank shuffles
 * core membership. Returns the final standing-slot count. Run after {@link markTransient}.
 */
export function capStandingSlots(phases: BuildPhase[], cap: number): number {
  const core = phases.flatMap((p) => p.core);
  for (const b of core)
    // Reason, not kind: the cheap-early sticks markTransient flags are also kind "sold" (same
    // sell-fodder concept), but they're not this function's to clear.
    if (b.transientReason === SOLD_FOR_SLOTS) {
      b.transient = false;
      b.transientKind = undefined;
      b.transientReason = undefined;
    }

  const standing = core.filter((b) => !b.transient);
  let held = standing.length;
  if (held <= cap) return held;

  const sellable = standing
    .filter((b) => b.item.tier <= SELL_FOR_SLOTS_MAX_TIER)
    .sort(sellPriority);
  for (const b of sellable) {
    if (held <= cap) break;
    b.transient = true;
    b.transientKind = "sold";
    b.transientReason = SOLD_FOR_SLOTS;
    held--;
  }
  return held;
}

/** Weakest-first sell order for standing cheap picks: lowest tier first (the biggest upgrade gap —
 * "sell low-tier when the difference is big"), then filler before value before staple, then
 * least-popular, then lowest win rate. Shared by {@link capStandingSlots} (what to sell to fit the
 * slot cap) and {@link overtimeSellList} (which slots to free for an overtime buy). */
export function sellPriority(a: BuildItem, b: BuildItem): number {
  const roleWeakness = (r: BuildRole) =>
    r === "filler" ? 0 : r === "value" ? 1 : 2;
  return (
    a.item.tier - b.item.tier ||
    roleWeakness(a.role) - roleWeakness(b.role) ||
    a.pickRate - b.pickRate ||
    a.adjustedWinRate - b.adjustedWinRate
  );
}

/**
 * Recompute every phase's marginal costs against the *final* core membership, then refresh
 * coreSouls/categorySouls. Each component refunds into the *one* upgrade that absorbs it
 * ({@link absorptionMap}), so a single Sprint Boots shared by Trophy Collector and Enduring Speed
 * discounts only one of them — no double-credit. A chain (A→B→C, all kept) still nets to the top
 * item's price because each link refunds the full sticker of the one below it. Mutates phases; run
 * once core membership is settled (after dedupe, or after a comp re-rank). Leaves `soulBudget` alone —
 * it's a stable population reference, so coreSouls is shown against it as-is (under, or modestly over).
 */
export function recomputeCosts(
  phases: BuildPhase[],
  items: Map<number, Item>,
): void {
  const into = absorptionMap(phases.flatMap((p) => p.core)); // component id → its absorbing upgrade
  const refund = new Map<number, number>(); // upgrade id → souls its absorbed components refund
  for (const [compId, up] of into)
    refund.set(
      up.id,
      (refund.get(up.id) ?? 0) + (items.get(compId)?.cost ?? 0),
    );

  for (const p of phases) {
    for (const b of p.core)
      b.effectiveCost = Math.max(0, b.item.cost - (refund.get(b.item.id) ?? 0));
    p.coreSouls = p.core.reduce(
      (s, b) => s + (b.effectiveCost ?? b.item.cost),
      0,
    );
    p.categorySouls = categorySouls(p.core);
  }
}

/** Souls the chosen core spends per shown category — marginal (net of absorbed components), to
 * match coreSouls. `effectiveCost` is set by recomputeCosts; falls back to sticker before then. */
export function categorySouls(
  core: BuildItem[],
): Record<"weapon" | "vitality" | "spirit", number> {
  const out = { weapon: 0, vitality: 0, spirit: 0 };
  for (const b of core)
    if (b.item.slot in out)
      out[b.item.slot as "weapon" | "vitality" | "spirit"] +=
        b.effectiveCost ?? b.item.cost;
  return out;
}
