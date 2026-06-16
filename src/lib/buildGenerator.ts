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
      const role: BuildRole = c.pickRate >= UNIVERSAL_PICK ? 'universal' : 'value';
      core.push({ ...c, role });
      coreSouls += c.item.cost;
      chosen.add(c.item.id);
      want--;
    }
  }

  // Situational: the best leftover value picks across every category.
  const situational = candidates
    .filter((c) => !chosen.has(c.item.id) && c.adjustedWinRate >= baselineWinRate + VALUE_EDGE)
    .sort((a, b) => b.adjustedWinRate - a.adjustedWinRate)
    .slice(0, SITUATIONAL_MAX)
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
 * One category's candidates, best-first: every-game staples (by pick rate), then value
 * picks (by win rate), then — so a guaranteed category is never empty — the rest by
 * pick rate. Items already taken (or in another category) are skipped.
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
  const value = pool
    .filter((c) => c.pickRate < UNIVERSAL_PICK && c.adjustedWinRate >= baselineWinRate + VALUE_EDGE)
    .sort((a, b) => b.adjustedWinRate - a.adjustedWinRate);
  const rest = pool.filter((c) => !universal.includes(c) && !value.includes(c)).sort(byPick);

  const ordered: BuildItem[] = [];
  const seen = new Set<number>(chosen);
  for (const c of [...universal, ...value, ...rest]) {
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

export const SLOT_COLORS: Record<string, string> = {
  weapon: '#d97b34',
  vitality: '#5fa84a',
  spirit: '#9b6dd1',
  unknown: '#6b7280',
};
