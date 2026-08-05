// One encoded in-game build per hero, for the batch export.
//
// The export panel writes builds into Deadlock's local cache. Doing that for one hero at a time is
// the same ritual repeated: quit the game, pick the file, write, relaunch. But you queue with three
// or four heroes and the game assigns one, so the build you need is only known after the ritual is
// over. Writing every hero you queue with in a single pass is what makes the feature match how the
// game is actually played.
//
// Each hero costs a full build fan-out (lib/buildFetch) plus its skill order and community builds —
// the same requests the app makes when you switch to that hero, at the same URLs, through the same
// cache. A hero already on screen, or already hovered, is therefore free. They are fetched with
// bounded concurrency rather than all at once: the analytics API allows ~200 requests a minute per
// IP and a six-hero batch is around ninety, which is fine spread out and rude in one burst.

import { getAbilityOrder, getCommunityBuilds } from "../api/deadlock";
import { fetchBuildSet, type BuildSlice } from "./buildFetch";
import { encodeHeroBuild, vibelockBuildName } from "./heroBuildExport";
import { bestImbueTargets } from "./imbue";
import { bestSkillBuild } from "./skills";
import type { Ability, Hero, Item } from "../types";

/** How many heroes are fetched at once. Two keeps a batch inside the analytics budget while still
 * overlapping the slow flow requests, which dominate the wall clock. */
const CONCURRENCY = 2;

export interface BatchContext {
  items: Map<number, Item>;
  abilities: Map<number, Ability> | null;
  rankLabel: string;
  slice: BuildSlice;
  patchLabel: string;
  /** Steam account id stamped as the build's author, so it can be edited and deleted in-game. */
  authorId?: number;
}

export interface BatchEntry {
  hero: Hero;
  /** The encoded protobuf ready for `Favorites`, or null when this hero's build could not be made. */
  blob: Uint8Array | null;
  /** Why it could not, for the panel to report rather than silently skip. */
  error?: string;
  /** The build's in-game name, so a caller can say what it wrote. */
  name?: string;
}

/** Everything one hero contributes to the file: the best archetype's build, its skill order, and
 * the community-plurality imbue targets, encoded. */
async function entryFor(hero: Hero, ctx: BatchContext): Promise<BatchEntry> {
  try {
    const { set } = await fetchBuildSet({
      hero,
      items: ctx.items,
      rankLabel: ctx.rankLabel,
      slice: ctx.slice,
    });
    // The same archetype the app shows by default when you switch to this hero: best win rate.
    const arch = set.archetypes[0];
    const build = arch?.build;
    if (!build) return { hero, blob: null, error: "no build data" };

    const { minBadge, maxBadge, dataWindow } = ctx.slice;
    // Skill order and imbues are what make an exported build playable rather than a shopping list,
    // so they are fetched — but neither is allowed to lose the build. A hero whose ability-order
    // slice is empty still exports its items.
    const [skill, community] = await Promise.all([
      getAbilityOrder({
        heroId: hero.id,
        minBadge,
        maxBadge,
        ...dataWindow,
        includeItemIds: arch.signature ? [arch.signature.id] : undefined,
      })
        .then(bestSkillBuild)
        .catch(() => null),
      getCommunityBuilds(hero.id).catch(() => null),
    ]);

    const slotOrder = (() => {
      if (!ctx.abilities) return [];
      const byClass = new Map<string, number>();
      for (const a of ctx.abilities.values()) byClass.set(a.className, a.id);
      return hero.signatureClasses
        .map((c) => byClass.get(c))
        .filter((id): id is number => id !== undefined);
    })();
    const imbues =
      community && ctx.abilities
        ? bestImbueTargets(community, ctx.abilities, slotOrder)
        : undefined;

    const name = vibelockBuildName(
      hero.name,
      build.rankLabel,
      set.flex ? arch.label : undefined,
    );
    return {
      hero,
      name,
      blob: encodeHeroBuild(build, {
        name,
        description:
          `Top-to-bottom build from Vibelock · ${build.rankLabel} · ${ctx.patchLabel} · ` +
          `${build.population.matches.toLocaleString()} matches. Core phases + a Situational ` +
          `(optional) row; each item's note says why it's picked. Made with vibelock.`,
        authorId: ctx.authorId,
        skillOrder: skill?.order,
        imbues,
      }),
    };
  } catch (e) {
    return { hero, blob: null, error: (e as Error)?.message ?? String(e) };
  }
}

/**
 * Encode a build for each hero, at most {@link CONCURRENCY} at a time, reporting progress as each
 * lands. Never rejects: a hero that fails comes back as an entry with an `error`, so one dead hero
 * cannot cost you the other five.
 */
export async function buildBatch(
  heroes: Hero[],
  ctx: BatchContext,
  onProgress?: (done: number, total: number, hero: Hero) => void,
): Promise<BatchEntry[]> {
  const out: BatchEntry[] = new Array(heroes.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= heroes.length) return;
      out[i] = await entryFor(heroes[i], ctx);
      onProgress?.(++done, heroes.length, heroes[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, heroes.length) }, worker),
  );
  return out;
}
