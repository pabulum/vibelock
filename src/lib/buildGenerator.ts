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
const CO_OCCUR_MIN = 1; // two comparable-cost every-game picks in a slot are assumed to co-occur
// only when their pick rates sum past this (inclusion–exclusion: pA+pB−1 players must buy both);
// below it they can be bought by disjoint players — substitutes — so only one holds a core slot.
const SOUL_SLACK = 1.15; // allow 15% over the soul budget before stopping
const SITUATIONAL_MAX = 5;
const COMEBACK_GAP = 0.035; // adj−raw this big ⇒ a reactive "hold up when behind" pick
const COMEBACK_RESERVE = 2; // situational slots held for the best comeback picks (vs damage)
const SELL_BEFORE_S = 1500; // a cheap item sold before ~25 min is a placeholder
export const SLOT_CAP = 12; // 9 base + 3 flex slots (unlocked via Walker kills)

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
  const phases = PHASE_META.map((_, col) =>
    buildPhase(col, flow, items, baselineWinRate, buyTimes, opts, primaryCol),
  );

  dedupeAcrossPhases(phases);
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
  };
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
 * Flags core items that don't hold a permanent slot — either they build into another
 * recommended item (a shared slot) or they're a cheap item players typically sell —
 * and returns the count of items that *do* hold a slot. Mutates the phases' core items.
 */
function markTransient(phases: BuildPhase[], sellTimes: Map<number, number>): number {
  const core = phases.flatMap((p) => p.core);
  const coreIds = new Set(core.map((b) => b.item.id));

  // Map a recommended component → the recommended item it builds into.
  const buildsInto = new Map<number, Item>();
  for (const b of core) {
    for (const compId of b.item.componentIds) {
      if (coreIds.has(compId)) buildsInto.set(compId, b.item);
    }
  }

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
): BuildPhase {
  // reached_per_column is the correct denominator for an unlocked query: players
  // who were still buying in this phase.
  const reached = flow.reached_per_column[col] || flow.baseline.matches || 1;
  const minSupport = Math.max(MIN_SUPPORT_ABS, MIN_SUPPORT_FRAC * reached);

  const candidates = flow.nodes
    .filter((n) => n.column === col)
    .map((n) => toCandidate(n, reached, items))
    .filter((c): c is BuildItem => c !== null && c.sample >= minSupport);

  // Budget for the phase, from what players actually do. This raw figure sums pick-mass × cost over
  // *every* candidate, so mutually-exclusive lines (Monster Rounds vs the High-Velocity Rounds →
  // Opening Rounds line) both count even though a player buys one — it's a generous cap for the fill,
  // but inflated as a *target*. We deflate the displayed budget below, once we know what got benched.
  const buys = candidates.reduce((a, c) => a + c.sample, 0);
  const targetItems = Math.max(1, Math.round(buys / reached));
  const soulBudget = candidates.reduce((a, c) => a + c.sample * c.item.cost, 0) / reached;

  // Split the phase's item count across weapon/vitality/spirit in the same proportion
  // real players of this hero invest souls. Without this the build is category-blind:
  // defensive items are bought reactively, so they miss the pick-rate and win-rate
  // gates and the budget gets spent entirely on weapon/spirit — e.g. zero greens in lane.
  const catCounts = allocateCategoryCounts(categorySoulShare(candidates), targetItems);

  const chosen = new Set<number>();
  const core: BuildItem[] = [];
  const swaps: BuildItem[] = []; // every-game picks held out of core as substitutes (see substituteRival)
  const benchedIds = new Set<number>(); // their upgrade lines are off-limits for filling core (see buildsFromAny)
  let coreSouls = 0;

  // Try to seat one candidate in core. Returns true only when it actually took a slot (so the caller
  // decrements its quota); a soul/line/phase miss or a benched substitute returns false.
  const tryAddCore = (c: BuildItem): boolean => {
    if (chosen.has(c.item.id) || benchedIds.has(c.item.id)) return false;
    if (coreSouls + c.item.cost > soulBudget * SOUL_SLACK) return false; // a cheaper pick may still fit
    // Don't fill a slot with the upgrade of an item we've already benched as a swap — that's the same
    // line (Opening Rounds builds from High-Velocity Rounds), so it'd put the upgrade in core and the
    // component as its swap. Skip it; the slot stays open for a genuinely different item.
    if (buildsFromAny(c.item, benchedIds, items)) return false;
    // Skip items whose primary phase is *later* — dedupeAcrossPhases keeps them there, so placing one
    // in this earlier slot just leaves it empty (they still surface as a situational, "core by Mid").
    // Items primary in an earlier phase are allowed through: if they didn't win a slot there they'd
    // otherwise vanish, and a later phase is a fine home for them.
    if ((primaryCol.get(c.item.id) ?? col) > col) return false;
    // Substitution guard: if this every-game pick is an alternative to one already in core (a
    // same-slot, comparable-cost pick it doesn't co-occur with), it isn't a second item — it's a swap
    // for the rival that beat it. Bench it (the rival holds the build's representation of that line),
    // but keep the slot — it's a real, budgeted slot owed to a different co-occurring item, not this
    // swap's line. So the phase keeps its count without reading "buy all three cheap weapon items".
    const rival = substituteRival(c, core);
    if (rival) {
      swaps.push({ ...c, role: 'situational', swapForId: rival.item.id });
      benchedIds.add(c.item.id);
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
    coreSouls += c.item.cost;
    chosen.add(c.item.id);
    return true;
  };

  for (const slot of FILL_ORDER) {
    let want = catCounts[slot];
    if (want <= 0) continue;
    for (const c of categoryPriority(candidates, slot, baselineWinRate, chosen)) {
      if (want <= 0) break;
      if (tryAddCore(c)) want--;
    }
  }

  // Backfill to the item target: the per-category quotas can come up short when a category runs out
  // of primary-phase candidates (e.g. no green clears the bar in a late phase, or a substitute
  // emptied a slot). Top up from the most-bought remaining primary-phase picks of any category, so
  // the phase reaches the count players actually buy instead of leaving a hole.
  if (core.length < targetItems) {
    for (const c of [...candidates].sort((a, b) => b.pickRate - a.pickRate)) {
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
  // shows a gap that can only be closed by buying redundant items. (Component lines whose members are
  // *both* kept — Headshot Booster → Headhunter — still slightly double-count; a smaller residual.)
  // Floor it at what this build actually costs: a phase that front-loads a pricier-than-average item
  // (e.g. an early Headhunter) shouldn't read as "over budget" — it tops out at its own spend.
  const deflatedBudget = candidates
    .filter((c) => !benchedIds.has(c.item.id) && !buildsFromAny(c.item, benchedIds, items))
    .reduce((a, c) => a + c.sample * c.item.cost, 0) / reached;
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

/** Fraction of phase souls real players put into each category (weapon/vitality/spirit). */
function categorySoulShare(candidates: BuildItem[]): Record<SlotType, number> {
  const souls: Record<SlotType, number> = { weapon: 0, vitality: 0, spirit: 0, unknown: 0 };
  let total = 0;
  for (const c of candidates) {
    const s = c.sample * c.item.cost;
    souls[c.item.slot] += s;
    total += s;
  }
  if (total > 0) for (const k of Object.keys(souls) as SlotType[]) souls[k] /= total;
  return souls;
}

/**
 * Turn category soul shares into whole item counts that sum to `total`, using the
 * largest-remainder method (so e.g. a 14% vitality share of a 5-item phase still
 * rounds up to one guaranteed green rather than vanishing to zero).
 */
function allocateCategoryCounts(
  share: Record<SlotType, number>,
  total: number,
): Record<'weapon' | 'vitality' | 'spirit', number> {
  const rows = FILL_ORDER.map((slot) => {
    const exact = share[slot] * total;
    return { slot, n: Math.floor(exact), rem: exact - Math.floor(exact) };
  });
  let left = total - rows.reduce((a, r) => a + r.n, 0);
  for (const r of [...rows].sort((a, b) => b.rem - a.rem)) {
    if (left <= 0) break;
    r.n++;
    left--;
  }
  return Object.fromEntries(rows.map((r) => [r.slot, r.n])) as Record<
    'weapon' | 'vitality' | 'spirit',
    number
  >;
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

/** Souls the chosen core spends per shown category. */
function categorySouls(core: BuildItem[]): Record<'weapon' | 'vitality' | 'spirit', number> {
  const out = { weapon: 0, vitality: 0, spirit: 0 };
  for (const b of core) if (b.item.slot in out) out[b.item.slot as 'weapon' | 'vitality' | 'spirit'] += b.item.cost;
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

    // Situational: leftovers worth showing for this comp (clear the value gate, or are
    // staples that didn't fit a core slot), strongest first, capped.
    const newSitu = leftover
      .filter((b) => b.pickRate >= UNIVERSAL_PICK || score(b) >= VALUE_EDGE)
      .sort((a, b) => score(b) - score(a))
      .slice(0, SITUATIONAL_MAX)
      .map<BuildItem>((b) => ({ ...b, role: 'situational' }));

    // Within the core group, order by comp relevance (buy-order is moot once we're tuning
    // the build to a specific comp).
    newCore.sort((a, b) => score(b) - score(a));
    return {
      ...phase,
      core: newCore,
      situational: newSitu,
      coreSouls: newCore.reduce((s, b) => s + b.item.cost, 0),
      categorySouls: categorySouls(newCore),
    };
  });

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
