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

export type SlotType = 'weapon' | 'vitality' | 'spirit' | 'unknown';

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

/** The recommended skill (ability) build. */
export interface SkillBuild {
  /** The chosen upgrade order, as ability ids. */
  order: number[];
  /** Distinct abilities in the order they get fully maxed. */
  maxPriority: number[];
  winRate: number;
  sample: number;
  /** The most-common order didn't clear the confidence floor — treat as noisy. */
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
  kind: 'innate' | 'passive' | 'active';
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

/** Why an item is in the build. */
export type BuildRole = 'universal' | 'value' | 'situational';

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
  avgNetWorthAtBuy: number;
  /** Human-readable rationale. */
  why: string;
  /** True when this item doesn't hold a permanent slot (sold, or builds into another pick). */
  transient?: boolean;
  /** Why it's transient, e.g. "builds into Burst Fire" or "often sold ~16:30". */
  transientReason?: string;
}

export interface BuildPhase {
  column: number;
  label: string;
  timeLabel: string;
  /** Target item count for the phase, derived from what players actually do. */
  targetItems: number;
  /** Average souls spent in the phase (the budget). */
  soulBudget: number;
  /** Souls the recommended core costs. */
  coreSouls: number;
  /** Souls the core spends per category — what the build invests in weapon/vitality/spirit. */
  categorySouls: Record<'weapon' | 'vitality' | 'spirit', number>;
  /** The recommended build for this phase, in buy order. */
  core: BuildItem[];
  /** Optional swaps/flex, annotated. */
  situational: BuildItem[];
}

export interface GeneratedBuild {
  hero: Hero;
  rankLabel: string;
  population: { matches: number; avgDurationS: number; baselineWinRate: number };
  phases: BuildPhase[];
  /** Count of items that hold a permanent slot (excludes transient/sold/component picks). */
  standingSlots: number;
}

export type ArchetypeKey = 'all' | 'gun' | 'spirit';

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
  kind: 'flex' | 'hybrid' | 'mono';
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
  /** Win rate − the hero's overall win rate (negative = they counter you). */
  delta: number;
  sample: number;
  /** Avg last-hit lead vs this hero (negative = you get out-farmed in lane). */
  laneCsDelta: number;
}

export interface HeroMatchups {
  baseline: number;
  tough: Matchup[];
  favorable: Matchup[];
}

/** An item that over/under-performs against a chosen enemy set. */
export interface CounterItem {
  item: Item;
  /** Win rate when facing the enemies. */
  winRate: number;
  /** Win rate − baseline win rate (the "counter" signal). */
  delta: number;
  /** Sample size behind `winRate`. */
  sample: number;
  /** True when the sample is thin enough to treat the delta with suspicion. */
  lowSample: boolean;
  /** Average buy time, mapped to a phase label for context. */
  phaseLabel: string;
}
