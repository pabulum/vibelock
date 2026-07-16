// Shared types for the Deadlock build tool.
//
// Wire types (shapes returned by api.deadlock-api.com) derive from the Valibot schemas that
// validate them at the API boundary — see api/schemas.ts — and are re-exported here so consumers
// keep importing everything from one place. What remains below are the client-side shapes: assets
// processed from raw payloads (Hero/Item/Ability/Patch) and everything the generator produces.

export type {
  AbilityOrderRow,
  FlowNode,
  FlowEdge,
  FlowSummary,
  ItemFlowStats,
  HeroBuildStatRow,
  PlayerHeroStat,
  HeroLadderStat,
  MetricDistribution,
  PlayerMetrics,
  ItemStat,
  ItemPermutationStats,
  HeroCounterRow,
  MatchGoldSource,
  MatchStatSample,
  MatchItemEvent,
  MatchDeath,
  MatchPlayer,
  MatchInfo,
  MatchHistoryRow,
} from "./api/schemas";

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
  /** Win rate used for *ranking/gating* only, never for display — the shown WR stays `adjustedWinRate`.
   * When line-aware generation is on (see BuildOptions.lineAware), an upgrade's rank WR is shrunk toward
   * its component's broader win rate to discount survivorship (few reach a deep upgrade ⇒ its raw WR is
   * selection-inflated). Undefined ⇒ ranking falls back to `adjustedWinRate` (identical to before). */
  rankWinRate?: number;
  rawWinRate: number;
  /** Set when the server's `adjusted_win_rate` was discarded because the net worth it standardizes on
   * is corrupt upstream (see unreliableAdjustedNodes) — `adjustedWinRate` then carries the RAW rate,
   * so the row shows an honest number rather than one adjusted against end-of-game wealth. Lane-phase
   * cheap items only; undefined everywhere else. */
  unadjusted?: boolean;
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
  /** How it leaves the inventory — drives the row's badge. "part": consumed by an in-build upgrade
   * (PART). "sold": sell-fodder — a cheap stat-stick that measurably leaves inventory early, or the
   * weakest pick marked to sell when the build overflows the slot cap; either way it's what you give
   * up when slots bind (SELL). Set iff `transient`. */
  transientKind?: "part" | "sold";
  /** Why it's transient, e.g. "builds into Burst Fire". Undefined for a cheap early stat-stick —
   * those get only the badge (the old "often sold ~mm:ss" time was really upgrade timing; see
   * markTransient). */
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
  /** The overtime shopping list for games that drag past ~30 min with the build already full: T3+
   * upgrades judged in the *late* window (the 30+ flow column), with anything already core in the
   * build filtered out — the premise is the build is bought, so those are owned (and items are
   * unique, so they're literally unbuyable). Two groups, flagged by `role`: `"universal"` = default
   * upgrades (adoption-admitted staples, like a phase core — no win-rate gate), followed by
   * `"situational"` = sub-universal picks whose late edge is confidently positive but conditional
   * on the game (buyer-selected). Each group strongest first. */
  overtimeBuys: BuildItem[];
  /** The ranked overtime pool *before* the "already core" exclusion — every candidate that cleared
   * the tier/support/edge gates, strongest first. Kept because core membership isn't final at
   * generation: a comp re-rank ({@link rerankBuildForComp}) moves items between core and
   * situational, and the exclusion has to be re-applied against the core the player actually sees,
   * or a promoted pick shows up as both "you own this by 20 min" and "buy this at 30+". */
  overtimePool: BuildItem[];
  /** The sell side of overtime: the ≤T2 picks still holding a standing slot once the build is
   * bought — the slots you free, weakest first, when an overtime buy needs room (slots, not souls,
   * are the late-game constraint). */
  overtimeSell: BuildItem[];
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

/** A notable matchup for the selected hero. */
export interface Matchup {
  enemyHeroId: number;
  winRate: number;
  /** Win rate − the hero's overall win rate (negative = this enemy counters you). */
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
