// The Ctrl+K command palette's command model: one flat list of everything the header controls
// do — switch hero, set the rank floor/band, pick a patch window, add/remove counter enemies,
// open a panel, jump to a build row — assembled here as plain data so the palette component
// stays a dumb input+list and the assembly is unit-testable without a DOM.
//
// Labels carry their own namespace ("vs Haze", "remove Haze", "Rank: Oracle+", "Patch: …",
// "why isn't Echo Shard here") so a single query field routes everywhere through lib/fuzzy's
// band ordering: "haze" puts the hero switch first (whole-name prefix) with "vs Haze" right
// under it (word prefix), "vs ha" pinpoints the enemy add, and "rank" / "patch" / "remove" /
// "why" list whole groups. A bare item name finds its build row when it's in the build and its
// "why isn't … here" verdict when it isn't (the item's name is a word of that label).

import { rankByFuzzy } from "./fuzzy";
import {
  RANK_TIERS,
  rankFloorLabel,
  rankSelLabel,
  type RankSel,
} from "./ranks";
import type { Hero, Patch } from "../types";

/** Apple keyboards: affordances should read ⌘K (the listeners accept Ctrl or ⌘ anywhere). */
export const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** A header panel the palette can open. */
export type PalettePanel = "share" | "export" | "lab" | "match" | "guide";

/** A boolean generation control the palette can flip. */
export type PaletteToggle = "backfill" | "lineAware";

/** What committing a command does — pure data; the app maps it onto its handlers in the
 * commit event, so command assembly stays render-safe (no closures over refs/setters). */
export type PaletteAction =
  | { kind: "hero"; id: number }
  | { kind: "rank"; sel: RankSel }
  | { kind: "patch"; idx: number }
  | { kind: "enemy"; id: number }
  /** Flip the open palette into another mode in place (the "vs — add enemies…" command). */
  | { kind: "mode"; mode: PaletteMode }
  /** Scroll to and flash this item's row in the build. */
  | { kind: "jump"; id: number }
  /** Open the verdict card: why the generator left this item out of the build. */
  | { kind: "why"; id: number }
  | { kind: "panel"; panel: PalettePanel }
  | { kind: "toggle"; toggle: PaletteToggle };

export interface PaletteCommand {
  /** Stable key, e.g. "hero:12", "vs:12", "rank:8", "patch:0". */
  id: string;
  /** The text queries match against — carries its namespace (see header comment). */
  label: string;
  /** Right-aligned annotation: what committing does. */
  hint: string;
  /** Section header in the browse (empty-query) view. */
  group: string;
  /** Hero portrait, when the command is about a hero. */
  image?: string;
  /** Marks the current selection (hero/rank/patch), a current enemy, or an on toggle. */
  active?: boolean;
  /** Commit without closing the palette — enemy toggles chain: "haz⏎ vind⏎ …". */
  keepOpen?: boolean;
  /** Only reachable by typing — hidden from the browse (empty-query) view. Keeps the
   * whole-catalog "why isn't X here" set from flooding the browse list. */
  searchOnly?: boolean;
  action: PaletteAction;
}

/** The slice of an Item the palette needs (icon + searchable name). */
export interface PaletteItem {
  id: number;
  name: string;
  image?: string;
}

/** The selection the commands are built against (all read-only here). */
export interface PaletteState {
  heroes: Hero[];
  heroId: number | null;
  enemies: number[];
  patches: Patch[];
  patchIdx: number;
  rankSel: RankSel;
  /** The profile/link band for "around my rank"; null hides it (mirrors the Rank select). */
  bandChoice: { lo: number; hi: number } | null;
  /** Items the shown build lists anywhere (core/situational/overtime) — the jump targets. */
  buildItems: PaletteItem[];
  /** The rest of the shop catalog — each becomes a search-only "why isn't X here" command. */
  otherItems: PaletteItem[];
  /** Whether a build is baked — Share/Export (and the why-not verdicts) need one. */
  hasBuild: boolean;
  backfillOn: boolean;
  lineAwareOn: boolean;
}

/** What the palette is scoped to: everything (Ctrl+K), or just enemy toggles (the counter
 * picker's "+ add enemies…" browse-and-search, where hero names need no "vs" prefix). */
export type PaletteMode = "all" | "enemies";

export function buildPaletteCommands(
  mode: PaletteMode,
  state: PaletteState,
): PaletteCommand[] {
  const {
    heroes,
    heroId,
    enemies,
    patches,
    patchIdx,
    rankSel,
    bandChoice,
    buildItems,
    otherItems,
    hasBuild,
    backfillOn,
    lineAwareOn,
  } = state;
  const isEnemy = (id: number) => enemies.includes(id);

  if (mode === "enemies") {
    // Current enemies first (the comp you've entered, ready to un-pick), then the rest.
    return [...heroes]
      .sort((a, b) => Number(isEnemy(b.id)) - Number(isEnemy(a.id)))
      .map((h) => ({
        id: `enemy:${h.id}`,
        label: h.name,
        hint: isEnemy(h.id) ? "remove enemy" : "add enemy",
        group: "Enemies",
        image: h.image,
        active: isEnemy(h.id),
        keepOpen: true,
        action: { kind: "enemy", id: h.id },
      }));
  }

  const cmds: PaletteCommand[] = [];
  for (const h of heroes) {
    cmds.push({
      id: `hero:${h.id}`,
      label: h.name,
      hint: "switch hero",
      group: "Hero",
      image: h.image,
      active: h.id === heroId,
      action: { kind: "hero", id: h.id },
    });
  }
  // In-place mode switch: flips the open palette into enemies mode for chained bare-name adds
  // (the counter picker's flow, without closing and reopening). The label carries every word a
  // player might reach for — "vs", "enemies", "counters" — so all three route here.
  cmds.push({
    id: "mode:enemies",
    label: "vs — add enemies (counters)…",
    hint: "enemy picker",
    group: "Counters",
    keepOpen: true,
    action: { kind: "mode", mode: "enemies" },
  });
  // Removals before adds: there are at most a handful, and they're the ones already in play.
  for (const h of heroes) {
    if (!isEnemy(h.id)) continue;
    cmds.push({
      id: `rm:${h.id}`,
      label: `remove ${h.name}`,
      hint: "remove enemy",
      group: "Counters",
      image: h.image,
      active: true,
      keepOpen: true,
      action: { kind: "enemy", id: h.id },
    });
  }
  for (const h of heroes) {
    if (isEnemy(h.id)) continue;
    cmds.push({
      id: `vs:${h.id}`,
      label: `vs ${h.name}`,
      hint: "add enemy",
      group: "Counters",
      image: h.image,
      keepOpen: true,
      action: { kind: "enemy", id: h.id },
    });
  }
  // Items: what's in the shown build jumps to its row; everything else in the shop is a
  // search-only "why isn't X here" verdict. A bare item name matches both forms — the in-build
  // row by whole-name prefix, the why-not by word prefix — so in-build always ranks first.
  for (const it of buildItems) {
    cmds.push({
      id: `item:${it.id}`,
      label: it.name,
      hint: "jump to build row",
      group: "Items",
      image: it.image,
      action: { kind: "jump", id: it.id },
    });
  }
  if (hasBuild) {
    for (const it of otherItems) {
      cmds.push({
        id: `why:${it.id}`,
        label: `why isn't ${it.name} here`,
        hint: "generator's verdict",
        group: "Items",
        image: it.image,
        searchOnly: true,
        action: { kind: "why", id: it.id },
      });
    }
  }
  // Actions: the header's panels and generation toggles, palette-reachable.
  if (hasBuild) {
    cmds.push({
      id: "panel:share",
      label: "Share — summary card & link",
      hint: "open",
      group: "Actions",
      action: { kind: "panel", panel: "share" },
    });
    cmds.push({
      id: "panel:export",
      label: "Export to in-game build",
      hint: "open",
      group: "Actions",
      action: { kind: "panel", panel: "export" },
    });
  }
  cmds.push({
    id: "panel:lab",
    label: "Lab — experimental stats",
    hint: "open",
    group: "Actions",
    action: { kind: "panel", panel: "lab" },
  });
  cmds.push({
    id: "panel:match",
    label: "Match analysis",
    hint: "open",
    group: "Actions",
    action: { kind: "panel", panel: "match" },
  });
  cmds.push({
    id: "panel:guide",
    label: "Guide — how it works",
    hint: "open",
    group: "Actions",
    action: { kind: "panel", panel: "guide" },
  });
  // Toggles chain like enemy picks (keepOpen) so the ✓ flips in place as feedback.
  cmds.push({
    id: "toggle:backfill",
    label: "Backfill young patch with pre-patch data",
    hint: backfillOn ? "turn off" : "turn on",
    group: "Actions",
    active: backfillOn,
    keepOpen: true,
    action: { kind: "toggle", toggle: "backfill" },
  });
  cmds.push({
    id: "toggle:lineAware",
    label: "Line-aware generation (experimental)",
    hint: lineAwareOn ? "turn off" : "turn on",
    group: "Actions",
    active: lineAwareOn,
    keepOpen: true,
    action: { kind: "toggle", toggle: "lineAware" },
  });
  // Rank: the band option first when available, then floors high→low — the select's order.
  if (bandChoice) {
    cmds.push({
      id: "rank:band",
      label: `Rank: around my rank (${rankSelLabel(bandChoice)})`,
      hint: "set rank",
      group: "Rank",
      active: typeof rankSel === "object",
      action: { kind: "rank", sel: bandChoice },
    });
  }
  for (const t of [...RANK_TIERS].reverse()) {
    cmds.push({
      id: `rank:${t.tier}`,
      label: `Rank: ${rankFloorLabel(t.tier)}`,
      hint: "set rank",
      group: "Rank",
      active: rankSel === t.tier,
      action: { kind: "rank", sel: t.tier },
    });
  }
  patches.forEach((p, i) => {
    cmds.push({
      id: `patch:${i}`,
      label: `Patch: ${p.title}${i === 0 ? " (latest)" : ""}`,
      hint: "set patch",
      group: "Patch",
      active: i === patchIdx,
      action: { kind: "patch", idx: i },
    });
  });
  return cmds;
}

/** Commands matching `query`, best first (lib/fuzzy on the label); the assembly order —
 * the browse view, minus search-only commands — when the query is empty. */
export function searchPalette(
  commands: PaletteCommand[],
  query: string,
): PaletteCommand[] {
  if (!query.trim()) return commands.filter((c) => !c.searchOnly);
  return rankByFuzzy(query, commands, (c) => c.label);
}
