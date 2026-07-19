// Valibot schemas for everything that crosses the network boundary — the single place the
// API's word is checked. Every response is validated at parse time (see api/deadlock.ts's
// `parseAs`), and the wire types below derive from these schemas (`v.InferOutput`), so a shape
// change can't silently drift apart from the types the rest of the app compiles against.
//
// Schema discipline mirrors the old hand-written interfaces exactly: a field is required when
// every observed payload carries it (the test fixtures are captured production responses), and
// `optional`/`nullish` where the API omits or nulls it. Valibot's `v.object` ignores — and strips —
// unknown keys, so the API adding fields never breaks validation, and big payloads (match
// metadata is ~1MB) are pruned to the slice we read before they hit any cache.

import * as v from "valibot";

// ---- Analytics endpoints ----

/** One row from /v1/analytics/ability-order-stats — a full upgrade order with outcomes. */
export const AbilityOrderRowSchema = v.object({
  /** Ability ids in the order points were invested (length ~16). */
  abilities: v.array(v.number()),
  wins: v.number(),
  losses: v.number(),
  matches: v.number(),
  players: v.number(),
});
export type AbilityOrderRow = v.InferOutput<typeof AbilityOrderRowSchema>;

/** One node from /v1/analytics/item-flow-stats — an item bought within a phase column. */
export const FlowNodeSchema = v.object({
  column: v.number(),
  item_id: v.number(),
  wins: v.number(),
  losses: v.number(),
  players: v.number(),
  matches: v.number(),
  adjusted_win_rate: v.number(),
  avg_net_worth_at_buy: v.number(),
  total_kills: v.number(),
  total_deaths: v.number(),
  total_assists: v.number(),
});
export type FlowNode = v.InferOutput<typeof FlowNodeSchema>;

/** A phase→next-phase transition (player bought from_item, then to_item). */
export const FlowEdgeSchema = v.object({
  from_column: v.number(),
  from_item_id: v.number(),
  to_item_id: v.number(),
  wins: v.number(),
  losses: v.number(),
  matches: v.number(),
});
export type FlowEdge = v.InferOutput<typeof FlowEdgeSchema>;

export const FlowSummarySchema = v.object({
  matches: v.number(),
  players: v.number(),
  wins: v.number(),
  losses: v.number(),
  avg_duration_s: v.number(),
  avg_net_worth: v.number(),
});
export type FlowSummary = v.InferOutput<typeof FlowSummarySchema>;

export const ItemFlowStatsSchema = v.object({
  nodes: v.array(FlowNodeSchema),
  edges: v.array(FlowEdgeSchema),
  summary: FlowSummarySchema,
  baseline: FlowSummarySchema,
  /** Distinct baseline games that bought any upgrade in each stage column. */
  reached_per_column: v.array(v.number()),
});
export type ItemFlowStats = v.InferOutput<typeof ItemFlowStatsSchema>;

/** One row from /v1/analytics/hero-build-stats — a community build's outcomes at a rank. */
export const HeroBuildStatRowSchema = v.object({
  hero_build_id: v.number(),
  wins: v.number(),
  losses: v.number(),
  matches: v.number(),
});
export type HeroBuildStatRow = v.InferOutput<typeof HeroBuildStatRowSchema>;

/** One row from /v1/players/{account_id}/hero-stats — the player's own record on one hero. */
export const PlayerHeroStatSchema = v.object({
  hero_id: v.number(),
  matches_played: v.number(),
  wins: v.number(),
  /** Unix seconds of the player's last game on this hero. */
  last_played: v.number(),
});
export type PlayerHeroStat = v.InferOutput<typeof PlayerHeroStatSchema>;

/** One row from /v1/analytics/hero-stats — a hero's ladder record in the queried window/rank. */
export const HeroLadderStatSchema = v.object({
  hero_id: v.number(),
  wins: v.number(),
  losses: v.number(),
  matches: v.number(),
});
export type HeroLadderStat = v.InferOutput<typeof HeroLadderStatSchema>;

/** One metric's distribution from /v1/analytics/player-stats/metrics — average plus a fixed
 * percentile grid. Fetched for a ladder slice (hero+rank) or a single account. */
export const MetricDistributionSchema = v.object({
  avg: v.number(),
  std: v.number(),
  percentile1: v.number(),
  percentile5: v.number(),
  percentile10: v.number(),
  percentile25: v.number(),
  percentile50: v.number(),
  percentile75: v.number(),
  percentile90: v.number(),
  percentile95: v.number(),
  percentile99: v.number(),
});
export type MetricDistribution = v.InferOutput<typeof MetricDistributionSchema>;

export const PlayerMetricsSchema = v.record(
  v.string(),
  MetricDistributionSchema,
);
/** The metrics endpoint's response: metric name (e.g. "net_worth_per_min") → its distribution.
 * Typed with `| undefined` (unlike the schema's output) because consumers look metrics up by
 * name and must handle a metric the window simply didn't produce. */
export type PlayerMetrics = Record<string, MetricDistribution | undefined>;

/** One row from /v1/analytics/item-stats (raw, un-adjusted win rate). */
export const ItemStatSchema = v.object({
  item_id: v.number(),
  wins: v.number(),
  losses: v.number(),
  matches: v.number(),
  players: v.number(),
  avg_buy_time_s: v.number(),
  /** Average sell time in seconds among players who sold it. The API sends null for a
   * never-sold item (verified live; the captured fixtures happen to have none) — normalized
   * to 0 here, the "rarely sold" sentinel the consumers already treat as no-signal. */
  avg_sell_time_s: v.nullish(v.number(), 0),
});
export type ItemStat = v.InferOutput<typeof ItemStatSchema>;

/**
 * One row from /v1/analytics/item-permutation-stats — a specific *ordered* item permutation (the items
 * bought in this order) and its record. The endpoint is order-sensitive, so an unordered pair shows up as
 * up to two rows; synergy.ts sums a set's orderings into one unordered joint. Fetched with `comb_size`
 * (all permutations of that size for the hero); `item_ids` mode is mutually exclusive and unused here.
 */
export const ItemPermutationStatsSchema = v.object({
  item_ids: v.array(v.number()),
  wins: v.number(),
  losses: v.number(),
  matches: v.number(),
});
export type ItemPermutationStats = v.InferOutput<
  typeof ItemPermutationStatsSchema
>;

/** One cell of the hero-vs-hero counter matrix (from /v1/analytics/hero-counter-stats). */
export const HeroCounterRowSchema = v.object({
  hero_id: v.number(),
  enemy_hero_id: v.number(),
  wins: v.number(),
  matches_played: v.number(),
  last_hits: v.number(),
  enemy_last_hits: v.number(),
});
export type HeroCounterRow = v.InferOutput<typeof HeroCounterRowSchema>;

/** One match from the Steam-profile name search (/v1/players/steam-search). Names are freely
 * changeable and collide, so the UI shows avatars and lets the player pick. */
export const SteamPlayerMatchSchema = v.object({
  account_id: v.number(),
  personaname: v.string(),
  avatar: v.optional(v.string()),
});
export type SteamPlayerMatch = v.InferOutput<typeof SteamPlayerMatchSchema>;

/** One row of the batch mmr endpoint (/v1/players/mmr) — only `division` is read. */
export const MmrRowSchema = v.object({
  division: v.optional(v.number()),
});
export type MmrRow = v.InferOutput<typeof MmrRowSchema>;

// ---- Single-match metadata (match analysis) ----
// The slice of /v1/matches/{id}/metadata the analyzer reads. The full payload is ~1MB with dozens
// more fields per player; validation strips everything not schematized here.

/** One entry of a player's per-source soul ledger. Sources are the EGoldSource enum, verified
 * numerically against the flat `gold_*` fields: 1 kills, 2 lane creeps, 3 neutral camps, 4 bosses,
 * 5 treasure (urn), 6 assists, 7 denies, 8 team bonus, 10/11 item-generated, 12 breakables. */
export const MatchGoldSourceSchema = v.object({
  source: v.number(),
  gold: v.optional(v.number()),
  gold_orbs: v.optional(v.number()),
  kills: v.optional(v.number()),
});
export type MatchGoldSource = v.InferOutput<typeof MatchGoldSourceSchema>;

/** A sampled snapshot of one player's stats at `time_stamp_s` (~every 3–4 min plus game end). */
export const MatchStatSampleSchema = v.object({
  time_stamp_s: v.number(),
  net_worth: v.number(),
  kills: v.number(),
  deaths: v.number(),
  assists: v.number(),
  last_hits: v.optional(v.number()),
  denies: v.number(),
  creep_kills: v.optional(v.number()),
  neutral_kills: v.optional(v.number()),
  shots_hit: v.optional(v.number()),
  shots_missed: v.optional(v.number()),
  player_damage: v.optional(v.number()),
  player_healing: v.optional(v.number()),
  player_damage_taken: v.optional(v.number()),
  gold_death_loss: v.optional(v.number()),
  gold_sources: v.optional(v.array(MatchGoldSourceSchema)),
});
export type MatchStatSample = v.InferOutput<typeof MatchStatSampleSchema>;

export const MatchItemEventSchema = v.object({
  game_time_s: v.number(),
  item_id: v.number(),
  sold_time_s: v.optional(v.number()),
  /** Non-zero when this purchase event upgraded into that item id. */
  upgrade_id: v.optional(v.number()),
  imbued_ability_id: v.optional(v.number()),
});
export type MatchItemEvent = v.InferOutput<typeof MatchItemEventSchema>;

export const MatchDeathSchema = v.object({
  game_time_s: v.number(),
  /** Slot of the killer, resolvable to a player via `player_slot`. */
  killer_player_slot: v.optional(v.number()),
  /** How long the engagement that killed you lasted. `-1` is the API's "unknown" sentinel — always
   * guard for it. Measured distribution across a real match: p25 ≈ 7s, median ≈ 13s, p75 ≈ 19s, so a
   * sub-5s death is genuinely a burst, not just the low end of normal. */
  time_to_kill_s: v.optional(v.number()),
});
export type MatchDeath = v.InferOutput<typeof MatchDeathSchema>;

export const MatchPlayerSchema = v.object({
  account_id: v.number(),
  player_slot: v.number(),
  /** "Team0" | "Team1" (proto enum names, not numbers). */
  team: v.string(),
  hero_id: v.number(),
  kills: v.number(),
  deaths: v.number(),
  assists: v.number(),
  net_worth: v.number(),
  last_hits: v.optional(v.number()),
  denies: v.optional(v.number()),
  assigned_lane: v.optional(v.number()),
  abandon_match_time_s: v.optional(v.number()),
  items: v.optional(v.array(MatchItemEventSchema)),
  stats: v.optional(v.array(MatchStatSampleSchema)),
  death_details: v.optional(v.array(MatchDeathSchema)),
});
export type MatchPlayer = v.InferOutput<typeof MatchPlayerSchema>;

export const MatchInfoSchema = v.object({
  match_id: v.number(),
  start_time: v.number(),
  duration_s: v.number(),
  /** "Team0" | "Team1". */
  winning_team: v.string(),
  average_badge_team0: v.optional(v.number()),
  average_badge_team1: v.optional(v.number()),
  players: v.array(MatchPlayerSchema),
});
export type MatchInfo = v.InferOutput<typeof MatchInfoSchema>;

/** The metadata endpoint wraps the match under `match_info`. */
export const MatchMetadataResponseSchema = v.object({
  match_info: MatchInfoSchema,
});

/** One row of /v1/players/{id}/match-history (Steam-sourced; can lag the ingested DB). */
export const MatchHistoryRowSchema = v.object({
  match_id: v.number(),
  hero_id: v.number(),
  start_time: v.number(),
  match_duration_s: v.number(),
  /** The WINNING TEAM's number (0/1), not a won/lost flag — verified against match metadata on
   * matches with known outcomes. The player won iff `match_result === player_team`. */
  match_result: v.number(),
  /** Which team (0/1) this player was on. */
  player_team: v.number(),
  player_kills: v.number(),
  player_deaths: v.number(),
  player_assists: v.number(),
  net_worth: v.number(),
});
export type MatchHistoryRow = v.InferOutput<typeof MatchHistoryRowSchema>;

// ---- Raw asset payloads (processed into Hero/Item/Ability/Patch in api/deadlock.ts) ----

export const RawHeroSchema = v.object({
  id: v.number(),
  // A hero the API hasn't named yet defaults to "" and is filtered out downstream.
  name: v.optional(v.string(), ""),
  image: v.optional(v.string()),
  images: v.optional(v.object({ icon_hero_card: v.optional(v.string()) })),
  description: v.nullish(v.object({ role: v.nullish(v.string()) })),
  // Ability class names by slot; values are typeof-checked at the read site, so stay loose here.
  items: v.optional(v.record(v.string(), v.unknown())),
});
export type RawHero = v.InferOutput<typeof RawHeroSchema>;

const RawPropSchema = v.object({
  value: v.nullish(v.union([v.string(), v.number()])),
  postfix: v.optional(v.string()),
  label: v.optional(v.string()),
  /** When `value` equals this, the stat is inactive for the item and not shown. */
  disable_value: v.optional(v.union([v.string(), v.number()])),
});
export type RawProp = v.InferOutput<typeof RawPropSchema>;

const RawTooltipSectionSchema = v.object({
  section_type: v.nullish(v.string()),
  section_attributes: v.optional(
    v.array(
      v.object({
        loc_string: v.nullish(v.string()),
        properties: v.optional(v.array(v.string())),
        elevated_properties: v.optional(v.array(v.string())),
        important_properties: v.optional(v.array(v.string())),
      }),
    ),
  ),
});

export const RawItemSchema = v.object({
  id: v.number(),
  name: v.optional(v.string(), ""),
  type: v.optional(v.string()),
  class_name: v.optional(v.string()),
  item_tier: v.optional(v.number()),
  item_slot_type: v.nullish(v.string()),
  cost: v.nullish(v.number()),
  shop_image: v.optional(v.string()),
  image: v.optional(v.string()),
  description: v.nullish(
    v.union([v.object({ desc: v.nullish(v.string()) }), v.string()]),
  ),
  is_active_item: v.optional(v.boolean()),
  properties: v.optional(v.record(v.string(), RawPropSchema)),
  tooltip_sections: v.optional(v.array(RawTooltipSectionSchema)),
  component_items: v.optional(v.array(v.string())),
});
export type RawItem = v.InferOutput<typeof RawItemSchema>;

/** /v2/patches entry — only the title is read (the MM-DD-YYYY date in it is the reliable key;
 * the feed's pub_date is re-stamped on Forum entries and can't be trusted). */
export const RawPatchSchema = v.object({
  title: v.optional(v.string()),
  /** The notes body. Forum-feed entries carry only a link-unfurl (empty text); the Steam-feed copy
   * of the same patch carries the real changelog, which lib/patchChanges parses for touched items. */
  content: v.optional(v.string()),
});
export type RawPatch = v.InferOutput<typeof RawPatchSchema>;

export const RawBuildEnvelopeSchema = v.object({
  hero_build: v.optional(
    v.object({
      hero_build_id: v.number(),
      name: v.nullish(v.string()),
      author_account_id: v.nullish(v.number()),
      version: v.nullish(v.number()),
      last_updated_timestamp: v.nullish(v.number()),
      publish_timestamp: v.nullish(v.number()),
      details: v.nullish(
        v.object({
          mod_categories: v.nullish(
            v.array(
              v.object({
                name: v.nullish(v.string()),
                // Author flag marking a section as situational. Set on ~a third of sections; null
                // (the majority) means unmarked, which we treat as core. Only `true` demotes.
                optional: v.nullish(v.boolean()),
                mods: v.nullish(
                  v.array(
                    v.object({
                      ability_id: v.nullish(v.number()),
                      imbue_target_ability_id: v.nullish(v.number()),
                    }),
                  ),
                ),
              }),
            ),
          ),
          // Ordered ability-point investments; flattened to the build's skill order.
          ability_order: v.nullish(
            v.object({
              currency_changes: v.nullish(
                v.array(v.object({ ability_id: v.nullish(v.number()) })),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
});
export type RawBuildEnvelope = v.InferOutput<typeof RawBuildEnvelopeSchema>;

/** Validate `data` (a parsed JSON response from `url`) against `schema`, throwing a compact,
 * user-explainable error on mismatch — the message names the endpoint and the first offending
 * path, never the full payload. */
export function parseAs<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(schema: TSchema, data: unknown, url: string): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, data);
  if (!result.success) {
    const issue = result.issues[0];
    const path = v.getDotPath(issue);
    const endpoint = new URL(url).pathname;
    throw new Error(
      `Unexpected response shape from ${endpoint}${path ? ` at ${path}` : ""}: ${issue.message}`,
    );
  }
  return result.output;
}
