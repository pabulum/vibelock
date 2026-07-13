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
//     1: build_id  2: hero_id  3: author(account id)  4: last_updated(unix)  5: name  6: description
//     8: version   9: build_id  10: details  13: published(unix)
//   }
//   details { 1: repeated category  2: ability_order }
//   category { 1: repeated mod  2: name  3: description  4: width(f32)  5: height(f32)  6: optional(bool) }
//   mod { 1: item_id  2: annotation(string)  5: imbue_target_ability_id }
//   ability_order { 1: repeated currency_change{1: ability_id  2: currency_type  3: delta(int32)} }
//
// The field names/numbers match Valve's CMsgHeroBuild in citadel_gcmessages_common.proto
// (SteamDatabase/Protobufs) — category = BuildModCategory, mod = BuildModEntry.
//
// Verified in-game: the categories, their order, the item placement, and the `optional` flag all
// render correctly; populating the timestamps (4/13) is what stops the game tagging it "[OUTDATED]".
// Skill order (details.2 = ability_order) is included when a build carries one: each ability-point
// investment is one CurrencyChange, and its currency_type/delta follow Deadlock's fixed per-level
// cost (unlock, then 1/2/5 upgrade points) — reverse-engineered from real builds (see encodeAbilityOrder).

import type { BuildItem, GeneratedBuild, ImbueTarget } from "../types";
import { classifyWinState } from "./buildGenerator";

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

/** wire type 0 — a signed `int32` field. Protobuf sign-extends a negative int32 to 64 bits, so it
 * always encodes as a 10-byte varint (not zigzag — that's sint32). We need this only for the skill
 * order's `delta`, which is always negative (points spent). BigInt keeps the 64-bit two's complement
 * exact, where the float modulo/division in pushVarint would lose the low bits past 2^53. */
function int32Field(field: number, value: number): number[] {
  const out: number[] = [];
  pushTag(out, field, 0);
  let v = BigInt(Math.trunc(value)) & 0xffffffffffffffffn;
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
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

/** One item in an exported category, with its in-game extras: the annotation (the note icon on the
 * item — Vibelock's reasoning for the pick) and, for imbue items, the ability to imbue onto. */
export interface ExportMod {
  itemId: number;
  annotation?: string;
  imbueAbilityId?: number;
}

/** One in-game build category: a named group of items, an optional always-visible description, and
 * an optional flag marking it a flex/optional row (the game groups optional rows separately). */
interface ExportCategory {
  name: string;
  mods: ExportMod[];
  description?: string;
  optional?: boolean;
}

const fmtPts = (d: number) =>
  `${d >= 0 ? "+" : "-"}${Math.abs(d * 100).toFixed(1)}`;

/**
 * The in-game annotation for a pick: Vibelock's reasoning, compressed to one scannable line. The
 * shop already shows the item's own tooltip, so this carries only what the game can't tell you —
 * the pick's edge vs the hero average and the build clues (same language as the app's row tags:
 * win-state, core-by-later, swap-for, sell/builds-into notes, comp edge). Single line, most
 * important first — none of 3,299 real annotations sampled from /v1/builds contain a newline, so
 * we don't risk one.
 */
export function itemAnnotation(
  b: BuildItem,
  baseline: number,
  imbueOn?: string,
): string {
  const parts: string[] = [];
  parts.push(
    `${fmtPts(b.adjustedWinRate - baseline)} pts vs hero avg (adjusted, n=${b.decided.toLocaleString("en-US")})`,
  );
  if (b.role === "universal") parts.push("staple — most players buy this");
  else if (b.role === "value") parts.push("value pick");
  else if (b.role === "situational")
    parts.push("situational — when the game calls for it");
  else if (b.role === "filler")
    parts.push("fills the phase budget, not a value pick");
  if (b.why && b.why !== b.item.effect) parts.push(b.why); // custom rationale only — effect text is on the card
  const state = classifyWinState(b.rawWinRate, b.adjustedWinRate, baseline);
  if (state === "winmore")
    parts.push("win more — its win rate leans on already being ahead");
  else if (state === "comeback")
    parts.push("comeback — holds up even bought from behind");
  if (b.coreLater)
    parts.push(
      `core by ${b.coreLater} — ${b.coreRush ? "rush if ahead" : "buy later (worse bought early)"}`,
    );
  if (b.swapFor) parts.push(`swap for ${b.swapFor.name}`);
  if (b.transientReason) parts.push(b.transientReason);
  else if (b.buildsToward)
    parts.push(`most build toward ${b.buildsToward.name}`);
  else if (b.transientKind === "sold")
    parts.push("sell-fodder when slots fill up"); // cheap-early sticks carry no reason string
  if (b.weakVsComp && b.compEdge !== undefined)
    parts.push(`weak into the selected comp (${fmtPts(b.compEdge)} pts)`);
  else if (b.compEdge !== undefined && b.compEdge > 0)
    parts.push(`answers the selected comp (${fmtPts(b.compEdge)} pts)`);
  if (imbueOn) parts.push(`imbue → ${imbueOn} (community pick)`);
  return parts.join(" · ");
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
  /** Ability ids in the order points were invested (each up to 4×, e.g. `SkillBuild.order`). When
   * present, encoded as the build's in-game skill order so the shop also walks ability upgrades.
   * Omit/empty to leave the build without a skill order (still fully usable). */
  skillOrder?: number[];
  /** Per item id: the ability the community most often imbues that item onto. Encoded as the mod's
   * `imbue_target_ability_id` (so the in-game build applies the imbue) and noted in the annotation.
   * It's author popularity, not a win rate — same epistemic class as the app's imbue tag. */
  imbues?: Map<number, ImbueTarget>;
}

// Fields 4/5 are width/height in Valve's proto; the build *browser* lays categories out in list
// order, left-to-right and wrapping, and clean in-game-made builds give every category the *same*
// values (one observed default sits all categories at 1000,90). Distinct values made our first
// columns clip, so we give every category identical ones and let list order drive the layout —
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
  imbues?: Map<number, ImbueTarget>,
): ExportCategory[] {
  const baseline = build.population.baselineWinRate;
  const toMod = (b: BuildItem): ExportMod => {
    const imbue = imbues?.get(b.item.id);
    return {
      itemId: b.item.id,
      annotation: itemAnnotation(b, baseline, imbue?.ability.name),
      imbueAbilityId: imbue?.ability.id,
    };
  };

  // All of a build's core item ids, computed up front so a swap that's *core in a later phase*
  // isn't also listed as a swap (we still want each item to appear exactly once).
  const coreSeen = new Set<number>();
  const coreByPhase = build.phases.map((phase) => {
    const mods: ExportMod[] = [];
    for (const b of phase.core) {
      if (coreSeen.has(b.item.id)) continue;
      coreSeen.add(b.item.id);
      mods.push(toMod(b));
    }
    return mods;
  });

  // Interleave: each phase's core, immediately followed by that phase's optional swaps — so the
  // in-game browser (which renders categories in list order) reads phase-by-phase.
  const cats: ExportCategory[] = [];
  const situSeen = new Set<number>();
  build.phases.forEach((phase, i) => {
    if (coreByPhase[i].length)
      cats.push({
        name: phase.label,
        description: phase.timeLabel,
        mods: coreByPhase[i],
      });
    const swaps: ExportMod[] = [];
    for (const b of phase.situational) {
      if (coreSeen.has(b.item.id) || situSeen.has(b.item.id)) continue;
      situSeen.add(b.item.id);
      swaps.push(toMod(b));
    }
    if (swaps.length)
      cats.push({
        name: `${phase.label} · swaps`,
        description: `Optional alternatives for ${phase.label.toLowerCase()}`,
        mods: swaps,
        optional: true,
      });
  });

  if (includeOvertime) {
    const ot: ExportMod[] = [];
    const seen = new Set<number>([...coreSeen, ...situSeen]);
    for (const b of build.overtimeBuys) {
      if (seen.has(b.item.id)) continue;
      seen.add(b.item.id);
      ot.push(toMod(b));
    }
    // Name the slots to free right in the category note — in overtime slots, not souls, are the
    // constraint, so "what do I sell?" is half the instruction. Capped so the note stays short.
    const sellNames = build.overtimeSell.slice(0, 3).map((b) => b.item.name);
    if (ot.length)
      cats.push({
        name: "Overtime",
        description: sellNames.length
          ? `Defaults first, then situational — sell ${sellNames.join(" / ")} to make room`
          : "Defaults first, then situational — replace your lowest-tier slots",
        mods: ot,
        optional: true,
      });
  }

  return cats;
}

/** mod (BuildModEntry) { 1: item_id  2: annotation  5: imbue_target_ability_id } */
function encodeMod(mod: ExportMod): number[] {
  let body = varintField(1, mod.itemId);
  if (mod.annotation) body = body.concat(stringField(2, mod.annotation));
  if (mod.imbueAbilityId)
    body = body.concat(varintField(5, mod.imbueAbilityId));
  return body;
}

function encodeCategory(cat: ExportCategory): number[] {
  let body: number[] = [];
  for (const mod of cat.mods) body = body.concat(lenField(1, encodeMod(mod)));
  body = body.concat(stringField(2, cat.name));
  if (cat.description) body = body.concat(stringField(3, cat.description)); // always-visible category note
  body = body.concat(floatField(4, UI_X)); // identical coords for every category…
  body = body.concat(floatField(5, UI_Y)); // …so the browser lays them out by list order
  if (cat.optional) body = body.concat(varintField(6, 1));
  return body;
}

// The (currency_type, delta) for the Nth point invested in a single ability. Deadlock charges one
// "unlock" point (currency_type 2) to put the first point in an ability, then upgrade points
// (currency_type 1) costing 1, 2, then 5 for its remaining three levels. This table is identical
// across every real build inspected, so we can rebuild a valid ability_order from just the ordered
// list of ability ids that ability-order-stats gives us (it carries no per-point cost itself).
const POINT_COST: ReadonlyArray<{ type: number; delta: number }> = [
  { type: 2, delta: -1 }, // 1st point — unlock
  { type: 1, delta: -1 }, // 2nd point
  { type: 1, delta: -2 }, // 3rd point
  { type: 1, delta: -5 }, // 4th point
];

/** Encode the `ability_order` sub-message body from a flat sequence of ability ids in the order
 * points were invested (each ability appears up to 4×, e.g. `SkillBuild.order`). Each investment
 * becomes a CurrencyChange { 1: ability_id, 2: currency_type, 3: delta }; investments past an
 * ability's fourth point are dropped (an ability has only four levels). */
function encodeAbilityOrder(order: number[]): number[] {
  const points = new Map<number, number>();
  let changes: number[] = [];
  for (const id of order) {
    const n = points.get(id) ?? 0;
    if (n >= POINT_COST.length) continue; // can't level an ability past 4 — ignore stray extras
    points.set(id, n + 1);
    const { type, delta } = POINT_COST[n];
    const cc = varintField(1, id).concat(
      varintField(2, type),
      int32Field(3, delta),
    );
    changes = changes.concat(lenField(1, cc)); // currency_changes — repeated field 1
  }
  return changes;
}

/**
 * Encode a generated build as the envelope blob to drop into a `cached_hero_builds.kv3` build bucket
 * (e.g. `Favorites`). Returns the raw protobuf bytes; the KV3 read/inject/write around it is the
 * backend's job (the game accepts a text-format KV3, so no binary writer is needed).
 */
export function encodeHeroBuild(
  build: GeneratedBuild,
  opts: HeroBuildExportOptions,
): Uint8Array {
  const ts = Math.floor(opts.timestamp ?? Date.now() / 1000);
  const buildId = opts.buildId ?? ts;
  const cats = buildExportCategories(
    build,
    opts.includeOvertime !== false,
    opts.imbues,
  );

  let details: number[] = [];
  for (const cat of cats) {
    details = details.concat(lenField(1, encodeCategory(cat))); // details { 1: repeated category }
  }
  if (opts.skillOrder?.length) {
    details = details.concat(lenField(2, encodeAbilityOrder(opts.skillOrder))); // details { 2: ability_order }
  }

  let hb: number[] = [];
  hb = hb.concat(varintField(1, buildId));
  hb = hb.concat(varintField(2, build.hero.id));
  if (opts.authorId) hb = hb.concat(varintField(3, opts.authorId)); // owner — lets them edit/delete in-game
  hb = hb.concat(varintField(4, ts)); // last_updated — kills "[OUTDATED]"
  hb = hb.concat(stringField(5, opts.name));
  hb = hb.concat(stringField(6, opts.description ?? ""));
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
