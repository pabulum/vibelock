// Serializes a generated build into Deadlock's in-game build format, so it can be injected into a
// player's `cached_hero_builds.kv3` and shows up in-game (the shop then walks them through it
// top-to-bottom — the whole point of an opinionated build).
//
// Each entry in that file's build buckets is a serialized `CMsgHeroBuild` protobuf wrapped in a small
// envelope. The schema below was reverse-engineered from a real cache file and cross-checked against
// deadlock-api's decoded `/v1/builds` shape and the live game:
//
//   envelope { 1: hero_build, 2: {1:1}, 3: 0, 8: 0 }
//   hero_build {
//     1: build_id  2: hero_id  4: last_updated(unix)  5: name  6: description
//     8: version   9: build_id  10: details  13: published(unix)
//   }
//   details { 1: repeated category }
//   category { 1: repeated mod{1: item_id}  2: name  4: ui_x(f32)  5: ui_y(f32)  6: optional(bool) }
//
// Verified in-game: the categories, their order, the item placement, and the `optional` flag all
// render correctly; populating the timestamps (4/13) is what stops the game tagging it "[OUTDATED]".
// Skill order (details.2 = ability_order) is intentionally omitted for now — its per-point encoding
// isn't fully pinned down, and the build is fully usable without it.

import type { GeneratedBuild } from '../types';

// ---- Minimal protobuf wire writer (only the pieces this message needs) ----

/** Append an unsigned LEB128 varint. Uses modulo/division (not bitwise) so item ids and unix
 * timestamps near/over 2^31 encode correctly — JS bitwise ops are 32-bit signed. */
function pushVarint(out: number[], value: number): void {
  let v = Math.floor(value);
  while (v >= 0x80) {
    out.push((v % 0x80) + 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
}

function pushTag(out: number[], field: number, wireType: number): void {
  pushVarint(out, field * 8 + wireType);
}

/** wire type 0 — a varint field (ids, timestamps, bools, enums). */
function varintField(field: number, value: number): number[] {
  const out: number[] = [];
  pushTag(out, field, 0);
  pushVarint(out, value);
  return out;
}

/** wire type 2 — a length-delimited field (strings, sub-messages, packed bytes). */
function lenField(field: number, bytes: number[]): number[] {
  const out: number[] = [];
  pushTag(out, field, 2);
  pushVarint(out, bytes.length);
  return out.concat(bytes);
}

function stringField(field: number, text: string): number[] {
  return lenField(field, [...new TextEncoder().encode(text)]);
}

/** wire type 5 — a 32-bit little-endian float (the category UI coordinates). */
function floatField(field: number, value: number): number[] {
  const out: number[] = [];
  pushTag(out, field, 5);
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setFloat32(0, value, true);
  out.push(...buf);
  return out;
}

// ---- Build → CMsgHeroBuild ----

/** One in-game build category: a named group of items, an optional always-visible description, and
 * an optional flag marking it a flex/optional row (the game groups optional rows separately). */
interface ExportCategory {
  name: string;
  itemIds: number[];
  description?: string;
  optional?: boolean;
}

export interface HeroBuildExportOptions {
  /** Display name in the in-game build browser (e.g. "Vibelock — Kelvin (Eternus)"). */
  name: string;
  /** Build description / methodology note. */
  description?: string;
  /** Author Steam account id (the 32-bit id, e.g. the number in the Steam `userdata/<id>` path).
   * Stamped as the build's author so the logged-in owner can edit/delete it in-game; 0/undefined
   * leaves it unattributed (and thus only removable by editing the file). */
  authorId?: number;
  /** Unix seconds; defaults to now. Populates last_updated/published so the game doesn't mark it
   * "[OUTDATED]". */
  timestamp?: number;
  /** Local build id (the game shows it; varies per export to avoid collisions). Defaults to the
   * timestamp, which is unique-enough per export and fits a uint32. */
  buildId?: number;
  /** Fold `build.overtimeBuys` into a trailing optional "Overtime" category. Default true. */
  includeOvertime?: boolean;
}

// Categories carry only an (x, y) and no size; the build *browser* lays them out in list order,
// left-to-right and wrapping, and clean in-game-made builds put every category at the *same* point
// (e.g. one observed default sits all categories at 1000,90). Distinct coordinates made our first
// columns clip, so we give every category identical coords and let list order drive the layout —
// which is why the list is ordered phase-core → that phase's swaps (see buildExportCategories).
const UI_X = 1000;
const UI_Y = 90;

/** The categories we surface, mirroring Vibelock's own top-to-bottom layout: one core category per
 * phase (the opinionated spine), then a *per-phase* optional "swaps" category (the game pools all
 * optional rows together, so splitting by phase keeps them labelled rather than dumped in one bin),
 * then an optional "Overtime" row. Each category gets an always-visible description. An item is
 * listed once — situational/overtime picks already in a core category (or an earlier swaps row) are
 * dropped. */
export function buildExportCategories(
  build: GeneratedBuild,
  includeOvertime = true,
): ExportCategory[] {
  // All of a build's core item ids, computed up front so a swap that's *core in a later phase*
  // isn't also listed as a swap (we still want each item to appear exactly once).
  const coreSeen = new Set<number>();
  const coreByPhase = build.phases.map((phase) => {
    const ids: number[] = [];
    for (const b of phase.core) {
      if (coreSeen.has(b.item.id)) continue;
      coreSeen.add(b.item.id);
      ids.push(b.item.id);
    }
    return ids;
  });

  // Interleave: each phase's core, immediately followed by that phase's optional swaps — so the
  // in-game browser (which renders categories in list order) reads phase-by-phase.
  const cats: ExportCategory[] = [];
  const situSeen = new Set<number>();
  build.phases.forEach((phase, i) => {
    if (coreByPhase[i].length)
      cats.push({ name: phase.label, description: phase.timeLabel, itemIds: coreByPhase[i] });
    const swapIds: number[] = [];
    for (const b of phase.situational) {
      if (coreSeen.has(b.item.id) || situSeen.has(b.item.id)) continue;
      situSeen.add(b.item.id);
      swapIds.push(b.item.id);
    }
    if (swapIds.length)
      cats.push({
        name: `${phase.label} · swaps`,
        description: `Optional alternatives for ${phase.label.toLowerCase()}`,
        itemIds: swapIds,
        optional: true,
      });
  });

  if (includeOvertime) {
    const ot: number[] = [];
    const seen = new Set<number>([...coreSeen, ...situSeen]);
    for (const b of build.overtimeBuys) {
      if (seen.has(b.item.id)) continue;
      seen.add(b.item.id);
      ot.push(b.item.id);
    }
    if (ot.length)
      cats.push({
        name: 'Overtime',
        description: 'Spend surplus souls late — replace your lowest-tier slots',
        itemIds: ot,
        optional: true,
      });
  }

  return cats;
}

function encodeCategory(cat: ExportCategory): number[] {
  let body: number[] = [];
  for (const id of cat.itemIds) body = body.concat(lenField(1, varintField(1, id))); // mod { 1: item_id }
  body = body.concat(stringField(2, cat.name));
  if (cat.description) body = body.concat(stringField(3, cat.description)); // always-visible category note
  body = body.concat(floatField(4, UI_X)); // identical coords for every category…
  body = body.concat(floatField(5, UI_Y)); // …so the browser lays them out by list order
  if (cat.optional) body = body.concat(varintField(6, 1));
  return body;
}

/**
 * Encode a generated build as the envelope blob to drop into a `cached_hero_builds.kv3` build bucket
 * (e.g. `Favorites`). Returns the raw protobuf bytes; the KV3 read/inject/write around it is the
 * backend's job (the game accepts a text-format KV3, so no binary writer is needed).
 */
export function encodeHeroBuild(build: GeneratedBuild, opts: HeroBuildExportOptions): Uint8Array {
  const ts = Math.floor(opts.timestamp ?? Date.now() / 1000);
  const buildId = opts.buildId ?? ts;
  const cats = buildExportCategories(build, opts.includeOvertime !== false);

  let details: number[] = [];
  for (const cat of cats) {
    details = details.concat(lenField(1, encodeCategory(cat))); // details { 1: repeated category }
  }

  let hb: number[] = [];
  hb = hb.concat(varintField(1, buildId));
  hb = hb.concat(varintField(2, build.hero.id));
  if (opts.authorId) hb = hb.concat(varintField(3, opts.authorId)); // owner — lets them edit/delete in-game
  hb = hb.concat(varintField(4, ts)); // last_updated — kills "[OUTDATED]"
  hb = hb.concat(stringField(5, opts.name));
  hb = hb.concat(stringField(6, opts.description ?? ''));
  hb = hb.concat(varintField(8, 1)); // version
  hb = hb.concat(varintField(9, buildId));
  hb = hb.concat(lenField(10, details));
  hb = hb.concat(varintField(13, ts)); // published

  // Envelope: { 1: hero_build, 2: {1:1}, 3: 0, 8: 0 } — the list-entry wrapper the cache uses.
  let env: number[] = [];
  env = env.concat(lenField(1, hb));
  env = env.concat(lenField(2, varintField(1, 1)));
  env = env.concat(varintField(3, 0));
  env = env.concat(varintField(8, 0));

  return new Uint8Array(env);
}
