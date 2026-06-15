// Thin client for api.deadlock-api.com. The API sends `access-control-allow-origin: *`,
// so we call it straight from the browser — no backend, no API key.

import type {
  Ability,
  AbilityOrderRow,
  Hero,
  HeroCounterRow,
  Item,
  ItemFlowStats,
  ItemStat,
  Patch,
  SlotType,
} from '../types';

const BASE = 'https://api.deadlock-api.com';

// Assets (heroes/items) change rarely; cache them in module scope + localStorage.
const ASSET_TTL_MS = 24 * 60 * 60 * 1000;

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  return res.json() as Promise<T>;
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
    const cacheKey = 'dl.heroes.v2';
    const hit = cached<Hero[]>(cacheKey);
    if (hit) return hit;
    const raw = await getJson<RawHero[]>(`${BASE}/v1/assets/heroes?only_active=true`);
    const heroes = raw
      .filter((h) => h.name)
      .map<Hero>((h) => ({
        id: h.id,
        name: h.name,
        image: h.images?.icon_hero_card ?? h.image,
        signatureClasses: [1, 2, 3, 4]
          .map((n) => h.items?.[`signature${n}`])
          .filter((c): c is string => typeof c === 'string'),
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
  if (!rawItemsPromise) rawItemsPromise = getJson<RawItem[]>(`${BASE}/v1/assets/items`);
  return rawItemsPromise;
}

let itemsPromise: Promise<Map<number, Item>> | null = null;

export function getItems(): Promise<Map<number, Item>> {
  if (itemsPromise) return itemsPromise;
  itemsPromise = (async () => {
    const cacheKey = 'dl.items.v3';
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
    const cacheKey = 'dl.abilities.v2';
    const hit = cached<Ability[]>(cacheKey);
    const list =
      hit ??
      (await getRawItems())
        .filter((i) => i.type === 'ability' && i.name)
        .map<Ability>((i) => ({
          id: i.id,
          name: i.name,
          className: i.class_name ?? '',
          image: i.image ?? i.shop_image,
        }));
    if (!hit) putCache(cacheKey, list);
    return new Map(list.map((a) => [a.id, a]));
  })();
  return abilitiesPromise;
}

export interface AbilityOrderQuery extends TimeWindow {
  heroId: number;
  minBadge: number;
  minMatches?: number;
  /** Restrict to players who bought these items (used to match the build archetype). */
  includeItemIds?: number[];
  signal?: AbortSignal;
}

export function getAbilityOrder(q: AbilityOrderQuery): Promise<AbilityOrderRow[]> {
  const params = new URLSearchParams({
    hero_id: String(q.heroId),
    min_average_badge: String(q.minBadge),
    min_matches: String(q.minMatches ?? 100),
  });
  if (q.includeItemIds?.length) params.set('include_item_ids', q.includeItemIds.join(','));
  applyWindow(params, q);
  return getJson<AbilityOrderRow[]>(`${BASE}/v1/analytics/ability-order-stats?${params}`, q.signal);
}

function normalizeSlot(s: string | null | undefined): SlotType {
  if (s === 'weapon' || s === 'vitality' || s === 'spirit') return s;
  return 'unknown';
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
    }));
}

// Human labels for the headline stats of items that lack a prose description.
const STAT_LABELS: Record<string, string> = {
  TechPower: 'Spirit Power',
  TechResist: 'Spirit Resist',
  TechLifestealPercent: 'Spirit Lifesteal',
  AbilityLifestealPercentHero: 'Spirit Lifesteal',
  BulletResist: 'Bullet Resist',
  BulletLifestealPercent: 'Bullet Lifesteal',
  BaseAttackDamagePercent: 'Weapon Damage',
  BonusFireRate: 'Fire Rate',
  BonusClipSizePercent: 'Ammo',
  BonusBulletSpeedPercent: 'Bullet Velocity',
  BonusAttackRangePercent: 'Attack Range',
  BonusZoomPercent: 'Zoom',
  BonusHealth: 'Health',
  BonusBaseHealth: 'Health',
  BonusHealthRegen: 'Health Regen',
  BonusMoveSpeed: 'Move Speed',
  BonusSprintSpeed: 'Sprint Speed',
  BonusAbilityCharges: 'Ability Charges',
  BonusAbilityDurationPercent: 'Ability Duration',
  BonusMeleeDamagePercent: 'Melee Damage',
};

/** A short "what it does" line: prose description if present, else the headline stat. */
function extractEffect(i: RawItem): string | undefined {
  const desc = typeof i.description === 'object' ? i.description?.desc : i.description;
  const cleaned = cleanText(desc);
  if (cleaned) return i.is_active_item ? `Active: ${cleaned}` : cleaned;

  const stat = i.tooltip_sections?.[0]?.section_attributes?.[0]?.elevated_properties?.[0];
  const label = stat ? STAT_LABELS[stat] : undefined;
  return label ? `+${label}` : undefined;
}

function cleanText(s: string | undefined | null): string | undefined {
  if (!s) return undefined;
  const t = s
    .replace(/<[^>]*>/g, ' ') // strip markup
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;)])/g, '$1') // tidy spaces left before punctuation
    .replace(/\(\s+/g, '(')
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
  if (w?.minUnixTimestamp) params.set('min_unix_timestamp', String(w.minUnixTimestamp));
  if (w?.maxUnixTimestamp) params.set('max_unix_timestamp', String(w.maxUnixTimestamp));
}

export interface FlowQuery extends TimeWindow {
  heroId: number;
  /** Rank floor as an average_badge value (tier * 10). */
  minBadge: number;
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
  signal?: AbortSignal;
}

export function getItemFlowStats(q: FlowQuery): Promise<ItemFlowStats> {
  const params = new URLSearchParams({
    hero_ids: String(q.heroId),
    min_average_badge: String(q.minBadge),
    min_matches: String(q.minMatches ?? 100),
  });
  if (q.lockedItemIds?.length && q.lockedColumns?.length) {
    params.set('locked_item_ids', q.lockedItemIds.join(','));
    params.set('locked_columns', q.lockedColumns.join(','));
  }
  if (q.includeItemIds?.length) params.set('include_item_ids', q.includeItemIds.join(','));
  applyWindow(params, q);
  return getJson<ItemFlowStats>(`${BASE}/v1/analytics/item-flow-stats?${params}`, q.signal);
}

export interface ItemStatsQuery extends TimeWindow {
  heroId: number;
  minBadge: number;
  /** Filter to matches where any of these heroes were on the enemy team. */
  enemyHeroIds?: number[];
  minMatches?: number;
  signal?: AbortSignal;
}

export function getItemStats(q: ItemStatsQuery): Promise<ItemStat[]> {
  const params = new URLSearchParams({
    hero_id: String(q.heroId),
    min_average_badge: String(q.minBadge),
    min_matches: String(q.minMatches ?? 20),
  });
  if (q.enemyHeroIds?.length) params.set('enemy_hero_ids', q.enemyHeroIds.join(','));
  applyWindow(params, q);
  return getJson<ItemStat[]>(`${BASE}/v1/analytics/item-stats?${params}`, q.signal);
}

export interface CounterMatrixQuery extends TimeWindow {
  minBadge: number;
  minMatches?: number;
  signal?: AbortSignal;
}

// hero-counter-stats ignores hero filters and returns the whole hero-vs-hero matrix,
// so we fetch it once per rank/patch and filter to the selected hero client-side.
export function getHeroCounters(q: CounterMatrixQuery): Promise<HeroCounterRow[]> {
  const params = new URLSearchParams({
    min_average_badge: String(q.minBadge),
    min_matches: String(q.minMatches ?? 100),
  });
  applyWindow(params, q);
  return getJson<HeroCounterRow[]>(`${BASE}/v1/analytics/hero-counter-stats?${params}`, q.signal);
}

let patchesPromise: Promise<Patch[]> | null = null;

// /v2/patches unifies the Forum + Steam feeds, so it has minor updates too. But the
// Forum entries carry a bogus re-published pub_date (e.g. a 05-22 patch stamped 06-12),
// so we key off the MM-DD-YYYY date in the *title*, which is reliable on every entry.
// We window by day boundaries (00:00 UTC of the title date) to match the site's "May 22
// – May 25"-style windows, and dedupe by day so the two feeds' copies collapse into one.
export function getPatches(): Promise<Patch[]> {
  if (patchesPromise) return patchesPromise;
  patchesPromise = (async () => {
    const cacheKey = 'dl.patches.v2';
    const hit = cached<Patch[]>(cacheKey);
    if (hit) return hit;

    const raw = await getJson<RawPatch[]>(`${BASE}/v2/patches`);
    const byDay = new Map<string, Patch>();
    for (const p of raw) {
      const title = p.title ?? '';
      const m = title.match(/(\d{2})-(\d{2})-(\d{4})/); // MM-DD-YYYY
      if (!m) continue;
      const [, mm, dd, yyyy] = m;
      const dayKey = `${yyyy}-${mm}-${dd}`;
      if (byDay.has(dayKey)) continue; // one entry per patch day
      byDay.set(dayKey, {
        title: `${dayKey}${/minor/i.test(title) ? ' · Minor' : ''} Update`,
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
  tooltip_sections?: Array<{
    section_attributes?: Array<{ elevated_properties?: string[] }>;
  }>;
  component_items?: string[];
}

interface RawPatch {
  title?: string;
  name?: string;
  pub_date?: string;
  timestamp?: number;
}
