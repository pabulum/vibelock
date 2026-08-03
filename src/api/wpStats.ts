// The Lab's data file: wp-stats.json, baked nightly by the harvest workflow (scripts/
// bake-wp-stats.mjs) over the rolling ~30-day match window on the repo's `data` branch.
// Unlike everything in deadlock.ts this is not a live analytics query — it's a static
// artifact refit once per day, so one fetch per session is plenty (staleTime Infinity in
// the query cache; a failure isn't cached, so a reopen retries).

import * as v from "valibot";
import { queryOptions } from "@tanstack/react-query";
import { queryClient } from "../queryClient";
import { parseAs } from "./schemas";

const WpModelBinSchema = v.object({
  fromS: v.number(),
  toS: v.nullable(v.number()),
  /** Std-dev of the team soul lead within this time bin (souls). */
  sigma: v.number(),
  w0: v.number(),
  w1: v.number(),
});
export type WpModelBin = v.InferOutput<typeof WpModelBinSchema>;

const LabItemSchema = v.object({
  id: v.number(),
  name: v.string(),
  tier: v.number(),
  n: v.number(),
  /** Mean win probability at the moment this item is bought — the situations it's bought in. */
  wpBuy: v.number(),
  /** Raw win rate of matches where it was bought. */
  wr: v.number(),
  /** wr − wpBuy: performance vs what the game state at purchase already predicted. */
  excess: v.number(),
});
export type LabItem = v.InferOutput<typeof LabItemSchema>;

const LabHeroSchema = v.object({
  id: v.number(),
  name: v.string(),
  n: v.number(),
  /** Mean excess over every purchase the hero makes ≈ wins above what their soul lead implies.
   * NOTE: tracks plain hero WR closely (r≈0.93) — mostly "good heroes win". */
  closing: v.number(),
  /** The hero's plain win rate over the window, for context next to `closing`. */
  wr: v.optional(v.number()),
  /** Closing power beyond what the hero's WR predicts — the stable style axis (split-half
   * r≈0.97): positive converts even games, negative wins via soul leads (snowballer). */
  resid: v.optional(v.number()),
  se: v.number(),
});
export type LabHero = v.InferOutput<typeof LabHeroSchema>;

const WpStatsSchema = v.object({
  generatedAt: v.string(),
  window: v.object({
    fromDay: v.string(),
    toDay: v.string(),
    matches: v.number(),
    purchases: v.number(),
  }),
  meanExcess: v.number(),
  wpModel: v.array(WpModelBinSchema),
  /** WPA-readiness gauge: hero-item cells past the stabilization point k — when `cellsPastK`
   * stops being a rounding error, hero-specific item values become worth revisiting. */
  readiness: v.optional(
    v.object({
      k: v.number(),
      cellsTracked: v.number(),
      cellsPastK: v.number(),
      medianCellN: v.number(),
    }),
  ),
  items: v.array(LabItemSchema),
  heroes: v.array(LabHeroSchema),
  /** Percentile grid the `farmNorms` arrays correspond to, e.g. [10,25,50,75,90]. */
  farmPcts: v.optional(v.array(v.number())),
  /** Soul-economy norms for match analysis: per `"heroId:tier"`, each source id maps to that
   * source's gold-per-minute at `farmPcts`. Populated from the harvester's economy subsample;
   * a missing cell or source just means no population benchmark there yet (day-one, rare hero/rank).
   * Source ids: 1 kills, 2 lane, 3 camps, 4 boss, 5 urn, 6 assists, 7 denies, 12 breakables. */
  farmNorms: v.optional(
    v.record(
      v.string(),
      v.object({
        n: v.number(),
        src: v.record(v.string(), v.array(v.number())),
      }),
    ),
  ),
  /**
   * Soul pace: how net worth accumulates for a (hero, rank), and the per-phase income rates a
   * single game is placed against. Axes are shared by every cell and each cell's arrays are
   * index-aligned with them; a null entry is an index that fell under the sample floor.
   *
   * `won`/`lost` are MEAN levels by outcome, not percentiles — the pace gap drawn over the band.
   *
   * Survivorship, carried from the bake: a tick is only recorded for games that REACHED it, so the
   * late ticks describe long games, which are a closer-fought subset. The UI says so rather than
   * pretending the curve is "all games".
   *
   * Optional, and it has to be: the client ships before the first bake that emits it, so every
   * reader must hide on absence rather than assume it.
   */
  pace: v.optional(
    v.object({
      ticksS: v.array(v.number()),
      windowsS: v.array(v.array(v.number())),
      levelPcts: v.array(v.number()),
      ratePcts: v.array(v.number()),
      minN: v.number(),
      cells: v.record(
        v.string(),
        v.object({
          n: v.array(v.number()),
          lv: v.array(v.nullable(v.array(v.number()))),
          won: v.array(v.nullable(v.number())),
          lost: v.array(v.nullable(v.number())),
          wn: v.array(v.number()),
          rt: v.array(v.nullable(v.array(v.number()))),
        }),
      ),
    }),
  ),
  /**
   * Lane matchups, from `assigned_lane` — the read the analytics API cannot answer, since
   * hero-counter-stats is whole-game presence rather than lane.
   *
   * `strengths[heroId]` is the fitted additive lane strength in souls at `tickS`, centred on 0.
   * `matchups[a][b]` is the ordered pair as `[n, rawDiff, residual]`: `rawDiff` is the observed
   * soul differential and `residual` is what survives removing both heroes' strengths. Read the
   * residual — the raw number mostly restates "this hero farms well", once per opponent.
   *
   * Optional for the same reason as `pace`.
   */
  lane: v.optional(
    v.object({
      tickS: v.number(),
      obs: v.number(),
      minN: v.number(),
      strengths: v.record(v.string(), v.number()),
      matchups: v.record(
        v.string(),
        v.record(v.string(), v.tuple([v.number(), v.number(), v.number()])),
      ),
    }),
  ),
});
export type WpStats = v.InferOutput<typeof WpStatsSchema>;

const URL =
  "https://raw.githubusercontent.com/pabulum/vibelock/data/wp-stats.json";

export const wpStatsQueryOptions = queryOptions({
  queryKey: ["wpStats"],
  queryFn: async (): Promise<WpStats> => {
    const r = await fetch(URL);
    if (!r.ok) throw new Error(`wp-stats fetch failed (${r.status})`);
    return parseAs(WpStatsSchema, await r.json(), URL);
  },
  staleTime: Infinity,
  gcTime: Infinity,
});

export function getWpStats(): Promise<WpStats> {
  return queryClient.fetchQuery(wpStatsQueryOptions);
}
