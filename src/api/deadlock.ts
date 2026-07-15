// Thin client for api.deadlock-api.com. The API sends `access-control-allow-origin: *`,
// so we call it straight from the browser — no backend, no API key.

import type {
  Ability,
  AbilityOrderRow,
  CardSection,
  CardStat,
  CommunityBuild,
  Hero,
  HeroBuildStatRow,
  HeroCounterRow,
  HeroLadderStat,
  Item,
  ItemCard,
  ItemFlowStats,
  ItemPermutationStats,
  ItemStat,
  MatchHistoryRow,
  MatchInfo,
  NeedKind,
  Patch,
  PlayerHeroStat,
  PlayerMetrics,
  SlotType,
  TextSegment,
} from "../types";

const BASE = "https://api.deadlock-api.com";

// Assets (heroes/items) change rarely; cache them in module scope + localStorage.
const ASSET_TTL_MS = 24 * 60 * 60 * 1000;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_RETRIES = 3;

// How long to wait before retrying a 429. The API signals its limit with standard
// `ratelimit-*` headers (analytics endpoints allow 200 requests / 60s per IP), but a
// browser only sees `retry-after` / `ratelimit-reset` cross-origin if the server
// allow-lists them — so treat those as a hint and otherwise back off exponentially.
function retryAfterMs(res: Response, attempt: number): number {
  for (const h of ["retry-after", "ratelimit-reset"]) {
    const v = Number(res.headers.get(h));
    if (Number.isFinite(v) && v > 0) return Math.min(v * 1000, 30_000);
  }
  return Math.min(8000, 400 * 2 ** attempt) + Math.random() * 300; // jittered backoff
}

async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    // Retry rate limits (per the server's hint) and transient 5xx flaps (the API intermittently
    // 500s under load; one page load fans out enough queries that a single flap otherwise lands
    // the error banner on a healthy session).
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await delay(retryAfterMs(res, attempt));
      continue;
    }
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText} for ${url}`);
    }
    return res.json() as Promise<T>;
  }
}

// Cap how many analytics requests are in flight at once. A single session stays well
// under the 200/60s limit in normal use, but clicking quickly through heroes/ranks
// fans out enough parallel queries (archetype splits, locked paths, counters) to burst
// past it; the cap spreads a burst over time instead of firing it all at once.
const MAX_INFLIGHT = 5;
let inflight = 0;
const queue: Array<() => void> = [];

function pump(): void {
  if (inflight >= MAX_INFLIGHT) return;
  const next = queue.shift();
  if (!next) return;
  inflight++;
  next();
}

// Run `task` once a concurrency slot frees up, releasing it (and pumping the queue)
// when the task settles either way.
function throttle<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push(() =>
      task()
        .then(resolve, reject)
        .finally(() => {
          inflight--;
          pump();
        }),
    );
    pump();
  });
}

// Analytics endpoints recompute server-side and return small payloads, but a cold
// query can take several seconds. Cache each response in-memory (session-scoped) by
// URL, so revisiting a hero/rank/patch — or two effects asking for the same query —
// costs one round trip, not N. Cleared on reload; assets use the longer-lived cache.
const analyticsCache = new Map<string, Promise<unknown>>();

function getAnalytics<T>(url: string): Promise<T> {
  const hit = analyticsCache.get(url);
  if (hit) return hit as Promise<T>;
  const p = throttle(() => getJson<T>(url));
  analyticsCache.set(url, p);
  p.catch(() => analyticsCache.delete(url)); // never cache a failure
  return p;
}

function cached<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { at, data } = JSON.parse(raw) as { at: number; data: T };
    if (Date.now() - at > ASSET_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

/** The cached copy regardless of age — the fallback when a refresh fails and a stale answer
 * beats no answer (see getPatches). */
function cachedStale<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return (JSON.parse(raw) as { data: T }).data;
  } catch {
    return null;
  }
}

function putCache<T>(key: string, data: T): void {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // localStorage full / disabled — fine, we just refetch next time.
  }
}

let heroesPromise: Promise<Hero[]> | null = null;

export function getHeroes(): Promise<Hero[]> {
  if (heroesPromise) return heroesPromise;
  heroesPromise = (async () => {
    const cacheKey = "dl.heroes.v3";
    const hit = cached<Hero[]>(cacheKey);
    if (hit) return hit;
    const raw = await getJson<RawHero[]>(
      `${BASE}/v1/assets/heroes?only_active=true`,
    );
    const heroes = raw
      .filter((h) => h.name)
      .map<Hero>((h) => ({
        id: h.id,
        name: h.name,
        image: h.images?.icon_hero_card ?? h.image,
        tagline: h.description?.role?.trim() || undefined,
        signatureClasses: [1, 2, 3, 4]
          .map((n) => h.items?.[`signature${n}`])
          .filter((c): c is string => typeof c === "string"),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    putCache(cacheKey, heroes);
    return heroes;
  })();
  return heroesPromise;
}

// The /v1/assets/items list contains both items and abilities; fetch it once and
// derive both maps from it.
let rawItemsPromise: Promise<RawItem[]> | null = null;
function getRawItems(): Promise<RawItem[]> {
  if (!rawItemsPromise)
    rawItemsPromise = getJson<RawItem[]>(`${BASE}/v1/assets/items`);
  return rawItemsPromise;
}

let itemsPromise: Promise<Map<number, Item>> | null = null;

export function getItems(): Promise<Map<number, Item>> {
  if (itemsPromise) return itemsPromise;
  itemsPromise = (async () => {
    const cacheKey = "dl.items.v5";
    const hit = cached<Item[]>(cacheKey);
    const list = hit ?? buildItemList(await getRawItems());
    if (!hit) putCache(cacheKey, list);
    return new Map(list.map((i) => [i.id, i]));
  })();
  return itemsPromise;
}

let abilitiesPromise: Promise<Map<number, Ability>> | null = null;

export function getAbilities(): Promise<Map<number, Ability>> {
  if (abilitiesPromise) return abilitiesPromise;
  abilitiesPromise = (async () => {
    const cacheKey = "dl.abilities.v2";
    const hit = cached<Ability[]>(cacheKey);
    const list =
      hit ??
      (await getRawItems())
        .filter((i) => i.type === "ability" && i.name)
        .map<Ability>((i) => ({
          id: i.id,
          name: i.name,
          className: i.class_name ?? "",
          image: i.image ?? i.shop_image,
        }));
    if (!hit) putCache(cacheKey, list);
    return new Map(list.map((a) => [a.id, a]));
  })();
  return abilitiesPromise;
}

export interface AbilityOrderQuery extends TimeWindow, RankWindow {
  heroId: number;
  minMatches?: number;
  /** Restrict to players who bought these items (used to match the build archetype). */
  includeItemIds?: number[];
}

export function getAbilityOrder(
  q: AbilityOrderQuery,
): Promise<AbilityOrderRow[]> {
  const params = new URLSearchParams({
    hero_id: String(q.heroId),
    min_matches: String(q.minMatches ?? 100),
  });
  applyRank(params, q);
  if (q.includeItemIds?.length)
    params.set("include_item_ids", q.includeItemIds.join(","));
  applyWindow(params, q);
  return getAnalytics<AbilityOrderRow[]>(
    `${BASE}/v1/analytics/ability-order-stats?${params}`,
  );
}

function normalizeSlot(s: string | null | undefined): SlotType {
  if (s === "weapon" || s === "vitality" || s === "spirit") return s;
  return "unknown";
}

// Property keys that mark an item as *sustain* — self-healing of any mechanism: lifesteal,
// active/triggered heals, passive & out-of-combat regen, and heal amplification. Deliberately
// excludes anti-heal (HealAmp*Penalty*), barriers/shields (temporary HP, not healing), pure
// max-HP (BonusHealth), and offensive %-of-health damage. An item counts only when one of these
// is its *headline* stat (elevated/important), so incidental regen (Sprint Boots' move speed,
// Extra Spirit's spirit power) doesn't read as a sustain pickup.
const SUSTAIN_PROPS = new Set([
  // lifesteal
  "BulletLifestealPercent",
  "AbilityLifestealPercentHero",
  "AbilityLifestealPercentHeroPassive",
  "LifestealHeal",
  "LifestealHealPercent",
  "LifestrikeHeal",
  "LifestrikeHealPercent",
  "HealthStealPctHero",
  "ActiveBonusLifesteal",
  "LowHealthLifeStealPercent",
  "AssaultLifestealPercent",
  // active / triggered heals
  "Regeneration",
  "RegenerationDuration",
  "RegenDuration",
  "TotalHealthRegen",
  "HealAmount",
  "HealInterval",
  "HealRadius",
  "HealOnActivate",
  "HealOnSuccess",
  "HealPercentAmount",
  "HealPerStack",
  "HealingPerCast",
  "ParrySuccessHeal",
  "HealOnVeil",
  "HealOnKill",
  "HealPercentPerHeadshot",
  "HealFromHero",
  "HealFromNPC",
  "RespawnHealthPercent",
  // passive / out-of-combat regen
  "BonusHealthRegen",
  "OutOfCombatHealthRegen",
  "HealLifePercentOutOfCombat",
  "HealOnLevelHealAmount",
  // heal amplification
  "HealAmpCastPercent",
  "HealAmpRegenPercent",
]);

/** The cross-slot need an item primarily fills, from its headline (elevated/important) props. */
function classifyNeed(i: RawItem): NeedKind | undefined {
  for (const sec of i.tooltip_sections ?? [])
    for (const sa of sec.section_attributes ?? [])
      for (const key of [
        ...(sa.elevated_properties ?? []),
        ...(sa.important_properties ?? []),
      ])
        if (SUSTAIN_PROPS.has(key)) return "sustain";
  return undefined;
}

// Items list `component_items` as class names; resolve them to ids so the build
// can tell when one pick builds into another (a shared slot, not a second item).
function buildItemList(raw: RawItem[]): Item[] {
  const idByClass = new Map<string, number>();
  for (const i of raw) if (i.class_name) idByClass.set(i.class_name, i.id);
  return raw
    .filter((i) => i.item_slot_type && i.item_tier)
    .map<Item>((i) => ({
      id: i.id,
      name: i.name,
      tier: i.item_tier as number,
      cost: i.cost ?? 0,
      slot: normalizeSlot(i.item_slot_type),
      image: i.shop_image ?? i.image,
      effect: extractEffect(i),
      componentIds: (i.component_items ?? [])
        .map((cn) => idByClass.get(cn))
        .filter((id): id is number => id !== undefined),
      need: classifyNeed(i),
      card: buildCard(i),
    }));
}

// Assemble the in-game shop card: each tooltip_section names property keys (and an
// optional prose loc_string), which we resolve against the item's `properties` map.
function buildCard(i: RawItem): ItemCard | undefined {
  const props = i.properties ?? {};
  const sections: CardSection[] = [];

  for (const sec of i.tooltip_sections ?? []) {
    const kind: CardSection["kind"] =
      sec.section_type === "innate"
        ? "innate"
        : sec.section_type === "active"
          ? "active"
          : "passive";
    const stats: CardStat[] = [];
    let text: TextSegment[] | undefined;

    for (const sa of sec.section_attributes ?? []) {
      if (sa.loc_string && !text) text = parseLoc(sa.loc_string);
      // Bonuses in the stat block read as buffs, so sign them; ability props (cooldown…) don't.
      const sign = kind === "innate";
      for (const key of sa.properties ?? [])
        pushStat(stats, props[key], false, sign);
      for (const key of sa.elevated_properties ?? [])
        pushStat(stats, props[key], true, sign);
      for (const key of sa.important_properties ?? [])
        pushStat(stats, props[key], true, sign);
    }

    if (text?.length || stats.length) sections.push({ kind, text, stats });
  }

  return sections.length ? { sections } : undefined;
}

function pushStat(
  out: CardStat[],
  p: RawProp | undefined,
  strong: boolean,
  sign: boolean,
): void {
  if (!p) return;
  const raw = p.value;
  if (raw === undefined || raw === null) return;
  const s = String(raw).trim();
  if (!s) return;
  // disable_value / 0 means the stat is inactive for this item — skip it.
  if (p.disable_value !== undefined && s === String(p.disable_value)) return;
  const label = (p.label ?? "").trim();
  if (!label) return; // label-less props are values inlined into the prose (e.g. thresholds)

  const numeric = /^-?\d+(?:\.\d+)?$/.test(s);
  if (numeric && Number(s) === 0) return;
  const n = numeric ? Number(s) : NaN;
  let value = (numeric ? String(n) : s) + (p.postfix ?? "");
  if (sign && numeric && n > 0) value = `+${value}`;
  out.push({ label, value, strong });
}

// loc_string carries markup: inline <svg> damage-type icons (drop them) and
// <span class="highlight"> emphasis (keep, flagged). Everything else is stripped.
function parseLoc(s: string): TextSegment[] {
  const noSvg = s.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  const re = /<span[^>]*class="highlight"[^>]*>([\s\S]*?)<\/span>/gi;
  const segs: TextSegment[] = [];
  const add = (chunk: string, highlight: boolean) => {
    const clean = chunk.replace(/<[^>]*>/g, "").replace(/\s+/g, " ");
    if (clean !== "") segs.push({ text: clean, highlight });
  };

  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noSvg))) {
    add(noSvg.slice(last, m.index), false);
    add(m[1], true);
    last = re.lastIndex;
  }
  add(noSvg.slice(last), false);

  if (segs.length) {
    segs[0].text = segs[0].text.replace(/^ /, "");
    segs[segs.length - 1].text = segs[segs.length - 1].text.replace(/ $/, "");
  }
  return segs.filter((seg) => seg.text !== "");
}

// Human labels for the headline stats of items that lack a prose description.
const STAT_LABELS: Record<string, string> = {
  TechPower: "Spirit Power",
  TechResist: "Spirit Resist",
  TechLifestealPercent: "Spirit Lifesteal",
  AbilityLifestealPercentHero: "Spirit Lifesteal",
  BulletResist: "Bullet Resist",
  BulletLifestealPercent: "Bullet Lifesteal",
  BaseAttackDamagePercent: "Weapon Damage",
  BonusFireRate: "Fire Rate",
  BonusClipSizePercent: "Ammo",
  BonusBulletSpeedPercent: "Bullet Velocity",
  BonusAttackRangePercent: "Attack Range",
  BonusZoomPercent: "Zoom",
  BonusHealth: "Health",
  BonusBaseHealth: "Health",
  BonusHealthRegen: "Health Regen",
  BonusMoveSpeed: "Move Speed",
  BonusSprintSpeed: "Sprint Speed",
  BonusAbilityCharges: "Ability Charges",
  BonusAbilityDurationPercent: "Ability Duration",
  BonusMeleeDamagePercent: "Melee Damage",
};

/** A short "what it does" line: prose description if present, else the headline stat. */
function extractEffect(i: RawItem): string | undefined {
  const desc =
    typeof i.description === "object" ? i.description?.desc : i.description;
  const cleaned = cleanText(desc);
  if (cleaned) return i.is_active_item ? `Active: ${cleaned}` : cleaned;

  const stat =
    i.tooltip_sections?.[0]?.section_attributes?.[0]?.elevated_properties?.[0];
  const label = stat ? STAT_LABELS[stat] : undefined;
  return label ? `+${label}` : undefined;
}

function cleanText(s: string | undefined | null): string | undefined {
  if (!s) return undefined;
  const t = s
    .replace(/<[^>]*>/g, " ") // strip markup
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;)])/g, "$1") // tidy spaces left before punctuation
    .replace(/\(\s+/g, "(")
    .trim();
  if (!t) return undefined;
  return t.length > 120 ? `${t.slice(0, 117)}…` : t;
}

/** A time window for the analytics endpoints (Unix seconds). Omit for "last 30 days". */
export interface TimeWindow {
  minUnixTimestamp?: number;
  maxUnixTimestamp?: number;
}

function applyWindow(params: URLSearchParams, w?: TimeWindow): void {
  if (w?.minUnixTimestamp)
    params.set("min_unix_timestamp", String(w.minUnixTimestamp));
  if (w?.maxUnixTimestamp)
    params.set("max_unix_timestamp", String(w.maxUnixTimestamp));
}

/** A rank slice for the analytics endpoints, as average_badge values (tier·10 + subrank). Floor
 * only = the classic "this tier and above"; floor + ceiling = a band ("around my rank"). */
export interface RankWindow {
  minBadge: number;
  /** Highest average_badge to include, e.g. tier·10+6 for a tier's top subrank. Omit for a floor. */
  maxBadge?: number;
}

function applyRank(params: URLSearchParams, q: RankWindow): void {
  params.set("min_average_badge", String(q.minBadge));
  if (q.maxBadge !== undefined)
    params.set("max_average_badge", String(q.maxBadge));
}

export interface FlowQuery extends TimeWindow, RankWindow {
  heroId: number;
  /** Drop nodes/edges below this many matches (server-side noise floor). */
  minMatches?: number;
  /**
   * Items to lock as a fixed build path (conditions the population). Pairs
   * positionally with `lockedColumns`.
   */
  lockedItemIds?: number[];
  lockedColumns?: number[];
  /** Restrict the population to players who bought all of these items (archetype split). */
  includeItemIds?: number[];
}

export function getItemFlowStats(q: FlowQuery): Promise<ItemFlowStats> {
  const params = new URLSearchParams({
    // GOTCHA: flow-stats filters on `hero_ids` (plural). item-stats and permutation-stats below
    // take `hero_id` (singular). Passing `hero_id` here is silently ignored — the query returns the
    // ALL-HEROES aggregate (≈6× inflated samples), which looks plausible until the baseline is wrong.
    hero_ids: String(q.heroId),
    min_matches: String(q.minMatches ?? 100),
  });
  applyRank(params, q);
  if (q.lockedItemIds?.length && q.lockedColumns?.length) {
    params.set("locked_item_ids", q.lockedItemIds.join(","));
    params.set("locked_columns", q.lockedColumns.join(","));
  }
  if (q.includeItemIds?.length)
    params.set("include_item_ids", q.includeItemIds.join(","));
  applyWindow(params, q);
  return getAnalytics<ItemFlowStats>(
    `${BASE}/v1/analytics/item-flow-stats?${params}`,
  );
}

export interface ItemStatsQuery extends TimeWindow, RankWindow {
  heroId: number;
  /** Filter to matches where any of these heroes were on the enemy team. */
  enemyHeroIds?: number[];
  minMatches?: number;
}

export interface PermutationQuery extends TimeWindow, RankWindow {
  heroId: number;
  /** Size of the item permutations to return (default 2 = pairs). `item_ids` mode is mutually exclusive
   * with this and unused — we want every pair for the hero, then aggregate orderings client-side. */
  combSize?: number;
}

/**
 * Every item permutation of size `combSize` (default 2) for the hero, with its win/loss record. Note this
 * is one largish payload (all pairs ≈ 1–2 MB), cached server-side 1h and in our analytics cache, so it's
 * fetched on demand (the synergy view), not on every build. See {@link ItemPermutationStats}.
 */
export function getItemPermutationStats(
  q: PermutationQuery,
): Promise<ItemPermutationStats[]> {
  const params = new URLSearchParams({
    hero_id: String(q.heroId),
    comb_size: String(q.combSize ?? 2),
  });
  applyRank(params, q);
  applyWindow(params, q);
  return getAnalytics<ItemPermutationStats[]>(
    `${BASE}/v1/analytics/item-permutation-stats?${params}`,
  );
}

export function getItemStats(q: ItemStatsQuery): Promise<ItemStat[]> {
  const params = new URLSearchParams({
    hero_id: String(q.heroId),
    min_matches: String(q.minMatches ?? 20),
  });
  applyRank(params, q);
  if (q.enemyHeroIds?.length)
    params.set("enemy_hero_ids", q.enemyHeroIds.join(","));
  applyWindow(params, q);
  return getAnalytics<ItemStat[]>(`${BASE}/v1/analytics/item-stats?${params}`);
}

// Win rate of each player-authored build, over matches in the window at/above the rank
// floor. `min_average_badge` filters by the *match's* average badge (both teams) — i.e.
// how the build performs at that rank, not the author's rank.
export function getHeroBuildStats(
  q: ItemStatsQuery,
): Promise<HeroBuildStatRow[]> {
  const params = new URLSearchParams({
    min_matches: String(q.minMatches ?? 20),
  });
  applyRank(params, q);
  applyWindow(params, q);
  return getAnalytics<HeroBuildStatRow[]>(
    `${BASE}/v1/analytics/hero-build-stats/${q.heroId}?${params}`,
  );
}

// The community builds for a hero, latest version of each, most-favorited first, reduced
// to the items each recommends (mod entries that resolve to a known item; abilities drop).
export async function getCommunityBuilds(
  heroId: number,
): Promise<CommunityBuild[]> {
  const params = new URLSearchParams({
    hero_id: String(heroId),
    only_latest: "true",
    sort_by: "favorites",
    sort_direction: "desc",
    limit: "200",
  });
  const [raw, items] = await Promise.all([
    getAnalytics<RawBuildEnvelope[]>(`${BASE}/v1/builds?${params}`),
    getItems(),
  ]);
  return raw
    .map((env) => parseCommunityBuild(env, items))
    .filter((b): b is CommunityBuild => b !== null);
}

function parseCommunityBuild(
  env: RawBuildEnvelope,
  items: Map<number, Item>,
): CommunityBuild | null {
  const hb = env.hero_build;
  if (!hb) return null;
  const ids = new Set<number>();
  const coreIds = new Set<number>();
  const imbueTargets: Array<{ itemId: number; abilityId: number }> = [];
  for (const cat of hb.details?.mod_categories ?? []) {
    const core = cat.optional !== true; // unmarked (null) counts as core; only `true` is situational
    for (const mod of cat.mods ?? []) {
      const id = mod.ability_id;
      if (id === undefined || !items.has(id)) continue;
      ids.add(id);
      if (core) coreIds.add(id);
      // Only imbue-type items carry a target; most mods leave it null. Keep the raw pair —
      // resolving the target id to an ability happens where the abilities map is loaded.
      if (mod.imbue_target_ability_id) {
        imbueTargets.push({
          itemId: id,
          abilityId: mod.imbue_target_ability_id,
        });
      }
    }
  }
  if (ids.size === 0) return null;
  // Skill order: the ability ids in the sequence points were invested. Each currency_changes
  // entry is one investment; we keep the ability id and preserve order. (Both currency types —
  // unlocks and upgrades — are kept; first-max is derived downstream and is robust to it.)
  const skillOrder = (hb.details?.ability_order?.currency_changes ?? [])
    .map((c) => c.ability_id)
    .filter((id): id is number => id !== undefined);
  return {
    id: hb.hero_build_id,
    name: hb.name ?? `Build ${hb.hero_build_id}`,
    authorId: hb.author_account_id ?? 0,
    version: hb.version ?? 0,
    updatedAt: hb.last_updated_timestamp ?? hb.publish_timestamp ?? 0,
    itemIds: [...ids],
    coreItemIds: [...coreIds],
    skillOrder,
    imbueTargets,
  };
}

export interface CounterMatrixQuery extends TimeWindow, RankWindow {
  minMatches?: number;
}

// hero-counter-stats ignores hero filters and returns the whole hero-vs-hero matrix,
// so we fetch it once per rank/patch and filter to the selected hero client-side.
export function getHeroCounters(
  q: CounterMatrixQuery,
): Promise<HeroCounterRow[]> {
  const params = new URLSearchParams({
    min_matches: String(q.minMatches ?? 100),
  });
  applyRank(params, q);
  applyWindow(params, q);
  return getAnalytics<HeroCounterRow[]>(
    `${BASE}/v1/analytics/hero-counter-stats?${params}`,
  );
}

let patchesPromise: Promise<Patch[]> | null = null;

// ---- Player profile (public data; the id is the Steam userdata/<id> account number) ----

/** The player's all-time record per hero — drives the "your heroes" quick-pick. Returns [] for an
 * account with no Deadlock games (or an unknown id). */
export function getPlayerHeroStats(
  accountId: number,
): Promise<PlayerHeroStat[]> {
  return getAnalytics<PlayerHeroStat[]>(
    `${BASE}/v1/players/${accountId}/hero-stats`,
  );
}

/** One match from the Steam-profile name search. Names are freely changeable and collide, so the
 * UI shows avatars and lets the player pick — the account id is what we keep. */
export interface SteamPlayerMatch {
  account_id: number;
  personaname: string;
  avatar?: string;
}

/** Search Steam profiles (with Deadlock presence) by display name — server-side, no Steam login.
 * Names collide freely; treat results as candidates to disambiguate, not an answer. */
export function searchSteamPlayers(query: string): Promise<SteamPlayerMatch[]> {
  const params = new URLSearchParams({ search_query: query });
  return getAnalytics<SteamPlayerMatch[]>(
    `${BASE}/v1/players/steam-search?${params}`,
  );
}

/** The player's current rank tier on the app's 0–11 rank-floor scale (11 = Eternus), from the batch
 * mmr endpoint's latest entry (`division` is already tier-scaled; `rank` is the full badge). Null
 * when the account has no ranked record yet (division 0 = Obscurus/unranked). */
export async function getPlayerRankTier(
  accountId: number,
): Promise<number | null> {
  const rows = await getAnalytics<Array<{ division?: number }>>(
    `${BASE}/v1/players/mmr?account_ids=${accountId}`,
  );
  const division = rows[0]?.division;
  return typeof division === "number" && division > 0
    ? Math.min(division, 11)
    : null;
}

/** Every hero's ladder record at a rank floor + window — the "meta strength" side of the
 * what-to-queue ranking on the your-heroes row. */
export function getHeroLadderStats(
  q: RankWindow & TimeWindow,
): Promise<HeroLadderStat[]> {
  const params = new URLSearchParams();
  applyRank(params, q);
  applyWindow(params, q);
  return getAnalytics<HeroLadderStat[]>(
    `${BASE}/v1/analytics/hero-stats?${params}`,
  );
}

export interface PlayerMetricsQuery extends TimeWindow {
  /** Filter to games on one hero. */
  heroId?: number;
  /** Rank slice for a ladder distribution (floor, or floor+ceiling for a band). */
  minBadge?: number;
  maxBadge?: number;
  /** Restrict to specific players — this is how "my typical game" is fetched. */
  accountIds?: number[];
}

/** Per-metric distributions (avg + percentile grid) of ~29 per-match player metrics, over whatever
 * slice the query describes: hero+rank ⇒ the ladder to benchmark against; account_ids ⇒ the
 * player's own history. One call either way — see lib/fundamentals. */
export function getPlayerMetrics(
  q: PlayerMetricsQuery,
): Promise<PlayerMetrics> {
  const params = new URLSearchParams();
  if (q.heroId !== undefined) params.set("hero_ids", String(q.heroId));
  if (q.minBadge !== undefined)
    params.set("min_average_badge", String(q.minBadge));
  if (q.maxBadge !== undefined)
    params.set("max_average_badge", String(q.maxBadge));
  if (q.accountIds?.length) params.set("account_ids", q.accountIds.join(","));
  applyWindow(params, q);
  return getAnalytics<PlayerMetrics>(
    `${BASE}/v1/analytics/player-stats/metrics?${params}`,
  );
}

// /v2/patches unifies the Forum + Steam feeds, so it has minor updates too. But the
// Forum entries carry a bogus re-published pub_date (e.g. a 05-22 patch stamped 06-12),
// so we key off the MM-DD-YYYY date in the *title*, which is reliable on every entry.
// We window by day boundaries (00:00 UTC of the title date) to match the site's "May 22
// – May 25"-style windows, and dedupe by day so the two feeds' copies collapse into one.
export function getPatches(): Promise<Patch[]> {
  if (patchesPromise) return patchesPromise;
  patchesPromise = (async () => {
    const cacheKey = "dl.patches.v2";
    const hit = cached<Patch[]>(cacheKey);
    if (hit) return hit;

    let raw: RawPatch[];
    try {
      raw = await getJson<RawPatch[]>(`${BASE}/v2/patches`);
    } catch {
      // The patch feed is the spine of every data window, so a (post-retry) failure must degrade,
      // not blank the app: serve the last good copy however stale; with nothing cached at all,
      // run patch-less — an empty list makes every window query fall back to the API's default
      // last-30-days and disables backfill until a reload succeeds.
      return cachedStale<Patch[]>(cacheKey) ?? [];
    }
    const byDay = new Map<string, Patch>();
    for (const p of raw) {
      const title = p.title ?? "";
      const m = title.match(/(\d{2})-(\d{2})-(\d{4})/); // MM-DD-YYYY
      if (!m) continue;
      const [, mm, dd, yyyy] = m;
      const dayKey = `${yyyy}-${mm}-${dd}`;
      if (byDay.has(dayKey)) continue; // one entry per patch day
      byDay.set(dayKey, {
        title: `${dayKey}${/minor/i.test(title) ? " · Minor" : ""} Update`,
        ts: Math.floor(Date.UTC(+yyyy, +mm - 1, +dd) / 1000),
      });
    }

    const patches = [...byDay.values()].sort((a, b) => b.ts - a.ts);
    putCache(cacheKey, patches);
    return patches;
  })();
  return patchesPromise;
}

// ---- Raw API shapes (only the fields we touch) ----

interface RawHero {
  id: number;
  name: string;
  image?: string;
  images?: { icon_hero_card?: string };
  description?: { role?: string };
  items?: Record<string, string>;
}

interface RawItem {
  id: number;
  name: string;
  type?: string;
  class_name?: string;
  item_tier?: number;
  item_slot_type?: string | null;
  cost?: number;
  shop_image?: string;
  image?: string;
  description?: { desc?: string } | string | null;
  is_active_item?: boolean;
  properties?: Record<string, RawProp>;
  tooltip_sections?: Array<{
    section_type?: string | null;
    section_attributes?: Array<{
      loc_string?: string;
      properties?: string[];
      elevated_properties?: string[];
      important_properties?: string[];
    }>;
  }>;
  component_items?: string[];
}

interface RawProp {
  value?: string | number;
  postfix?: string;
  label?: string;
  /** When `value` equals this, the stat is inactive for the item and not shown. */
  disable_value?: string;
}

interface RawPatch {
  title?: string;
  name?: string;
  pub_date?: string;
  timestamp?: number;
}

interface RawBuildEnvelope {
  hero_build?: {
    hero_build_id: number;
    name?: string;
    author_account_id?: number;
    version?: number;
    last_updated_timestamp?: number;
    publish_timestamp?: number;
    details?: {
      mod_categories?: Array<{
        name?: string | null;
        // Author flag marking a section as situational. Set on ~a third of sections; null
        // (the majority) means unmarked, which we treat as core. Only `true` demotes.
        optional?: boolean | null;
        mods?: Array<{
          ability_id?: number;
          imbue_target_ability_id?: number | null;
        }>;
      }>;
      // Ordered ability-point investments; we flatten it to the build's skill order.
      ability_order?: {
        currency_changes?: Array<{ ability_id?: number }>;
      };
    };
  };
}

// --- Single-match metadata (match analysis) ---
//
// A DIFFERENT rate family from everything above. The analytics endpoints allow 200 req/60s and
// send ratelimit headers; the match endpoints are far tighter and header-less — when a match isn't
// in the API's database, fetching it spends a Steam call from a budget of roughly THREE PER HOUR
// per IP, and a 429 gives no reset hint. So this client:
//   - never retries (a retry loop would silently drain an hour of budget),
//   - asks cached-first (`disable_steam=true` — free at any rate, fails fast if not ingested),
//   - gates the explicit Steam fallback behind a self-paced cooldown.
// Most matches ARE ingested: the API crawls continuously and uploader users submit their own
// matches' salts, so a played match typically appears within the hour without any Steam spend.

/** Thrown when the match isn't in the API's database and the Steam fallback wasn't allowed —
 * the caller can offer an explicit "fetch via Steam" retry. */
export class MatchNotIngestedError extends Error {
  constructor(matchId: number) {
    super(`match ${matchId} not ingested yet`);
    this.name = "MatchNotIngestedError";
  }
}

/** Minimum spacing between Steam-fallback attempts (~3/hour budget ⇒ one per 20 min). */
const STEAM_FETCH_COOLDOWN_MS = 20 * 60 * 1000;
let steamFetchLastAttempt = 0;

/** Epoch ms when the next Steam-fallback attempt is allowed; ≤ now means available. */
export function steamFetchAvailableAt(): number {
  return steamFetchLastAttempt + STEAM_FETCH_COOLDOWN_MS;
}

const matchCache = new Map<number, Promise<MatchInfo>>();

/**
 * One match's full metadata. Cached-first: with `allowSteam` unset this can't spend any scarce
 * budget — it 404s fast when the match isn't ingested (thrown as {@link MatchNotIngestedError}).
 * With `allowSteam` the server may fetch from Steam; the attempt is stamped against the cooldown
 * whether or not it succeeds, because the budget is spent server-side either way.
 */
export function getMatchMetadata(
  matchId: number,
  opts?: { allowSteam?: boolean },
): Promise<MatchInfo> {
  const hit = matchCache.get(matchId);
  if (hit) return hit;
  const allowSteam = opts?.allowSteam ?? false;
  if (allowSteam) steamFetchLastAttempt = Date.now();
  const url = `${BASE}/v1/matches/${matchId}/metadata${allowSteam ? "" : "?disable_steam=true"}`;
  const p = (async () => {
    const res = await fetch(url); // deliberately NOT getJson: no retries in this rate family
    if (res.status === 404 && !allowSteam)
      throw new MatchNotIngestedError(matchId);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    const body = (await res.json()) as { match_info: MatchInfo };
    return body.match_info;
  })();
  matchCache.set(matchId, p);
  p.catch(() => matchCache.delete(matchId)); // a failure shouldn't poison later attempts
  return p;
}

/**
 * The player's recent matches, newest first. Steam-sourced, so it can lag the ingested DB by
 * hours; `forceRefetch` asks the server to re-pull from Steam (propagates asynchronously — the
 * next call sees the update, not this one, and bypasses the cache).
 *
 * Session-cached per account: both the match modal and the build page's fundamentals card read it
 * (the latter to turn "my last N games on this hero" into a timestamp window), so it shouldn't cost
 * a round trip per consumer.
 */
const historyCache = new Map<number, Promise<MatchHistoryRow[]>>();

export function getPlayerMatchHistory(
  accountId: number,
  opts?: { forceRefetch?: boolean },
): Promise<MatchHistoryRow[]> {
  const force = opts?.forceRefetch ?? false;
  const hit = !force && historyCache.get(accountId);
  if (hit) return hit;
  const p = getJson<MatchHistoryRow[]>(
    `${BASE}/v1/players/${accountId}/match-history${force ? "?force_refetch=true" : ""}`,
  ).then((rows) => [...rows].sort((a, b) => b.start_time - a.start_time));
  historyCache.set(accountId, p);
  p.catch(() => historyCache.delete(accountId));
  return p;
}
