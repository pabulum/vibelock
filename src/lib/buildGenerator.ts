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
const SOUL_SLACK = 1.15; // allow 15% over the soul budget before stopping
const SITUATIONAL_MAX = 5;
const COMEBACK_GAP = 0.035; // adj−raw this big ⇒ a reactive "hold up when behind" pick
const COMEBACK_RESERVE = 2; // situational slots held for the best comeback picks (vs damage)
const SELL_BEFORE_S = 1500; // a cheap item sold before ~25 min is a placeholder
export const SLOT_CAP = 12; // 9 base + 3 flex slots (unlocked via Walker kills)

// Categories we budget across, in fill order. Weapon is filled last on purpose: it's
// the plurality buy most phases, so giving the reactively-bought categories (greens,
// then spirit) first claim on the budget stops weapon from starving them of a slot.
const FILL_ORDER: Array<'weapon' | 'vitality' | 'spirit'> = ['vitality', 'spirit', 'weapon'];

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
): GeneratedBuild {
  const baseWins = flow.baseline.wins + flow.baseline.losses;
  const baselineWinRate = baseWins > 0 ? flow.baseline.wins / baseWins : 0.5;

  const phases = PHASE_META.map((_, col) =>
    buildPhase(col, flow, items, baselineWinRate, buyTimes),
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
): BuildPhase {
  // reached_per_column is the correct denominator for an unlocked query: players
  // who were still buying in this phase.
  const reached = flow.reached_per_column[col] || flow.baseline.matches || 1;
  const minSupport = Math.max(MIN_SUPPORT_ABS, MIN_SUPPORT_FRAC * reached);

  const candidates = flow.nodes
    .filter((n) => n.column === col)
    .map((n) => toCandidate(n, reached, items))
    .filter((c): c is BuildItem => c !== null && c.sample >= minSupport);

  // Budget for the phase, from what players actually do.
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
  let coreSouls = 0;

  for (const slot of FILL_ORDER) {
    let want = catCounts[slot];
    if (want <= 0) continue;
    for (const c of categoryPriority(candidates, slot, baselineWinRate, chosen)) {
      if (want <= 0) break;
      if (coreSouls + c.item.cost > soulBudget * SOUL_SLACK) continue; // a cheaper pick may still fit
      // Mirror the bucket logic in categoryPriority: a quota-filling pick that beats
      // neither the pick-rate bar nor the value gate is `filler`, not a `value` pick.
      const role: BuildRole =
        c.pickRate >= UNIVERSAL_PICK
          ? 'universal'
          : c.adjustedWinRate >= baselineWinRate + VALUE_EDGE
            ? 'value'
            : 'filler';
      core.push({ ...c, role });
      coreSouls += c.item.cost;
      chosen.add(c.item.id);
      want--;
    }
  }

  // Situational: the best leftover value picks across every category — but reserve a couple
  // of slots for the strongest "comeback" picks (adj ≫ raw: reactive items that hold up when
  // behind). Sorting purely by win rate lets raw damage items crowd those out, so a real
  // late-game stabilizer (e.g. Fortitude) never surfaces. Reserve first, then fill by WR.
  const eligible = candidates
    .filter((c) => !chosen.has(c.item.id) && c.adjustedWinRate >= baselineWinRate + VALUE_EDGE)
    .sort((a, b) => b.adjustedWinRate - a.adjustedWinRate);
  const reserved = eligible
    .filter((c) => c.adjustedWinRate - c.rawWinRate >= COMEBACK_GAP)
    .slice(0, COMEBACK_RESERVE);
  const reservedIds = new Set(reserved.map((c) => c.item.id));
  const situational = [...reserved, ...eligible.filter((c) => !reservedIds.has(c.item.id))]
    .slice(0, SITUATIONAL_MAX)
    .sort((a, b) => b.adjustedWinRate - a.adjustedWinRate)
    .map<BuildItem>((c) => ({ ...c, role: 'situational' }));

  const buyTime = (b: BuildItem) => buyTimes.get(b.item.id) ?? Number.POSITIVE_INFINITY;
  // The "why" is what the item does — the WR/pick numbers are already on the row.
  const withWhy = (b: BuildItem) => ({ ...b, why: b.item.effect ?? '' });

  return {
    column: col,
    label: PHASE_META[col].label,
    timeLabel: PHASE_META[col].timeLabel,
    targetItems,
    soulBudget,
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

      // Staples hold their slots; the comp picks which non-staples fill what's left.
      const coreUniv = universals.slice(0, coreSlots);
      const fill = Math.max(0, coreSlots - coreUniv.length);
      const coreCat = [...coreUniv, ...others.slice(0, fill)];
      leftover = leftover.concat(universals.slice(coreSlots), others.slice(fill));

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
