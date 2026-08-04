// death-map.json: the population death-density grid, baked nightly by scripts/bake-death-map.mjs.
//
// A separate asset from wp-stats.json, and fetched LAZILY rather than at boot, because only the
// Match view reads it — putting it in wp-stats would make every page load pay for a grid that most
// sessions never draw. Like wp-stats it's a static artifact refit once a day, so one fetch per
// session is plenty.
//
// Fail-soft by design: without it the death map still plots the player's own deaths, just with no
// population underlay. The query's error is deliberately never surfaced.

import * as v from "valibot";
import { queryOptions } from "@tanstack/react-query";
import { parseAs } from "./schemas";

/** Deaths past the midline, as a share, for one phase and one outcome. */
const DepthNormSchema = v.object({
  n: v.number(),
  enemyHalf: v.number(),
  q: v.record(v.string(), v.number()),
});

const DeathPhaseSchema = v.object({
  label: v.string(),
  fromS: v.number(),
  toS: v.nullable(v.number()),
  /** Deaths this phase's grid was built from. */
  n: v.number(),
  /** Raw count in the phase's hottest cell — the value the byte ramp was normalized against. */
  peak: v.number(),
  /** Split by outcome, because a winning team dies deep by pushing — comparing a player against
   * the pooled number would mostly measure whether they won. Nullish: an outcome can be missing
   * from a thin bake, and one absent arm must not blank the map. */
  depth: v.nullish(
    v.object({
      won: v.nullish(DepthNormSchema),
      lost: v.nullish(DepthNormSchema),
    }),
  ),
  /** base64, one byte per cell, row-major `size`×`size`, already normalized to `peak`. */
  grid: v.string(),
});
export type DeathPhase = v.InferOutput<typeof DeathPhaseSchema>;

const AnchorSchema = v.object({
  x: v.number(),
  y: v.number(),
  /** Deaths behind the anchor, and how far the two teams' independent measurements of it disagreed
   * after folding — the method's own error bar, kept so a future doubt is answerable. */
  n: v.nullish(v.number()),
  spread: v.nullish(v.number()),
});

const DeathMapSchema = v.object({
  generatedAt: v.string(),
  days: v.number(),
  size: v.number(),
  /** Half-width of the square world box the grid covers. A point maps to a cell by
   * `((v + halfExtent) / cell) | 0`. Square on purpose — see the bake script for why fitting each
   * axis independently would stretch the map. */
  halfExtent: v.number(),
  cell: v.number(),
  /**
   * The map's fixed structures, in the viewer's own frame (own base at negative y). The enemy's are
   * the negation of these — the map is 180°-rotation symmetric, measured, not assumed.
   *
   * Optional because the client shipped before the frame did, and a bake that predates it must
   * still draw: without a frame the map loses its landmarks and its place names, not its dots.
   */
  frame: v.nullish(
    v.object({
      core: AnchorSchema,
      tier1: v.array(v.object({ ...AnchorSchema.entries, lane: v.number() })),
      tier2: v.array(v.object({ ...AnchorSchema.entries, lane: v.number() })),
    }),
  ),
  /** The three zipline routes as world-coordinate polylines — the map's silhouette, drawn in our
   * own ink rather than as game art. Nullish for the same reason `frame` is. */
  ziplines: v.nullish(v.array(v.array(v.tuple([v.number(), v.number()])))),
  /** The game's own map radius. Documentation only: the drawing box is `halfExtent`, which is
   * wider so the routes aren't clipped at their ends. */
  mapRadius: v.nullish(v.number()),
  phases: v.array(DeathPhaseSchema),
});
export type DeathMapData = v.InferOutput<typeof DeathMapSchema>;

const URL =
  "https://raw.githubusercontent.com/pabulum/vibelock/data/death-map.json";

/**
 * Dev-only local override: `public/death-map.json`, gitignored.
 *
 * The published asset only exists once the nightly harvest has run, so before that — on a fresh
 * clone, on a fork, or on the day the bake first lands — the map draws with no population layer and
 * no landmarks at all, which looks like a broken feature rather than a missing file. Baking to
 * `OUT=public/death-map.json` makes it previewable immediately:
 *
 *     OUT=public/death-map.json node scripts/bake-death-map.mjs
 *
 * Tried FIRST rather than as a fallback, so a local bake also lets you preview a change to the bake
 * itself against the real client. Stripped from production builds: `import.meta.env.DEV` is a
 * compile-time constant, so the whole branch is dead code the bundler drops.
 */
async function local(): Promise<DeathMapData | null> {
  if (!import.meta.env.DEV) return null;
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}death-map.json`);
    if (!r.ok) return null;
    return parseAs(DeathMapSchema, await r.json(), "public/death-map.json");
  } catch {
    return null;
  }
}

export const deathMapQueryOptions = queryOptions({
  queryKey: ["deathMap"],
  queryFn: async (): Promise<DeathMapData> => {
    const dev = await local();
    if (dev) return dev;
    const r = await fetch(URL);
    if (!r.ok) throw new Error(`death-map fetch failed (${r.status})`);
    return parseAs(DeathMapSchema, await r.json(), URL);
  },
  staleTime: Infinity,
  gcTime: Infinity,
});
