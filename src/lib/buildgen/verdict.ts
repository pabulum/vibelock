// "Why isn't X in the build?" — re-runs the generator's own admission gates for one item against
// the flow + generated build and reports the first gate that actually fired, in the order the
// fill applies them. Pure data out (the verdict card renders it); every number comes from the
// same scoring functions the generator ranked with, so the answer is the real reason, not a
// plausible story.

import type {
  BuildItem,
  GeneratedBuild,
  Item,
  ItemFlowStats,
  ItemRef,
} from "../../types";
import { toCandidate, unreliableAdjustedNodes } from "./candidates";
import { PAIR_MIN_N, PHASE_META, substituteRival } from "./phaseFill";
import {
  FILL_WR_FLOOR,
  MIN_SUPPORT_ABS,
  MIN_SUPPORT_FRAC,
  UNIVERSAL_PICK,
  buyerContrast,
  buyersLoseSignificantly,
  coreWrScore,
  costPowerForSlots,
  lowerConfidenceWinRate,
  meritWr,
  priorStrength,
} from "./scoring";

/** The item's numbers at its primary phase — the evidence every verdict shows. */
export interface VerdictStats {
  phaseLabel: string;
  pickRate: number;
  adjustedWinRate: number;
  decided: number;
  baseline: number;
  /** The shrunk lower-confidence edge over baseline the ranking actually used (win-rate points,
   * signed) — what the item's win rate is *worth* after sample-size skepticism. */
  lcbEdge: number;
}

export type ItemVerdict =
  /** It IS here — the palette's why-not path shouldn't normally reach this, but any caller
   * scoring an arbitrary item gets an honest answer. */
  | {
      kind: "in-build";
      where: "core" | "situational" | "overtime";
      phaseLabel: string;
    }
  /** Players at this rank/patch don't buy it on this hero at all — nothing to score. */
  | { kind: "no-data" }
  /** Sample floor: bought by too few players in every phase to clear MIN_SUPPORT. */
  | { kind: "sample-floor"; stats: VerdictStats; players: number; floor: number }
  /** Either/or: it's an every-game pick, but so is a same-slot rival it demonstrably isn't
   * bought *with* — they share one core slot, and the rival holds it. */
  | {
      kind: "either-or";
      stats: VerdictStats;
      winner: ItemRef;
      winnerWr: number;
      /** Measured co-buy rate (joint games over the smaller side), when pair data existed. */
      overlap?: number;
    }
  /** Popular, but its buyers verifiably run behind its non-buyers — the seat was revoked. */
  | { kind: "popular-but-losing"; stats: VerdictStats; contrast: number }
  /** Marginal win rate: below the hero's baseline, so it never passes "worth building". */
  | { kind: "below-baseline"; stats: VerdictStats }
  /** Cleared every gate but ranked under the picks that took the phase's slots. */
  | {
      kind: "lost-slot";
      stats: VerdictStats;
      /** The weakest same-category core pick that still outranked it (its closest contest). */
      beatenBy?: ItemRef;
      beatenByWr?: number;
    };

/** All build rows an item can occupy, in the order membership should be reported. */
function findInBuild(
  itemId: number,
  build: GeneratedBuild,
): Extract<ItemVerdict, { kind: "in-build" }> | null {
  for (const p of build.phases) {
    if (p.core.some((b) => b.item.id === itemId))
      return { kind: "in-build", where: "core", phaseLabel: p.label };
  }
  for (const p of build.phases) {
    if (p.situational.some((b) => b.item.id === itemId))
      return { kind: "in-build", where: "situational", phaseLabel: p.label };
  }
  if (build.overtimeBuys.some((b) => b.item.id === itemId))
    return { kind: "in-build", where: "overtime", phaseLabel: "Overtime" };
  return null;
}

/**
 * The generator's actual reason an item is (or isn't) in `build`, judged at the item's primary
 * phase from the same flow the build was generated from. Gates run in the fill's own order:
 * support floor → substitute conflict → buyer-contrast revocation → win-rate floor → slot
 * contest, so the verdict is the first wall the item really hits.
 */
export function itemVerdict(
  itemId: number,
  flow: ItemFlowStats,
  build: GeneratedBuild,
  items: Map<number, Item>,
): ItemVerdict {
  const inBuild = findInBuild(itemId, build);
  if (inBuild) return inBuild;

  const nodes = flow.nodes.filter((n) => n.item_id === itemId);
  if (nodes.length === 0 || !items.has(itemId)) return { kind: "no-data" };

  const baseline = build.population.baselineWinRate;
  const reachedOf = (col: number) =>
    flow.reached_per_column[col] || flow.baseline.matches || 1;
  const floorOf = (col: number) =>
    Math.max(MIN_SUPPORT_ABS, MIN_SUPPORT_FRAC * reachedOf(col));

  // The item's primary phase = highest pick rate, the same rule the fill files items by — but
  // judged among *supported* columns when any exist, since those are the only ones the fill saw.
  const supported = nodes.filter((n) => n.players >= floorOf(n.column));
  const pool = supported.length ? supported : nodes;
  const best = pool.reduce((a, b) =>
    b.players / reachedOf(b.column) > a.players / reachedOf(a.column) ? b : a,
  );
  const reached = reachedOf(best.column);
  const c = toCandidate(best, reached, items, unreliableAdjustedNodes(flow));
  if (!c) return { kind: "no-data" };

  // Same hero-wide prior strength generateBuild learns, so the shrunk edge matches the ranking.
  const priorK = priorStrength(
    flow.nodes.map((n) => ({
      winRate: n.adjusted_win_rate,
      decided: n.wins + n.losses,
    })),
    baseline,
  );
  const stats: VerdictStats = {
    phaseLabel: PHASE_META[best.column]?.label ?? "Late",
    pickRate: c.pickRate,
    adjustedWinRate: c.adjustedWinRate,
    decided: c.decided,
    baseline,
    lcbEdge:
      lowerConfidenceWinRate(c.adjustedWinRate, c.decided, baseline, priorK) -
      baseline,
  };

  if (supported.length === 0)
    return {
      kind: "sample-floor",
      stats,
      players: best.players,
      floor: Math.round(floorOf(best.column)),
    };

  const phase = build.phases.find((p) => p.column === best.column);

  // Either/or: a same-slot, comparable-cost every-game pick already in core that this one
  // demonstrably isn't bought alongside — the two share a single slot and the seated one won.
  const rival = phase && substituteRival(c, phase.core, build.pairGames);
  if (rival) {
    const pg = build.pairGames?.(rival.item.id, c.item.id);
    const overlap =
      pg && Math.min(pg.totalA, pg.totalB) >= PAIR_MIN_N
        ? pg.joint / Math.min(pg.totalA, pg.totalB)
        : undefined;
    return {
      kind: "either-or",
      stats,
      winner: { id: rival.item.id, name: rival.item.name },
      winnerWr: rival.adjustedWinRate,
      overlap,
    };
  }

  if (c.pickRate >= UNIVERSAL_PICK && buyersLoseSignificantly(c, baseline))
    return {
      kind: "popular-but-losing",
      stats,
      contrast: buyerContrast(c, baseline),
    };

  if (c.pickRate < UNIVERSAL_PICK && meritWr(c) < baseline - FILL_WR_FLOOR)
    return { kind: "below-baseline", stats };

  // Seatable, no conflict — it simply ranked under the picks that took the slots. Name its
  // closest contest: the weakest same-category core pick that still beat it. Scores use the
  // same coreWrScore the fill sorts by (synergy/down-payment bonuses omitted — they're
  // tiebreak-scale and not carried on the finished build).
  let committedSlots = 0;
  for (const p of build.phases) {
    if (p.column >= best.column) break;
    committedSlots += p.core.filter((b) => !b.transient).length;
  }
  const costPower = costPowerForSlots(committedSlots);
  const score = (b: BuildItem) => coreWrScore(b, baseline, costPower, priorK);
  const contest = phase
    ? (phase.core.filter((b) => b.item.slot === c.item.slot).length
        ? phase.core.filter((b) => b.item.slot === c.item.slot)
        : phase.core
      ).filter((b) => score(b) >= score(c))
    : [];
  const beatenBy = contest.length
    ? contest.reduce((w, b) => (score(b) < score(w) ? b : w))
    : undefined;
  return {
    kind: "lost-slot",
    stats,
    beatenBy: beatenBy && { id: beatenBy.item.id, name: beatenBy.item.name },
    beatenByWr: beatenBy?.adjustedWinRate,
  };
}
