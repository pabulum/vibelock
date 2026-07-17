// The Ctrl+K command palette's command model: one flat list of everything the header controls
// do — switch hero, set the rank floor/band, pick a patch window, add/remove counter enemies —
// assembled here as plain data so the palette component stays a dumb input+list and the
// assembly is unit-testable without a DOM.
//
// Labels carry their own namespace ("vs Haze", "remove Haze", "Rank: Oracle+", "Patch: …") so a
// single query field routes everywhere through lib/fuzzy's band ordering: "haze" puts the hero
// switch first (whole-name prefix) with "vs Haze" right under it (word prefix), "vs ha" pinpoints
// the enemy add, and "rank" / "patch" / "remove" list whole groups.

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

/** What committing a command does — pure data; the app maps it onto its handlers in the
 * commit event, so command assembly stays render-safe (no closures over refs/setters). */
export type PaletteAction =
  | { kind: "hero"; id: number }
  | { kind: "rank"; sel: RankSel }
  | { kind: "patch"; idx: number }
  | { kind: "enemy"; id: number };

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
  /** Marks the current selection (hero/rank/patch) or a current enemy. */
  active?: boolean;
  /** Commit without closing the palette — enemy toggles chain: "haz⏎ vind⏎ …". */
  keepOpen?: boolean;
  action: PaletteAction;
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
}

/** What the palette is scoped to: everything (Ctrl+K), or just enemy toggles (the counter
 * picker's "+ add enemies…" browse-and-search, where hero names need no "vs" prefix). */
export type PaletteMode = "all" | "enemies";

export function buildPaletteCommands(
  mode: PaletteMode,
  state: PaletteState,
): PaletteCommand[] {
  const { heroes, heroId, enemies, patches, patchIdx, rankSel, bandChoice } =
    state;
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

/** Commands matching `query`, best first (lib/fuzzy on the label); the untouched
 * assembly order — the browse view — when the query is empty. */
export function searchPalette(
  commands: PaletteCommand[],
  query: string,
): PaletteCommand[] {
  if (!query.trim()) return commands;
  return rankByFuzzy(query, commands, (c) => c.label);
}
