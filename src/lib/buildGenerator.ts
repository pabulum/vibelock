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

import type {
  BuildItem,
  BuildPhase,
  BuildRole,
  FlowNode,
  GeneratedBuild,
  Hero,
  Item,
  ItemFlowStats,
  NeedKind,
  SlotType,
} from '../types';

const PHASE_META = [
  { label: 'Lane', timeLabel: '0–9 min' },
  { label: 'Early mid', timeLabel: '9–20 min' },
  { label: 'Mid', timeLabel: '20–30 min' },
  { label: 'Late', timeLabel: '30+ min' },
];

// --- Tuning knobs (top of file on purpose; no math needed to adjust) ---
const MIN_SUPPORT_ABS = 40; // ignore items bought by fewer than this many players
const MIN_SUPPORT_FRAC = 0.03; // ...or fewer than 3% of the phase's players
const UNIVERSAL_PICK = 0.3; // ≥30% pick rate ⇒ "build it every game"
const VALUE_EDGE = 0.02; // value/situational picks must beat the baseline by ≥2 pts
const FILL_WR_FLOOR = 0; // the category ratio is a *soft* bias, not a hard quota: a discretionary
// (sub-universal) pick is only slotted to serve its category's share if it at least breaks even
// (≥ baseline − this). Below that the share yields the slot to a category that *has* a pick worth
// building — encoding "the players who buy it here may simply be wrong." So when every spirit option
// in a phase loses (Paradox lane: Extra Spirit −1.5pt, Mystic Burst −0.5pt), spirit takes no slot and
// the freed slot buys a winning weapon/green instead. Universals bypass this — an everyone-builds
// staple is the backbone even when its raw WR trails (Headshot Booster, 67% pick). Loosen toward a
// small positive tolerance to let near-baseline pickups hold category slots again.
const CO_OCCUR_MIN = 1; // two comparable-cost every-game picks in a slot are assumed to co-occur
// only when their pick rates sum past this (inclusion–exclusion: pA+pB−1 players must buy both);
// below it they can be bought by disjoint players — substitutes — so only one holds a core slot.
const SUBSTITUTE_WR_EDGE = 0.01; // which of two substitutes holds the shared slot: the core fill
// seats by pick rate, so the more *popular* one gets there first and holds it by default. But
// popularity among comparable substitutes is mostly habit, not correctness — so the other takes the
// slot instead when it wins at least this much more (adjusted WR). A real edge beats habit; noise
// doesn't unseat a clear favorite. (Paradox lane: High-Velocity Rounds' ~2pt edge over the more-
// popular Monster Rounds flips it into core, and Monster Rounds becomes its swap.)
const SOUL_SLACK = 1.15; // allow 15% over the soul budget before stopping
const SITUATIONAL_MAX = 5;
const COMEBACK_GAP = 0.035; // adj−raw this big ⇒ a reactive "hold up when behind" pick
const COMEBACK_RESERVE = 2; // situational slots held for the best comeback picks (vs damage)
const SELL_BEFORE_S = 1500; // a cheap item sold before ~25 min is a placeholder
export const SLOT_CAP = 12; // 9 base + 3 flex slots (unlocked via Walker kills)
// --- Overtime buy-list ranking (see overtimeBuyList) ---
const OVERTIME_MIN_TIER = 3; // an overtime buy is an upgrade you spend surplus souls on, never a cheap
// stat-stick you're replacing. T4 dominates the late window, but standout T3s (Kelvin's Rapid Recharge,
// Haze's Fortitude) genuinely top it — so we keep T3+, not T4-only, and let the late win rate rank them.
const OVERTIME_MAX = 10; // a focused priority list, not the whole catalogue
const OVERTIME_PICK_HALF = 0.05; // a pick bought by this fraction of late-game players gets half credit
// for its win-rate edge; rarer picks are shrunk toward zero so a small-sample shine (Refresher, 2% pick
// / n≈130 / +18pt) can't outrank the proven late staples.
const OVERTIME_COMMIT_WEIGHT = 0.05; // ...plus a small bonus per unit pick rate, so a widely-bought late
// pick edges out an equally-rated rarity.

// --- Need-aware situational pick (see NeedKind) ---
// A need like sustain is bought by most players but split across substitutes (Extra Regen /
// Restorative Shot / Healing Rite), so no single item clears the pick-rate core bar; and it's
// usually win-rate *neutral* (buyers and non-buyers win alike — it's QOL, not an edge), so it
// also misses the situational value gate. The honest home is therefore neither: we surface the
// plurality item as a **conditional situational pick** ("most players grab one") when the need
// is near-universal, one item clearly leads it, and it isn't a trap (buyers don't underperform).
// We never force it into *core* — a genuine every-game sustain item (Abrams' Extra Regen, 94%)
// already clears the pick bar on its own and lands in core through the normal fill.
const NEED_DEMAND_FLOOR = 0.55; // Σ of a need's member pick rates this high ⇒ a near-universal need
const NEED_PLURALITY = 0.4; // ...and its lead item must own ≥40% of that demand to name one
const NEED_MAX_TIER = 2; // ...and we only count cheap *pickups* (≤T2): a T3+ item that happens to
// heal (Headhunter, Leech) is a scaling buy, not the reactive sustain a player grabs to hold a lane
const NEED_MAX_WR_DROP = 0.03; // ...and skip it if buyers win this far below baseline (a trap, not QOL)

// Categories we budget across, in fill order. Weapon is filled last on purpose: it's
// the plurality buy most phases, so giving the reactively-bought categories (greens,
// then spirit) first claim on the budget stops weapon from starving them of a slot.
const FILL_ORDER: Array<'weapon' | 'vitality' | 'spirit'> = ['vitality', 'spirit', 'weapon'];

/** Options for {@link generateBuild}. */
export interface BuildOptions {
  /** Guarantee a slot for the plurality answer to a near-universal need (default true). */
  needs?: boolean;
}

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

  // Each item's primary phase = the column where the highest fraction of players buy it. The core
  // fill skips an item outside its primary phase, because dedupeAcrossPhases keeps it only there —
  // filling an earlier phase's slot with a mostly-bought-later item just leaves that slot empty.
  const primaryCol = primaryColumnByItem(flow);
  // Phases are built in order so each can see what earlier phases committed to buy (`owned`): an
  // upgrade is discounted by a component you already hold, both when gating what fits the soul budget
  // and in the displayed spend. `claimed` tracks components already absorbed by an upgrade so a single
  // component can't discount two of them (Sprint Boots → Enduring Speed *or* Trophy Collector, not
  // both); buildPhase reads it for the discount and adds to it as it seats absorbing picks.
  const owned = new Set<number>();
  const claimed = new Set<number>();
  const phases: BuildPhase[] = [];
  for (let col = 0; col < PHASE_META.length; col++) {
    const phase = buildPhase(col, flow, items, baselineWinRate, buyTimes, opts, primaryCol, owned, claimed);
    phases.push(phase);
    for (const b of phase.core) owned.add(b.item.id);
  }

  dedupeAcrossPhases(phases);
  dropSamePhaseComponents(phases); // a component+upgrade in one phase ⇒ keep only the upgrade
  recomputeCosts(phases, items); // finalize marginal costs against post-dedupe membership
  const standingSlots = markTransient(phases, sellTimes);
  annotateRelations(phases, flow, items);
  annotateSlotRelations(phases);

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
    overtimeBuys: overtimeBuyList(flow, items, baselineWinRate),
  };
}

/**
 * A prioritized "spend your surplus" list for games that drag past the ~30-minute mark with the build
 * already full. These aren't a phase — they're the items to *replace your lowest-tier slots with* once
 * souls stop being the constraint, ranked by how they perform in the **late window specifically** (the
 * 30+ flow column), because a pick that's great at 20 minutes isn't necessarily what wins a 60-minute
 * base race. T1/T2 stat-sticks are excluded — they're what you're upgrading out of — and components
 * whose upgrade is also listed drop out (buy the finished item). Same small-sample regularization as
 * the rest of the build, so a 2%-pick luxury with a shiny late win rate can't outrank the proven
 * staples. Repeats from the main build are fine: if Boundless Spirit is already core, it still belongs
 * here as a buy — the list is "where the next chunk of souls goes", not "what's not in your build".
 */
function overtimeBuyList(
  flow: ItemFlowStats,
  items: Map<number, Item>,
  baselineWinRate: number,
): BuildItem[] {
  // Read the LATE column only — the 30+ minute window is the relevant signal for a long game, so an
  // item is judged on what it does *then*, not on its blended-across-the-game average.
  let maxCol = 0;
  for (const n of flow.nodes) if (n.column > maxCol) maxCol = n.column;
  const lateCol = Math.min(PHASE_META.length - 1, maxCol);
  const reached = flow.reached_per_column[lateCol] || flow.baseline.matches || 1;

  let pool = flow.nodes
    .filter((n) => n.column === lateCol)
    .map((n) => toCandidate(n, reached, items))
    .filter(
      (c): c is BuildItem =>
        c !== null && c.item.tier >= OVERTIME_MIN_TIER && c.sample >= MIN_SUPPORT_ABS,
    );

  // Keep the upgrade, not its parts: drop any candidate that's a (transitive) component of another.
  const superseded = supersededComponents(pool, items);
  pool = pool.filter((b) => !superseded.has(b.item.id));

  const edge = (b: BuildItem) => b.adjustedWinRate - baselineWinRate;
  const shrink = (b: BuildItem) => b.pickRate / (b.pickRate + OVERTIME_PICK_HALF);
  const score = (b: BuildItem) => edge(b) * shrink(b) + OVERTIME_COMMIT_WEIGHT * b.pickRate;
  const role = (b: BuildItem): BuildRole =>
    b.pickRate >= UNIVERSAL_PICK ? 'universal' : edge(b) >= VALUE_EDGE ? 'value' : 'filler';

  // Only items that actually win late, highest priority (regularized late edge) first.
  return pool
    .filter((b) => edge(b) > 0)
    .sort((a, b) => score(b) - score(a))
    .slice(0, OVERTIME_MAX)
    .map<BuildItem>((b) => ({ ...b, role: role(b), effectiveCost: b.item.cost, why: b.item.effect ?? '' }));
}

/** Item ids in `pool` that are a (transitive) component of some *other* item in `pool` — the parts
 * you've already built into a finished item, so they shouldn't hold their own endgame slot. */
function supersededComponents(pool: BuildItem[], items: Map<number, Item>): Set<number> {
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

/** Item id → the column where the largest fraction of players buy it (its primary phase). */
function primaryColumnByItem(flow: ItemFlowStats): Map<number, number> {
  const best = new Map<number, { col: number; pick: number }>();
  for (const n of flow.nodes) {
    const reached = flow.reached_per_column[n.column] || flow.baseline.matches || 1;
    const pick = reached > 0 ? n.players / reached : 0;
    const cur = best.get(n.item_id);
    if (!cur || pick > cur.pick) best.set(n.item_id, { col: n.column, pick });
  }
  const out = new Map<number, number>();
  for (const [id, v] of best) out.set(id, v.col);
  return out;
}

/** Keep each core item only in the phase where it's most commonly bought (you buy it once). */
function dedupeAcrossPhases(phases: BuildPhase[]): void {
  const bestPhase = new Map<number, number>(); // item id → phase index with highest pick rate
  phases.forEach((p, i) => {
    for (const b of p.core) {
      const cur = bestPhase.get(b.item.id);
      if (cur === undefined || b.pickRate > phases[cur].core.find((x) => x.item.id === b.item.id)!.pickRate) {
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
 * sticker = component + marginal). The item target drops with it so "N/M items" stays coherent.
 * Cross-phase components are left alone — there you really do buy the cheap item in an earlier phase
 * and upgrade later, so it holds a genuine (transient) slot and earns its row. Run after dedupe (final
 * membership known) and before recomputeCosts (so the kept upgrade prices at full sticker).
 */
function dropSamePhaseComponents(phases: BuildPhase[]): void {
  for (const p of phases) {
    const absorbedHere = absorptionMap(p.core); // component id → its same-phase absorbing upgrade
    if (absorbedHere.size === 0) continue;
    const before = p.core.length;
    p.core = p.core.filter((b) => !absorbedHere.has(b.item.id));
    p.targetItems = Math.max(p.core.length, p.targetItems - (before - p.core.length));
  }
}

/**
 * Each in-build component → the single recommended upgrade that absorbs it. A component can only be
 * consumed once, so when two kept items build from the same one (Trophy Collector and Enduring Speed
 * both build from Sprint Boots) only one absorbs it — the other pays full price. Last in core order
 * (≈ buy order) wins, so the "builds into" note and the cost refund always name the same upgrade.
 */
function absorptionMap(core: BuildItem[]): Map<number, Item> {
  const coreIds = new Set(core.map((b) => b.item.id));
  const into = new Map<number, Item>();
  for (const b of core)
    for (const compId of b.item.componentIds) if (coreIds.has(compId)) into.set(compId, b.item);
  return into;
}

/**
 * Flags core items that don't hold a permanent slot — either they build into another
 * recommended item (a shared slot) or they're a cheap item players typically sell —
 * and returns the count of items that *do* hold a slot. Mutates the phases' core items.
 */
function markTransient(phases: BuildPhase[], sellTimes: Map<number, number>): number {
  const core = phases.flatMap((p) => p.core);
  const buildsInto = absorptionMap(core); // component → the one upgrade that absorbs it

  for (const b of core) {
    const upgrade = buildsInto.get(b.item.id);
    const sellTime = sellTimes.get(b.item.id);
    if (upgrade) {
      b.transient = true;
      b.transientReason = `builds into ${upgrade.name}`;
    } else if (b.item.tier <= 1 && sellTime !== undefined && sellTime > 0 && sellTime < SELL_BEFORE_S) {
      b.transient = true;
      b.transientReason = `often sold ~${mmss(sellTime)}`;
    }
  }

  return core.filter((b) => !b.transient).length;
}

function mmss(s: number): string {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

const COST_BAND = 1.6; // a "swap" only makes sense between items of comparable cost
function withinCostBand(a: number, b: number): boolean {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return lo > 0 && hi / lo <= COST_BAND;
}

/**
 * What an item costs *once the components you already own are absorbed into it* — Deadlock refunds a
 * built item's components when you upgrade, so owning High-Velocity Rounds (800) drops Opening Rounds
 * from its 1600 sticker to an 800 marginal. `owns(id)` answers "is this component already in the
 * build". Only *direct* components are credited (the discount Deadlock actually applies); a chain
 * (A→B→C, all kept) nets to the top item's price because each link credits the one below it. Floored
 * at 0 so a malformed cost can't go negative.
 */
function marginalCost(item: Item, owns: (id: number) => boolean, items: Map<number, Item>): number {
  let c = item.cost;
  for (const compId of item.componentIds) if (owns(compId)) c -= items.get(compId)?.cost ?? 0;
  return Math.max(0, c);
}

/**
 * Recompute every phase's marginal costs against the *final* core membership, then refresh
 * coreSouls/categorySouls. Each component refunds into the *one* upgrade that absorbs it
 * ({@link absorptionMap}), so a single Sprint Boots shared by Trophy Collector and Enduring Speed
 * discounts only one of them — no double-credit. A chain (A→B→C, all kept) still nets to the top
 * item's price because each link refunds the full sticker of the one below it. Mutates phases; run
 * once core membership is settled (after dedupe, or after a comp re-rank). Also lifts each phase's
 * displayed budget to at least its true spend, so the discount can never read as "over budget".
 */
function recomputeCosts(phases: BuildPhase[], items: Map<number, Item>): void {
  const into = absorptionMap(phases.flatMap((p) => p.core)); // component id → its absorbing upgrade
  const refund = new Map<number, number>(); // upgrade id → souls its absorbed components refund
  for (const [compId, up] of into)
    refund.set(up.id, (refund.get(up.id) ?? 0) + (items.get(compId)?.cost ?? 0));

  for (const p of phases) {
    for (const b of p.core) b.effectiveCost = Math.max(0, b.item.cost - (refund.get(b.item.id) ?? 0));
    p.coreSouls = p.core.reduce((s, b) => s + (b.effectiveCost ?? b.item.cost), 0);
    p.categorySouls = categorySouls(p.core);
    p.soulBudget = Math.max(p.soulBudget, p.coreSouls);
  }
}

/**
 * The same-slot, comparable-cost every-game pick already in `core` that `c` does *not* co-occur
 * with (its substitute), or undefined. Co-occurrence is read off the marginals: by inclusion–
 * exclusion two picks must overlap once their pick rates sum past {@link CO_OCCUR_MIN}; below that
 * they can be bought by disjoint players, so the build shouldn't assert both as every-game core
 * (e.g. Paradox lane: Monster Rounds 43% and High-Velocity Rounds 37% sum to 0.80 — players take
 * one or the other; only ~4% buy both). Scoped to comparable cost because the floor only
 * discriminates among same-role alternatives — across tiers any two moderately-popular picks
 * "could be disjoint", which would wrongly bench scaling items (Opening Rounds, Headhunter) that
 * are bought *alongside* the cheap stat-sticks, not instead of them.
 */
function substituteRival(c: BuildItem, core: BuildItem[]): BuildItem | undefined {
  if (c.pickRate < UNIVERSAL_PICK) return undefined;
  return core.find(
    (b) =>
      b.item.slot === c.item.slot &&
      b.pickRate >= UNIVERSAL_PICK &&
      withinCostBand(b.item.cost, c.item.cost) &&
      b.pickRate + c.pickRate < CO_OCCUR_MIN,
  );
}

/**
 * True when `item` is built (transitively) from any id in `roots` — i.e. it's an upgrade of one of
 * them. Used to keep a benched substitute's whole line out of core: the slot a swap vacates is real
 * and should be filled, but not by the swap's own upgrade (Opening Rounds is built from
 * High-Velocity Rounds) — that would put the upgrade in core *and* the component as its swap.
 */
function buildsFromAny(item: Item, roots: Set<number>, items: Map<number, Item>): boolean {
  if (roots.size === 0) return false;
  return item.componentIds.some((c) => {
    if (roots.has(c)) return true;
    const comp = items.get(c);
    return comp ? buildsFromAny(comp, roots, items) : false;
  });
}

/**
 * Attach "learn about this item" relationship clues, mutating the phases' items:
 *  - `buildsToward`: the item this is a component of, ranked by how often this hero's players
 *    actually made that jump (flow `edges`), then by overall pick — i.e. its real upgrade.
 *  - `swapFor` (situational only): the same-slot core pick whose cost is closest — the slot
 *    this situational item is competing for.
 */
function annotateRelations(phases: BuildPhase[], flow: ItemFlowStats, items: Map<number, Item>): void {
  // Edge weights: players who went from item X to item Y next, summed across columns.
  const edgeW = new Map<number, Map<number, number>>();
  for (const e of flow.edges) {
    let m = edgeW.get(e.from_item_id);
    if (!m) edgeW.set(e.from_item_id, (m = new Map()));
    m.set(e.to_item_id, (m.get(e.to_item_id) ?? 0) + e.matches);
  }
  // How many of this hero's players touch each item at all (relevance gate + tiebreak).
  const flowPlayers = new Map<number, number>();
  for (const n of flow.nodes) flowPlayers.set(n.item_id, (flowPlayers.get(n.item_id) ?? 0) + n.players);
  // Reverse component tree: component id → items built from it.
  const builtFrom = new Map<number, Item[]>();
  for (const it of items.values())
    for (const c of it.componentIds) {
      const arr = builtFrom.get(c);
      if (arr) arr.push(it);
      else builtFrom.set(c, [it]);
    }

  const buildsToward = (id: number): { id: number; name: string } | undefined => {
    // Only upgrades this hero's players actually make (in the flow), best transition first.
    const cands = (builtFrom.get(id) ?? []).filter((y) => flowPlayers.has(y.id));
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
    for (const b of p.core) if (!b.transient) b.buildsToward = buildsToward(b.item.id);
    for (const s of p.situational) s.buildsToward = buildsToward(s.item.id);
  }
}

/**
 * Slot-relative clues — `coreLater` ("core by Mid, rush if ahead") and `swapFor` (the same-slot
 * comparable-cost core pick this is an alternative to). Pure over phases and *resets first*, so
 * it can be re-run after a comp re-rank shuffles core membership without leaving stale pairings.
 */
export function annotateSlotRelations(phases: BuildPhase[]): void {
  const coreCols = new Map<number, number[]>();
  for (const p of phases)
    for (const b of p.core) {
      const arr = coreCols.get(b.item.id);
      if (arr) arr.push(p.column);
      else coreCols.set(b.item.id, [p.column]);
    }

  for (const p of phases) {
    for (const b of p.core) {
      b.swapFor = undefined;
      b.coreLater = undefined;
    }
    for (const s of p.situational) {
      s.swapFor = undefined;
      s.coreLater = undefined;
      // Explicit substitution link (held out of core as an alternative to a specific pick): pair to
      // that rival when it's still core here, not to the merely cost-closest pick below.
      if (s.swapForId !== undefined) {
        const rival = p.core.find((c) => c.item.id === s.swapForId);
        if (rival) {
          s.swapFor = { id: rival.item.id, name: rival.item.name };
          continue;
        }
      }
      // Same item core in a later phase ⇒ a rush/stretch target ("buy early if ahead"), not a swap.
      const laterCol = (coreCols.get(s.item.id) ?? []).find((c) => c > p.column);
      if (laterCol !== undefined) {
        s.coreLater = PHASE_META[laterCol].label;
        continue;
      }
      // Else pair with a same-slot core pick of *comparable cost* — a real alternative, not a
      // 6.4k item dressed up as a swap for a 1.6k one.
      const peers = p.core.filter(
        (c) => c.item.slot === s.item.slot && withinCostBand(c.item.cost, s.item.cost),
      );
      if (peers.length) {
        const closest = peers.reduce((best, c) =>
          Math.abs(c.item.cost - s.item.cost) < Math.abs(best.item.cost - s.item.cost) ? c : best,
        );
        s.swapFor = { id: closest.item.id, name: closest.item.name };
      }
    }
  }
}

function buildPhase(
  col: number,
  flow: ItemFlowStats,
  items: Map<number, Item>,
  baselineWinRate: number,
  buyTimes: Map<number, number>,
  opts: BuildOptions,
  primaryCol: Map<number, number>,
  owned: Set<number>,
  claimed: Set<number>,
): BuildPhase {
  // reached_per_column is the correct denominator for an unlocked query: players
  // who were still buying in this phase.
  const reached = flow.reached_per_column[col] || flow.baseline.matches || 1;
  const minSupport = Math.max(MIN_SUPPORT_ABS, MIN_SUPPORT_FRAC * reached);

  const candidates = flow.nodes
    .filter((n) => n.column === col)
    .map((n) => toCandidate(n, reached, items))
    .filter((c): c is BuildItem => c !== null && c.sample >= minSupport);

  // An upgrade of a component bought in an earlier phase costs only its marginal here — credit that
  // both for our spend and for the population budget, so the bar compares like with like. A component
  // already absorbed by an earlier upgrade (`claimed`) is gone, so it can't discount a second one.
  const ownedBefore = (id: number) => owned.has(id) && !claimed.has(id);

  // Budget for the phase, from what players actually do. This raw figure sums pick-mass × cost over
  // *every* candidate, so mutually-exclusive lines (Monster Rounds vs the High-Velocity Rounds →
  // Opening Rounds line) both count even though a player buys one — it's a generous cap for the fill,
  // but inflated as a *target*. We deflate the displayed budget below, once we know what got benched.
  const buys = candidates.reduce((a, c) => a + c.sample, 0);
  const targetItems = Math.max(1, Math.round(buys / reached));
  const soulBudget =
    candidates.reduce((a, c) => a + c.sample * marginalCost(c.item, ownedBefore, items), 0) / reached;

  // Bias the phase's items across weapon/vitality/spirit toward the proportion real players of this
  // hero *buy* in each category (count share, not soul share — slots are bodies, so an expensive
  // category shouldn't claim extra slots just because its items cost more). Kept as a *fractional*
  // target (0.6 of a spirit slot, not a forced 1) — the fill below treats it as a pull, not a quota,
  // so a thin category only takes a slot when it has a pick worth building. Without any category
  // bias the build is category-blind: defensive greens are bought reactively, miss the pick/WR
  // gates, and the budget goes entirely to weapon/spirit — e.g. zero greens in lane.
  const share = categoryCountShare(candidates);
  const fracTarget: Record<'weapon' | 'vitality' | 'spirit', number> = {
    weapon: share.weapon * targetItems,
    vitality: share.vitality * targetItems,
    spirit: share.spirit * targetItems,
  };

  const chosen = new Set<number>();
  const core: BuildItem[] = [];
  const swaps: BuildItem[] = []; // every-game picks held out of core as substitutes (see substituteRival)
  const benchedIds = new Set<number>(); // their upgrade lines are off-limits for filling core (see buildsFromAny)
  let coreSouls = 0;

  // The components `c` would absorb: in the build already (earlier phase `owned`, or earlier this
  // phase `chosen`) and not yet consumed by another upgrade (`claimed`). Returns the ids so the caller
  // can mark them claimed once `c` actually seats — that's what stops a shared component (Sprint Boots)
  // from discounting two upgrades. Each is consumed at most once; the second upgrade pays full.
  const absorbs = (c: BuildItem): number[] =>
    c.item.componentIds.filter((id) => (owned.has(id) || chosen.has(id)) && !claimed.has(id));
  const costAfter = (c: BuildItem, absorb: number[]): number =>
    Math.max(0, c.item.cost - absorb.reduce((s, id) => s + (items.get(id)?.cost ?? 0), 0));

  // Try to seat one candidate in core. Returns true only when it actually took a slot (so the caller
  // decrements its quota); a soul/line/phase miss or a benched substitute returns false.
  const tryAddCore = (c: BuildItem): boolean => {
    if (chosen.has(c.item.id) || benchedIds.has(c.item.id)) return false;
    const absorb = absorbs(c);
    const cost = costAfter(c, absorb);
    if (coreSouls + cost > soulBudget * SOUL_SLACK) return false; // a cheaper pick may still fit
    // Don't fill a slot with the upgrade of an item we've already benched as a swap — that's the same
    // line (Opening Rounds builds from High-Velocity Rounds), so it'd put the upgrade in core and the
    // component as its swap. Skip it; the slot stays open for a genuinely different item.
    if (buildsFromAny(c.item, benchedIds, items)) return false;
    // Skip items whose primary phase is *later* — dedupeAcrossPhases keeps them there, so placing one
    // in this earlier slot just leaves it empty (they still surface as a situational, "core by Mid").
    // Items primary in an earlier phase are allowed through: if they didn't win a slot there they'd
    // otherwise vanish, and a later phase is a fine home for them.
    if ((primaryCol.get(c.item.id) ?? col) > col) return false;
    // Substitution guard: this every-game pick is an alternative to one already in core (a same-slot,
    // comparable-cost pick it doesn't co-occur with) — you buy one or the other, so the two share a
    // single slot. The rival got there first only because the fill seats by pick rate; that makes the
    // more *popular* substitute the default holder. Pick rate is the right gate for "is this core-
    // worthy", but the wrong tiebreak for "which of two substitutes do I commit to" — there win rate
    // decides. So when this pick wins meaningfully more games it evicts the rival and takes the slot;
    // otherwise the rival keeps it. Either way the loser becomes the winner's swap and its upgrade
    // line stays out of core (benchedIds), and we return false: the slot was already counted when the
    // rival first took it, so this is a *replacement*, not a new item (the phase keeps its count, and
    // a different co-occurring item still fills the next slot).
    const rival = substituteRival(c, core);
    if (rival) {
      if (c.adjustedWinRate >= rival.adjustedWinRate + SUBSTITUTE_WR_EDGE) {
        core.splice(core.indexOf(rival), 1);
        coreSouls -= rival.item.cost; // a substitute is a stat-stick with no in-build component to net out
        chosen.delete(rival.item.id);
        core.push({ ...c, role: 'universal' }); // a substitute is by definition over the pick bar
        coreSouls += cost;
        chosen.add(c.item.id);
        absorb.forEach((id) => claimed.add(id));
        swaps.push({ ...rival, role: 'situational', swapForId: c.item.id });
        benchedIds.add(rival.item.id);
      } else {
        swaps.push({ ...c, role: 'situational', swapForId: rival.item.id });
        benchedIds.add(c.item.id);
      }
      return false;
    }
    // Mirror the bucket logic in categoryPriority: a quota-filling pick that beats neither the
    // pick-rate bar nor the value gate is `filler`, not a `value` pick.
    const role: BuildRole =
      c.pickRate >= UNIVERSAL_PICK
        ? 'universal'
        : c.adjustedWinRate >= baselineWinRate + VALUE_EDGE
          ? 'value'
          : 'filler';
    core.push({ ...c, role });
    coreSouls += cost;
    chosen.add(c.item.id);
    absorb.forEach((id) => claimed.add(id));
    return true;
  };

  // Fill core toward the item target, biased to the category ratio but never forcing a loser in.
  // Each category has its own best-first list (categoryPriority: universals, then value staples, then
  // the rest by pick). "Worth building" = a universal (everyone-builds) pick, or a discretionary pick
  // that isn't a clear loser (FILL_WR_FLOOR) — a popular-but-bad item never holds a slot.
  const pools: Record<'weapon' | 'vitality' | 'spirit', BuildItem[]> = {
    weapon: categoryPriority(candidates, 'weapon', baselineWinRate, chosen),
    vitality: categoryPriority(candidates, 'vitality', baselineWinRate, chosen),
    spirit: categoryPriority(candidates, 'spirit', baselineWinRate, chosen),
  };
  const cursor: Record<'weapon' | 'vitality' | 'spirit', number> = { weapon: 0, vitality: 0, spirit: 0 };
  const allocated: Record<'weapon' | 'vitality' | 'spirit', number> = { weapon: 0, vitality: 0, spirit: 0 };
  const seatable = (c: BuildItem) =>
    c.pickRate >= UNIVERSAL_PICK || c.adjustedWinRate >= baselineWinRate - FILL_WR_FLOOR;
  // The category's next candidate worth trying — skipping ones already taken, benched, or losing —
  // or undefined once it's spent. Advances the cursor past the skips it walks over.
  const peek = (slot: 'weapon' | 'vitality' | 'spirit'): BuildItem | undefined => {
    while (cursor[slot] < pools[slot].length) {
      const c = pools[slot][cursor[slot]];
      if (chosen.has(c.item.id) || benchedIds.has(c.item.id) || !seatable(c)) {
        cursor[slot]++;
        continue;
      }
      return c;
    }
    return undefined;
  };

  // Phase A — award only *whole* slots the ratio genuinely earns. A category gets the next slot when
  // it's owed at least half an item (deficit ≥ ½) and has a pick worth building, most-owed first. A
  // fractional tail under half a slot earns nothing here: that's what stops a thin category from
  // *minting* a slot for a weak pick (Paradox lane spirit is ~0.4 of a slot — it gets none, instead
  // of rounding up and dragging in Extra Spirit / Mystic Burst). Its share is left for Phase B.
  const RATIO_SLOT = 0.5;
  for (;;) {
    if (core.length >= targetItems) break;
    let pick: 'weapon' | 'vitality' | 'spirit' | undefined;
    let bestDeficit = RATIO_SLOT;
    for (const slot of FILL_ORDER) {
      if (!peek(slot)) continue; // no pick worth building in this category — it sits out
      const deficit = fracTarget[slot] - allocated[slot];
      if (deficit >= bestDeficit) {
        bestDeficit = deficit;
        pick = slot;
      }
    }
    if (!pick) break;
    const c = peek(pick)!;
    cursor[pick]++; // consume it whether or not it seats (a soul/line miss mustn't re-loop forever)
    if (tryAddCore(c)) allocated[pick]++;
  }

  // Phase B — top up to the item count with the most-bought remaining pick worth building, of *any*
  // category: the fractional tails Phase A left on the table, plus any slot a substitute emptied. The
  // ratio already shaped the whole slots, so the leftover goes by commonality, not category — and
  // it's still merit-gated (seatable), so the padding is a real pick a player would buy, not a loser
  // dragged in to hit the number. A phase with nothing worth building simply runs short.
  if (core.length < targetItems) {
    const rest = candidates
      .filter((c) => !chosen.has(c.item.id) && !benchedIds.has(c.item.id) && seatable(c))
      .sort((a, b) => b.pickRate - a.pickRate);
    for (const c of rest) {
      if (core.length >= targetItems) break;
      tryAddCore(c);
    }
  }

  // Situational: the best leftover value picks across every category — but reserve a couple
  // of slots for the strongest "comeback" picks (adj ≫ raw: reactive items that hold up when
  // behind). Sorting purely by win rate lets raw damage items crowd those out, so a real
  // late-game stabilizer (e.g. Fortitude) never surfaces. Reserve first, then fill by WR.
  const swapIds = new Set(swaps.map((s) => s.item.id));
  const eligible = candidates
    .filter(
      (c) =>
        !chosen.has(c.item.id) &&
        !swapIds.has(c.item.id) &&
        !buildsFromAny(c.item, benchedIds, items) && // an upgrade of a swap is that swap's line, not its own pick
        c.adjustedWinRate >= baselineWinRate + VALUE_EDGE,
    )
    .sort((a, b) => b.adjustedWinRate - a.adjustedWinRate);
  const reserved = eligible
    .filter((c) => c.adjustedWinRate - c.rawWinRate >= COMEBACK_GAP)
    .slice(0, COMEBACK_RESERVE);
  const reservedIds = new Set(reserved.map((c) => c.item.id));
  // Substitution swaps lead the list (they're the explicit alternative to a core pick); the
  // strongest value/comeback leftovers fill whatever cap is left.
  const value = [...reserved, ...eligible.filter((c) => !reservedIds.has(c.item.id))]
    .slice(0, Math.max(0, SITUATIONAL_MAX - swaps.length))
    .sort((a, b) => b.adjustedWinRate - a.adjustedWinRate)
    .map<BuildItem>((c) => ({ ...c, role: 'situational' }));
  const situational = [...swaps, ...value];

  // Conditional need pick: when a near-universal, win-rate-neutral need (sustain) is split across
  // substitutes so its lead item missed both the core and the value gates above, surface that
  // item here as a flagged optional pickup — "most players grab one; no win-rate cost" — rather
  // than forcing it into the every-game core. Skipped when it's already in the build.
  if (opts.needs !== false) {
    const need = dominantNeed(candidates, 'sustain', baselineWinRate);
    if (need && !chosen.has(need.item.id) && !situational.some((s) => s.item.id === need.item.id)) {
      situational.unshift({ ...need, role: 'need', why: 'optional lane sustain — most players grab one' });
      if (situational.length > SITUATIONAL_MAX) situational.pop(); // keep the cap; drops the weakest WR pick
    }
  }

  // Enrich: the value gate alone can leave a thin 1–2 line list, hiding common picks a player would
  // want to see (sustain, popular alternatives). Round the list out to the cap with the most-bought
  // remaining picks even if they don't clear the win-rate bar — labelled honestly (`value` only if it
  // actually beats the bar, else `filler`) so the chip doesn't oversell a win-rate-neutral pickup.
  if (situational.length < SITUATIONAL_MAX) {
    const shown = new Set([...core, ...situational].map((b) => b.item.id));
    for (const c of [...candidates].sort((a, b) => b.pickRate - a.pickRate)) {
      if (situational.length >= SITUATIONAL_MAX) break;
      if (shown.has(c.item.id) || benchedIds.has(c.item.id)) continue;
      if (buildsFromAny(c.item, benchedIds, items)) continue; // an upgrade of a swap is that swap's line
      const role: BuildRole = c.adjustedWinRate >= baselineWinRate + VALUE_EDGE ? 'value' : 'filler';
      situational.push({ ...c, role });
      shown.add(c.item.id);
    }
  }

  const buyTime = (b: BuildItem) => buyTimes.get(b.item.id) ?? Number.POSITIVE_INFINITY;
  // The "why" is what the item does — the WR/pick numbers are already on the row — unless a pick
  // set its own rationale (the conditional need note above), which we keep.
  const withWhy = (b: BuildItem) => ({ ...b, why: b.why || b.item.effect || '' });

  // Deflate the displayed budget: drop the benched substitutes and their upgrade lines, the spend a
  // coherent build never makes (it picks one of each mutually-exclusive line). Without this the bar
  // shows a gap that can only be closed by buying redundant items. Component lines whose members are
  // *both* kept (Headshot Booster → Headhunter) are charged marginally — the upgrade nets out the
  // component, here and across phases — so they no longer double-count. Floor it at what this build
  // actually costs: a phase that front-loads a pricier-than-average item (e.g. an early Headhunter)
  // shouldn't read as "over budget" — it tops out at its own spend.
  const kept = candidates.filter((c) => !benchedIds.has(c.item.id) && !buildsFromAny(c.item, benchedIds, items));
  const keptIds = new Set(kept.map((c) => c.item.id));
  // A component already consumed by an upgrade (`claimed`) can't also discount another kept item.
  const ownsForBudget = (id: number) => (owned.has(id) || keptIds.has(id)) && !claimed.has(id);
  const deflatedBudget =
    kept.reduce((a, c) => a + c.sample * marginalCost(c.item, ownsForBudget, items), 0) / reached;
  const shownBudget = Math.max(deflatedBudget, coreSouls);

  return {
    column: col,
    label: PHASE_META[col].label,
    timeLabel: PHASE_META[col].timeLabel,
    targetItems,
    soulBudget: shownBudget,
    coreSouls,
    categorySouls: categorySouls(core),
    // Order by buy time so top-to-bottom reads as buy order.
    core: core.sort((a, b) => buyTime(a) - buyTime(b)).map(withWhy),
    situational: situational.map(withWhy), // already strongest-first by win rate
  };
}

/**
 * Fraction of phase *buys* real players put into each category (weapon/vitality/spirit) — by player
 * count, not souls, because the fill spends this on *slots* (bodies), and a slot is a slot whether it
 * holds an 800 stat-stick or a 6.2k carry. Weighting by souls would hand an expensive category extra
 * slots on top of the extra souls each slot already costs (Paradox mid: spirit is ~62% of buys but
 * ~64% of souls — soul-weighting tips its 2.5 slots to 3 and zeroes the greens the real build keeps).
 * The returned shares are a *soft* bias for the fill, which decides per slot whether a thin category
 * actually has a pick worth building before honoring its share.
 */
function categoryCountShare(candidates: BuildItem[]): Record<SlotType, number> {
  const buys: Record<SlotType, number> = { weapon: 0, vitality: 0, spirit: 0, unknown: 0 };
  let total = 0;
  for (const c of candidates) {
    buys[c.item.slot] += c.sample;
    total += c.sample;
  }
  if (total > 0) for (const k of Object.keys(buys) as SlotType[]) buys[k] /= total;
  return buys;
}

/**
 * The single item to surface for a cross-slot need this phase, or undefined to stay quiet.
 * Fires only when the need is near-universal by *summed* member pick (a union proxy: the items
 * are substitutes, so few players buy two) yet its lead item is below the core pick bar (so the
 * normal fill would drop it), clearly leads the need (so naming one item isn't arbitrary), and
 * isn't a trap (its buyers don't win well below baseline). When the lead is already a core pick,
 * the demand is split with no clear leader, or it's a loser, returns undefined — the value/
 * pick-rate fill handles it (or, honestly, nothing should be surfaced).
 */
function dominantNeed(candidates: BuildItem[], need: NeedKind, baselineWinRate: number): BuildItem | undefined {
  const members = candidates.filter((c) => c.item.need === need && c.item.tier <= NEED_MAX_TIER);
  if (members.length === 0) return undefined;
  const demand = members.reduce((a, c) => a + c.pickRate, 0);
  if (demand < NEED_DEMAND_FLOOR) return undefined; // not a near-universal need for this hero
  const lead = members.reduce((best, c) => (c.pickRate > best.pickRate ? c : best));
  if (lead.pickRate >= UNIVERSAL_PICK) return undefined; // already a core pick — don't relabel it
  if (lead.pickRate < NEED_PLURALITY * demand) return undefined; // genuinely split — don't name one
  if (lead.rawWinRate < baselineWinRate - NEED_MAX_WR_DROP) return undefined; // a trap, not QOL
  return lead;
}

/**
 * One category's candidates, best-first for filling *core* slots. Core means "what most
 * players build", so after the every-game staples we go by *commonality* among picks that
 * clear the value gate — the most-built decent item — not by raw win rate. Otherwise a
 * 6%-pick item with a shiny win rate steals a core slot from the 22%-pick staple everyone
 * actually buys (e.g. Battle Vest over Extra Health). Niche high-WR picks still surface in
 * `situational`. The remainder (so a guaranteed category is never empty) follows by pick rate.
 */
function categoryPriority(
  candidates: BuildItem[],
  slot: SlotType,
  baselineWinRate: number,
  chosen: Set<number>,
): BuildItem[] {
  const pool = candidates.filter((c) => c.item.slot === slot);
  const byPick = (a: BuildItem, b: BuildItem) => b.pickRate - a.pickRate;
  const universal = pool.filter((c) => c.pickRate >= UNIVERSAL_PICK).sort(byPick);
  const staples = pool
    .filter((c) => c.pickRate < UNIVERSAL_PICK && c.adjustedWinRate >= baselineWinRate + VALUE_EDGE)
    .sort(byPick);
  const rest = pool.filter((c) => !universal.includes(c) && !staples.includes(c)).sort(byPick);

  const ordered: BuildItem[] = [];
  const seen = new Set<number>(chosen);
  for (const c of [...universal, ...staples, ...rest]) {
    if (seen.has(c.item.id)) continue;
    seen.add(c.item.id);
    ordered.push(c);
  }
  return ordered;
}

/** Souls the chosen core spends per shown category — marginal (net of absorbed components), to
 * match coreSouls. `effectiveCost` is set by recomputeCosts; falls back to sticker before then. */
function categorySouls(core: BuildItem[]): Record<'weapon' | 'vitality' | 'spirit', number> {
  const out = { weapon: 0, vitality: 0, spirit: 0 };
  for (const b of core)
    if (b.item.slot in out) out[b.item.slot as 'weapon' | 'vitality' | 'spirit'] += b.effectiveCost ?? b.item.cost;
  return out;
}

function toCandidate(n: FlowNode, reached: number, items: Map<number, Item>): BuildItem | null {
  const item = items.get(n.item_id);
  if (!item) return null;
  const decided = n.wins + n.losses;
  return {
    item,
    role: 'value', // refined by buildPhase
    pickRate: reached > 0 ? n.players / reached : 0,
    adjustedWinRate: n.adjusted_win_rate,
    rawWinRate: decided > 0 ? n.wins / decided : 0,
    sample: n.players,
    avgNetWorthAtBuy: n.avg_net_worth_at_buy,
    why: '',
  };
}

const COMP_DEMOTE = -0.03; // a build pick this far below the matchup lean is "weak vs comp"

/**
 * Re-rank an already-generated build for a selected enemy comp, using each item's signed
 * comp edge (win-rate gain vs the comp, centered on the matchup lean). The category core-slot
 * counts and the universal staples are preserved — so the budget/category balance the base
 * build worked out survives — while within each category the comp decides which non-staples
 * fill the core slots, the role labels, and the order. Pure: returns a new build.
 */
export function rerankBuildForComp(
  build: GeneratedBuild,
  edgeByItem: Map<number, number>,
  items: Map<number, Item>,
): GeneratedBuild {
  const baseline = build.population.baselineWinRate;
  // Combined score: general strength over baseline, plus the comp-specific edge.
  const score = (b: BuildItem) => b.adjustedWinRate - baseline + (edgeByItem.get(b.item.id) ?? 0);
  const annotate = (b: BuildItem): BuildItem => {
    const compEdge = edgeByItem.get(b.item.id);
    return { ...b, compEdge, weakVsComp: compEdge !== undefined && compEdge <= COMP_DEMOTE };
  };

  const cats: SlotType[] = ['weapon', 'vitality', 'spirit', 'unknown'];

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
        if (coreUniv.length >= coreSlots) {
          benched.push(u);
          continue;
        }
        const rival = substituteRival(u, coreUniv);
        if (rival) benched.push({ ...u, swapForId: rival.item.id });
        else coreUniv.push(u);
      }
      const fill = Math.max(0, coreSlots - coreUniv.length);
      const coreCat = [...coreUniv, ...others.slice(0, fill)];
      leftover = leftover.concat(benched, others.slice(fill));

      for (const b of coreCat) {
        const role: BuildRole =
          b.pickRate >= UNIVERSAL_PICK ? 'universal' : score(b) >= VALUE_EDGE ? 'value' : 'filler';
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
      .map<BuildItem>((b) => ({ ...b, role: 'situational' }));
    const newSitu = [...kept, ...demoted].sort((a, b) => score(b) - score(a));

    // Within the core group, order by comp relevance (buy-order is moot once we're tuning
    // the build to a specific comp).
    newCore.sort((a, b) => score(b) - score(a));
    // coreSouls/categorySouls are finalized by recomputeCosts below, once every phase's new core
    // membership is settled (component discounts span phases, so they can't be summed per-phase here).
    return { ...phase, core: newCore, situational: newSitu };
  });

  dropSamePhaseComponents(phases); // re-rank can pull a swap into core beside its upgrade — keep one
  recomputeCosts(phases, items); // marginal costs + coreSouls/categorySouls for the re-ranked core
  annotateSlotRelations(phases); // swap/rush pairings for the re-ranked membership
  const standingSlots = phases.flatMap((p) => p.core).filter((b) => !b.transient).length;
  return { ...build, phases, standingSlots };
}

export const SLOT_COLORS: Record<string, string> = {
  weapon: '#d97b34',
  vitality: '#5fa84a',
  spirit: '#9b6dd1',
  unknown: '#6b7280',
};
