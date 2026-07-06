// Shared types for the Deadlock build tool.
// These mirror the shapes returned by api.deadlock-api.com (only the fields we use).

export interface Hero {
  id: number;
  name: string;
  /** Square portrait, when available. */
  image?: string;
  /** Short flavor role line, e.g. "Lights up enemies and watches them burn" (may be absent). */
  tagline?: string;
  /** The 4 signature ability class names, in in-game slot order (1→4). */
  signatureClasses: string[];
}

export type SlotType = "weapon" | "vitality" | "spirit" | "unknown";

/**
 * A cross-slot "need" an item primarily fills, derived from its *headline* (elevated/important)
 * properties — orthogonal to `slot` (sustain spans weapon/vitality/spirit: Restorative Shot is
 * weapon, Mystic Regeneration is spirit). Used to guarantee a near-universal need a slot even
 * when buyers split across substitutes so no single item clears the core pick bar.
 *
 * Only `sustain` is classified. Resist and mobility are also fragmented needs in the data, but
 * they're matchup/hero-dependent (anti-CC, armor vs a given enemy damage type), so they're left
 * out on purpose — surfacing them belongs with the counters lens, not the universal core.
 */
export type NeedKind = "sustain";

/** A hero ability (the items asset lists these as type "ability"). */
export interface Ability {
  id: number;
  name: string;
  className: string;
  image?: string;
}

/** One row from /v1/analytics/ability-order-stats — a full upgrade order with outcomes. */
export interface AbilityOrderRow {
  /** Ability ids in the order points were invested (length ~16). */
  abilities: number[];
  wins: number;
  losses: number;
  matches: number;
  players: number;
}

/** The recommended skill (ability) build — shown descriptively (no win rate; see lib/skills.ts). */
export interface SkillBuild {
  /** The chosen upgrade order, as ability ids. */
  order: number[];
  /** Distinct abilities in the order they get fully maxed. */
  maxPriority: number[];
  /** Players running this most-common order. */
  sample: number;
  /** The most-common order didn't clear the confidence floor — treat as a thin standard. */
  lowSample: boolean;
}

export interface Item {
  id: number;
  name: string;
  /** 1–4; maps to the in-shop cost column. */
  tier: number;
  cost: number;
  slot: SlotType;
  /** Shop icon URL. */
  image?: string;
  /** Cleaned one-line effect ("what it does"), e.g. "Active: immune to Stun…" or "+Spirit Resist". */
  effect?: string;
  /** Item ids this item is built from (resolved from `component_items`). */
  componentIds: number[];
  /** The cross-slot need this item primarily fills (see {@link NeedKind}); absent for most items. */
  need?: NeedKind;
  /** The full in-game shop card (stat block + passive/active abilities), for hover display. */
  card?: ItemCard;
}

/** A run of card prose; `highlight` marks the in-game `<span class="highlight">` emphasis. */
export interface TextSegment {
  text: string;
  highlight?: boolean;
}

/** One stat line on the shop card, e.g. value "+30%", label "Weapon Damage". */
export interface CardStat {
  label: string;
  value: string;
  /** An elevated/important property — the headline numbers of the section. */
  strong?: boolean;
}

/** A section of the shop card: the passive stat block, or a passive/active ability. */
export interface CardSection {
  kind: "innate" | "passive" | "active";
  /** Ability description, parsed into plain/highlighted runs (absent for the stat block). */
  text?: TextSegment[];
  stats: CardStat[];
}

/** The shop card content assembled from the items asset's tooltip_sections + properties. */
export interface ItemCard {
  sections: CardSection[];
}

/** One node from /v1/analytics/item-flow-stats — an item bought within a phase column. */
export interface FlowNode {
  column: number;
  item_id: number;
  wins: number;
  losses: number;
  players: number;
  matches: number;
  adjusted_win_rate: number;
  avg_net_worth_at_buy: number;
  total_kills: number;
  total_deaths: number;
  total_assists: number;
}

/** A phase→next-phase transition (player bought from_item, then to_item). */
export interface FlowEdge {
  from_column: number;
  from_item_id: number;
  to_item_id: number;
  wins: number;
  losses: number;
  matches: number;
}

export interface FlowSummary {
  matches: number;
  players: number;
  wins: number;
  losses: number;
  avg_duration_s: number;
  avg_net_worth: number;
}

export interface ItemFlowStats {
  nodes: FlowNode[];
  edges: FlowEdge[];
  summary: FlowSummary;
  baseline: FlowSummary;
  /** Distinct baseline games that bought any upgrade in each stage column. */
  reached_per_column: number[];
}

// ---- Generated build shapes (our own, produced by buildGenerator) ----

/** A lightweight pointer to another item, for relationship clues on a row. */
export interface ItemRef {
  id: number;
  name: string;
}

/** Why an item is in the build. `filler` = pulled in to meet a category's soul-share
 * quota, but it didn't clear the value gate — don't dress it up as a value pick. `need` =
 * guaranteed a slot because it's the plurality answer to a near-universal need (see
 * {@link NeedKind}), not because its own pick rate or win rate cleared a gate. */
export type BuildRole =
  | "universal"
  | "value"
  | "situational"
  | "filler"
  | "need";

export interface BuildItem {
  item: Item;
  role: BuildRole;
  /**
   * Fraction of players who picked this in-phase, conditioned on the build
   * chosen so far (universal/value) or marginal (situational).
   */
  pickRate: number;
  adjustedWinRate: number;
  rawWinRate: number;
  /** Number of players (sample size) behind the numbers. */
  sample: number;
  /** Decided games (wins + losses) — the denominator of the win rate, used as the sample
   * size for empirical-Bayes shrinkage toward baseline. ≈ `sample`, but it's the literal
   * win/loss count, so it's the honest n for a win-rate estimate. */
  decided: number;
  avgNetWorthAtBuy: number;
  /** Average buy time in seconds (from item-stats), carried on the item so a comp re-rank can still
   * order a phase by buy time without re-fetching it. Undefined when item-stats had no entry. */
  buyTimeS?: number;
  /** What this pick actually costs *in this build*: its sticker `item.cost` minus any components
   * you've already bought (an earlier phase, or earlier in this phase) — Deadlock refunds a built
   * item's components into the upgrade. Set on core picks; equals `item.cost` when nothing is
   * absorbed. The budget (coreSouls/categorySouls) is summed from this, not the sticker. */
  effectiveCost?: number;
  /** Human-readable rationale. */
  why: string;
  /** True when this item doesn't hold a permanent slot (sold, or builds into another pick). */
  transient?: boolean;
  /** Why it's transient, e.g. "builds into Burst Fire" or "often sold ~16:30". */
  transientReason?: string;
  /** Set when a comp is selected: the item's signed win-rate edge vs that comp (centered on
   * the matchup lean). Positive = answers the comp, negative = weak into it. */
  compEdge?: number;
  /** Convenience flag: this pick is notably weak vs the selected comp. */
  weakVsComp?: boolean;
  /** The item this most builds toward (component tree, ranked by how often players actually
   * make the jump from the flow `edges`) — a "down payment on [Y]" clue. */
  buildsToward?: ItemRef;
  /** For a situational pick: the same-slot core item it can swap in for. */
  swapFor?: ItemRef;
  /** Set when this pick was held out of core as a substitute for a specific core item — a same-slot,
   * comparable-cost every-game pick it doesn't co-occur with. Carries that core item's id so the
   * swap is paired to the right rival (not the merely cost-closest core pick). */
  swapForId?: number;
  /** If this situational pick is *core* in a later phase: that phase's label — a "core item by
   * then" clue, not a true swap. */
  coreLater?: string;
  /** Default true ("rush if ahead"): rushing it early is supported unless the later core phase wins
   * *significantly and meaningfully* more than this early buy (sample-aware — see significantlyHigher).
   * When false, `coreLater` still says it becomes core later, but we say "buy later" — early buys do
   * measurably worse, beyond what sampling noise explains. */
  coreRush?: boolean;
}

export interface BuildPhase {
  column: number;
  label: string;
  timeLabel: string;
  /** Target item count for the phase, derived from what players actually do. */
  targetItems: number;
  /** Purchases the recommended core represents — `core.length` plus any component a core upgrade
   * absorbs that's first bought *this* phase (e.g. Swift Striker folding in Rapid Rounds). Matches
   * how `targetItems` and the soul budget count a folded component as its own buy, so the readout
   * compares like with like rather than sitting a row under. */
  itemsBought: number;
  /** Average souls spent in the phase (the budget). */
  soulBudget: number;
  /** Souls the recommended core costs. */
  coreSouls: number;
  /** Souls the core spends per category — what the build invests in weapon/vitality/spirit. */
  categorySouls: Record<"weapon" | "vitality" | "spirit", number>;
  /** The recommended build for this phase, in buy order. */
  core: BuildItem[];
  /** Optional swaps/flex, annotated. */
  situational: BuildItem[];
}

/**
 * Measured co-purchase record for two items: decided games where *both* were bought, plus each
 * item's whole-game decided total (`totalA` pairs with the first argument). Undefined when either
 * side is too thin to read a ratio from. Built in generateBuild from the permutation pairs + flow;
 * carried on the build so the comp re-rank can re-apply the same substitute/co-buy decisions.
 */
export type PairGames = (
  a: number,
  b: number,
) => { joint: number; totalA: number; totalB: number } | undefined;

export interface GeneratedBuild {
  hero: Hero;
  rankLabel: string;
  population: {
    matches: number;
    avgDurationS: number;
    baselineWinRate: number;
  };
  phases: BuildPhase[];
  /** Count of items that hold a permanent slot (excludes transient/sold/component picks). */
  standingSlots: number;
  /** Prioritized "spend your surplus" list for games that drag past ~30 min with the build already
   * full: the T3+ upgrades to replace your lowest-tier slots with, ranked by how they perform in the
   * *late* window (the 30+ flow column) — not blended across the game. Highest priority first. */
  overtimeBuys: BuildItem[];
  /** Measured co-purchase lookup (see {@link PairGames}); absent when no pair data was supplied. */
  pairGames?: PairGames;
}

export type ArchetypeKey = "all" | "gun" | "spirit";

/** A coherent build for one playstyle of a flex hero (or just "all" for mono heroes). */
export interface Archetype {
  key: ArchetypeKey;
  label: string;
  /** The T3 scaling item the population was conditioned on. */
  signature?: Item;
  winRate: number;
  matches: number;
  /** Fraction of the hero's games that fit this archetype. */
  share: number;
  build: GeneratedBuild;
}

export interface ArchetypeSet {
  /** True when the hero is genuinely bimodal (both gun and spirit are well-played). */
  flex: boolean;
  /**
   * flex   = two distinct builds (toggle shown).
   * hybrid = both styles played, but the same players buy both, so one blended build.
   * mono   = the hero is single-archetype.
   */
  kind: "flex" | "hybrid" | "mono";
  /** One-line explanation of the hero's build identity. */
  note: string;
  /** Best-win-rate first; the last entry is always "all" when flex. */
  archetypes: Archetype[];
}

/** One row from /v1/analytics/hero-build-stats — a community build's outcomes at a rank. */
export interface HeroBuildStatRow {
  hero_build_id: number;
  wins: number;
  losses: number;
  matches: number;
}

/** A player-authored build from /v1/builds, reduced to the items it recommends. */
export interface CommunityBuild {
  id: number;
  name: string;
  authorId: number;
  version: number;
  /** Unix seconds the build was last edited. */
  updatedAt: number;
  /** All distinct item ids the build lists, core + situational (resolved; abilities dropped). */
  itemIds: number[];
  /**
   * Distinct items from non-situational sections (categories the author did not flag
   * `optional`). Similarity ranks on these, so a build that marks its situational tail keeps a
   * tight core and scores high, while one that dumps everything into un-flagged sections is
   * (deliberately) deranked.
   */
  coreItemIds: number[];
  /**
   * The author's skill order: ability ids in the sequence points were invested, flattened
   * from `details.ability_order.currency_changes`. Empty if the build didn't record one.
   * Used to read the build's first-max (archetype label) for skill-order alignment.
   */
  skillOrder: number[];
  /**
   * Authored imbue choices: which ability each imbue-type item was imbued onto. Only mods
   * that actually set a target are kept (authors often leave it null), so this is sparse.
   */
  imbueTargets: Array<{ itemId: number; abilityId: number }>;
}

/**
 * The ability players most commonly imbue an imbue-type item onto, aggregated across a hero's
 * community builds. It's author popularity (the only place the choice is recorded) — there's
 * no analytics endpoint that breaks win rate down by imbue target — so it's the same epistemic
 * class as the skill order, not an adjusted win rate.
 */
export interface ImbueTarget {
  ability: { id: number; name: string; image?: string };
  /** The ability's index in the hero's slot order (0–3), for its color; −1 if unknown. */
  colorIndex: number;
  /** Plurality share among the builds that set a target for this item (0–1). */
  share: number;
  /** How many builds set a target for this item — the denominator behind `share`. */
  sample: number;
}

/** A community build joined to its win-rate stats and scored against our generated build. */
export interface RankedCommunityBuild {
  build: CommunityBuild;
  /** Raw win rate among matches in the chosen rank/patch window (no adjusted rate available). */
  winRate: number;
  matches: number;
  /** Jaccard overlap of our *core* with their *core* item set, 0–1 (used for ranking). */
  similarity: number;
  /** How many of our core items appear in their core (the legible, displayed number). */
  shared: number;
  /** How many of our situational picks they also flag situational (secondary, not ranked). */
  situShared: number;
}

/** The two community builds worth surfacing for the current hero/rank/patch + our build. */
export interface CommunityMatch {
  /** Highest win rate in the rank/patch window. */
  best: RankedCommunityBuild | null;
  /** Closest item set to our generated build. */
  aligned: RankedCommunityBuild | null;
  /** True when the best-performing build is also the closest to ours (strong signal). */
  agree: boolean;
}

/** A game patch, used to time-box the analytics window. */
export interface Patch {
  title: string;
  /** Unix seconds of the patch's publish time. */
  ts: number;
}

/** One row from /v1/players/{account_id}/hero-stats — the player's own record on one hero. */
export interface PlayerHeroStat {
  hero_id: number;
  matches_played: number;
  wins: number;
  /** Unix seconds of the player's last game on this hero. */
  last_played: number;
}

/** One row from /v1/analytics/hero-stats — a hero's ladder record in the queried window/rank. */
export interface HeroLadderStat {
  hero_id: number;
  wins: number;
  losses: number;
  matches: number;
}

/** One metric's distribution from /v1/analytics/player-stats/metrics — average plus a fixed
 * percentile grid. Fetched for a ladder slice (hero+rank) or a single account. */
export interface MetricDistribution {
  avg: number;
  std: number;
  percentile1: number;
  percentile5: number;
  percentile10: number;
  percentile25: number;
  percentile50: number;
  percentile75: number;
  percentile90: number;
  percentile95: number;
  percentile99: number;
}

/** The metrics endpoint's response: metric name (e.g. "net_worth_per_min") → its distribution. */
export type PlayerMetrics = Record<string, MetricDistribution | undefined>;

/** One row from /v1/analytics/item-stats (raw, un-adjusted win rate). */
export interface ItemStat {
  item_id: number;
  wins: number;
  losses: number;
  matches: number;
  players: number;
  avg_buy_time_s: number;
  /** Average sell time in seconds among players who sold it (0 if rarely sold). */
  avg_sell_time_s: number;
}

/**
 * One row from /v1/analytics/item-permutation-stats — a specific *ordered* item permutation (the items
 * bought in this order) and its record. The endpoint is order-sensitive, so an unordered pair shows up as
 * up to two rows; synergy.ts sums a set's orderings into one unordered joint. Fetched with `comb_size`
 * (all permutations of that size for the hero); `item_ids` mode is mutually exclusive and unused here.
 */
export interface ItemPermutationStats {
  item_ids: number[];
  wins: number;
  losses: number;
  matches: number;
}

/** One cell of the hero-vs-hero counter matrix (from /v1/analytics/hero-counter-stats). */
export interface HeroCounterRow {
  hero_id: number;
  enemy_hero_id: number;
  wins: number;
  matches_played: number;
  last_hits: number;
  enemy_last_hits: number;
}

/** A notable matchup for the selected hero. */
export interface Matchup {
  enemyHeroId: number;
  winRate: number;
  /** Raw mode: win rate − the hero's overall win rate. De-noised mode: the sample-shrunk residual
   * vs the Bradley-Terry expectation (negative = they counter you beyond mere hero strength). */
  delta: number;
  /** De-noised mode only: the win rate hero strengths alone predict for this pairing. */
  expectedWinRate?: number;
  sample: number;
  /** Avg last-hit lead vs this hero (negative = you get out-farmed in lane). */
  laneCsDelta: number;
}

export interface HeroMatchups {
  baseline: number;
  tough: Matchup[];
  favorable: Matchup[];
}

/** How much an item over-performs against one specific enemy hero. */
export interface CounterMark {
  enemyHeroId: number;
  /** Raw win rate with this item when facing that enemy. */
  winRate: number;
  /** The counter edge: the item's win-rate gain vs this enemy *above the general matchup
   * lean*, so a merely-favorable matchup doesn't read as every item countering. */
  delta: number;
  /** Sample size behind `winRate`. */
  sample: number;
  /** True when the sample is thin enough to treat the delta with suspicion. */
  lowSample: boolean;
}

/** An item that gains win rate against one or more of the selected enemies, with a
 * per-enemy breakdown so each can be tagged with the specific hero's portrait. */
export interface ItemCounters {
  item: Item;
  /** Average buy time, mapped to a phase label, so it can be filed under that phase. */
  phaseLabel: string;
  /** Per-enemy gains, strongest first; only enemies the item actually beats appear. */
  marks: CounterMark[];
  /** Best single-enemy delta — used for ranking and the headline number. */
  topDelta: number;
}
