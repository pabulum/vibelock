// The counters feature: item counters vs the chosen enemy comp, the hero-vs-hero matchup matrix,
// and the per-item / per-phase lookups the build render tags rows from.
import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getHeroCounters, getItemStats } from "../api/deadlock";
import type { TimeWindow } from "../api/deadlock";
import { computeItemCounters } from "../lib/counters";
import { counterSliceQueries } from "../lib/prefetch";
import { heroMatchups, matchupTable } from "../lib/matchups";
import { ladderRates } from "../lib/draft";
import { blendItemStats } from "../lib/patchBlend";
import type { Hero, Item, ItemCounters, ItemStat } from "../types";

export function useCounters(opts: {
  hero: Hero | null;
  heroId: number | null;
  items: Map<number, Item> | null;
  enemies: number[];
  minBadge: number;
  maxBadge?: number;
  dataWindow: TimeWindow;
  priorWin: TimeWindow;
  canBackfill: boolean;
  priorKey: TimeWindow | null;
  patchesReady: boolean;
}) {
  const {
    hero,
    heroId,
    items,
    enemies,
    minBadge,
    maxBadge,
    dataWindow,
    priorWin,
    canBackfill,
    priorKey,
    patchesReady,
  } = opts;

  // Compute counters vs the chosen enemies.
  const countersQ = useQuery({
    queryKey: [
      "counters",
      heroId,
      enemies,
      { minBadge, maxBadge },
      dataWindow,
      priorKey,
    ],
    enabled: !!hero && !!items && enemies.length > 0,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      // One query per enemy (not a combined `any-of` query) so each item keeps a per-enemy
      // delta — that's what lets a row carry the portrait of the specific hero it answers.
      // With backfill on, each slice is fetched for both windows (all in parallel) and blended.
      // Counters need one rule beyond the build blend: a counter is a *difference* (item-vs-enemy
      // minus base), and if the two sides borrowed differently — a patch-changed item's big base
      // sample pulls fresh while its thin enemy slice stays anchored to pre-patch — the mismatch
      // reads as a fake counter. So the per-item discounts are learned on the base pair and shared
      // into every per-enemy blend (see blendItemStats).
      // The queries themselves are built in lib/prefetch, which is also what the hover prefetch
      // fires — one definition, so the two can't drift into near-miss URLs that do the work twice.
      const slice = (enemyHeroIds?: number[]) => {
        const [fresh, prior] = counterSliceQueries(
          hero!.id,
          { minBadge, maxBadge, dataWindow, priorWin, canBackfill },
          enemyHeroIds,
        );
        return Promise.all([
          getItemStats(fresh),
          prior ? getItemStats(prior) : Promise.resolve([] as ItemStat[]),
        ]);
      };
      const [basePair, ...enemyPairs] = await Promise.all([
        slice(),
        ...enemies.map((id) => slice([id])),
      ]);

      let baseStats = basePair[0];
      let perEnemy = enemyPairs.map((pair, i) => ({
        enemyHeroId: enemies[i],
        stats: pair[0],
      }));
      if (canBackfill) {
        const baseBlend = blendItemStats(basePair[0], basePair[1]);
        baseStats = baseBlend.stats;
        perEnemy = enemyPairs.map((pair, i) => ({
          enemyHeroId: enemies[i],
          stats: blendItemStats(pair[0], pair[1], baseBlend).stats,
        }));
      }
      return computeItemCounters(baseStats, perEnemy, items!);
    },
  });
  const counters =
    enemies.length > 0 ? (countersQ.data?.counters ?? null) : null;
  const compEdges =
    enemies.length > 0 ? (countersQ.data?.edgeByItem ?? null) : null;

  // The counter matrix is hero-independent, so fetch once per rank/patch and filter by hero.
  const matrixQ = useQuery({
    queryKey: ["counterMatrix", { minBadge, maxBadge }, dataWindow],
    enabled: !!items && patchesReady,
    placeholderData: keepPreviousData,
    queryFn: () => getHeroCounters({ minBadge, maxBadge, ...dataWindow }),
  });
  const counterMatrix = matrixQ.data ?? null;

  // One Bradley-Terry fit per matrix, shared by the matchup chips and the draft panel — the two
  // must not disagree about what a cell was expected to be. The fit is a few hundred MM sweeps over
  // ~1,400 cells, so this is cheap; what matters is that it happens once.
  const table = useMemo(
    () => (counterMatrix ? matchupTable(counterMatrix) : null),
    [counterMatrix],
  );
  // Each hero's overall win rate at the selected rank and patch, summed straight out of the matrix.
  // Free, and — unlike heroMeta — available without a linked profile, which is what lets the draft
  // panel work for a visitor who has not entered a Steam id.
  const ladder = useMemo(
    () => (counterMatrix ? ladderRates(counterMatrix) : null),
    [counterMatrix],
  );

  const matchups = useMemo(
    () =>
      counterMatrix && table && hero
        ? heroMatchups(counterMatrix, hero.id, table)
        : null,
    [counterMatrix, table, hero],
  );

  // Counters folded into the build: a per-item lookup to tag build rows that answer this
  // comp (with the specific enemy portraits), plus a per-phase bucket (keyed by the same
  // labels buildGenerator uses) for strong counter picks not already in the build.
  const counterByItem = useMemo(() => {
    const m = new Map<number, ItemCounters>();
    for (const c of counters ?? []) m.set(c.item.id, c);
    return m;
  }, [counters]);
  const countersByPhase = useMemo(() => {
    const m = new Map<string, ItemCounters[]>();
    for (const c of counters ?? []) {
      const arr = m.get(c.phaseLabel);
      if (arr) arr.push(c);
      else m.set(c.phaseLabel, [c]);
    }
    return m;
  }, [counters]);

  return {
    countersQ,
    counters,
    compEdges,
    matrixQ,
    matchups,
    matchupTable: table,
    ladder,
    counterByItem,
    countersByPhase,
  };
}
