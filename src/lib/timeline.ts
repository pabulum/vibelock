// Game-clock timeline model for the scrubber prototype (components/TimeScrubber.tsx). Pure
// derivations over an already-generated build plus the baked wp-stats surface — no new data and
// no new queries, so the whole feature deletes cleanly with its component: this file,
// TimeScrubber.tsx, the `scrub*` lines in App.tsx, and the scrubber block in App.css.

import type { BuildItem, GeneratedBuild } from "../types";
import type { WpStats } from "../api/wpStats";

/** Start of each flow column's fixed time window (Lane 0–9, Early mid 9–20, Mid 20–30, Late 30+),
 * in seconds. Mirrors the windows the generator's phases are defined over. */
export const PHASE_START_S = [0, 540, 1200, 1800];

/** End of the scrubber's axis: the Late window runs to the population's average game length,
 * floored at 40 minutes so a short-average pool can't collapse the late stretch of the axis. */
export function timelineEndS(build: GeneratedBuild): number {
  return Math.max(2400, Math.round(build.population.avgDurationS));
}

function phaseEndS(build: GeneratedBuild, col: number): number {
  return col + 1 < PHASE_START_S.length
    ? PHASE_START_S[col + 1]
    : timelineEndS(build);
}

/** When the plan expects you to *own* a core pick: its population average buy time when the flow
 * has one (stamped on the item at generation), else the midpoint of its phase's window — a coarse
 * but honest stand-in that never claims sub-minute precision it doesn't have. */
export function expectedOwnS(
  build: GeneratedBuild,
  b: BuildItem,
  col: number,
): number {
  return b.buyTimeS ?? (PHASE_START_S[col] + phaseEndS(build, col)) / 2;
}

/** Everything the scrubber shows for one instant of the game clock. */
export interface TimelineSnapshot {
  /** Core item ids the plan expects you to own by t. */
  ownedIds: Set<number>;
  ownedCount: number;
  coreCount: number;
  /** The next core buy after t — the pick you should be saving toward — if any. */
  nextId: number | null;
  nextName: string | null;
  /** Expected cumulative souls spent by t: each phase's population soul budget, linearly ramped
   * across its window (the budgets are per-window totals; the ramp is the only interpolation). */
  spentSouls: number;
}

export function timelineAt(
  build: GeneratedBuild,
  tS: number,
): TimelineSnapshot {
  const ownedIds = new Set<number>();
  let coreCount = 0;
  let next: { id: number; name: string; at: number } | null = null;
  for (const p of build.phases) {
    for (const b of p.core) {
      coreCount++;
      const at = expectedOwnS(build, b, p.column);
      if (at <= tS) ownedIds.add(b.item.id);
      else if (!next || at < next.at)
        next = { id: b.item.id, name: b.item.name, at };
    }
  }

  let spent = 0;
  for (const p of build.phases) {
    const start = PHASE_START_S[p.column];
    const end = phaseEndS(build, p.column);
    const frac = Math.min(1, Math.max(0, (tS - start) / (end - start)));
    spent += p.soulBudget * frac;
  }

  return {
    ownedIds,
    ownedCount: ownedIds.size,
    coreCount,
    nextId: next?.id ?? null,
    nextName: next?.name ?? null,
    spentSouls: Math.round(spent),
  };
}

/** What a typical (one-sigma) team soul lead converts to at t, from the Lab's win-probability
 * surface — the same read as the phase header's "lead ≈ X% win" note, taken at the scrubbed
 * instant instead of the phase midpoint. Null when no bin covers t (shouldn't happen — bins
 * cover 0–∞). */
export function leadAtS(
  wp: WpStats,
  tS: number,
): { sigmaSouls: number; pctAtSigma: number } | null {
  const bin = wp.wpModel.find(
    (b) => tS >= b.fromS && (b.toS === null || tS < b.toS),
  );
  if (!bin) return null;
  return {
    sigmaSouls: bin.sigma,
    pctAtSigma: Math.round(100 / (1 + Math.exp(-(bin.w0 + bin.w1)))),
  };
}

/** mm:ss for the scrubbed clock. */
export function fmtClock(tS: number): string {
  const m = Math.floor(tS / 60);
  const s = Math.round(tS % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** The phase column whose time window contains t. */
export function phaseAtS(tS: number): number {
  for (let i = PHASE_START_S.length - 1; i >= 0; i--)
    if (tS >= PHASE_START_S[i]) return i;
  return 0;
}
