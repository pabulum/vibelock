// The build feature: the item-build generator query (split by archetype), the skill-order and
// community-build queries that hang off it, and the derived state the render reads. Owns the
// active-archetype selection (deep-linked on the first build, best-win-rate afterwards).
import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { queryClient } from "../queryClient";
import {
  getAbilityOrder,
  getCommunityBuilds,
  getHeroBuildStats,
} from "../api/deadlock";
import type { TimeWindow } from "../api/deadlock";
import { fetchBuildSet } from "../lib/buildFetch";
import { matchCommunityBuilds } from "../lib/communityBuilds";
import { bestImbueTargets } from "../lib/imbue";
import { bestSkillBuild } from "../lib/skills";
import type { Ability, ArchetypeKey, Hero, ImbueTarget, Item } from "../types";

export function useBuildData(opts: {
  hero: Hero | null;
  heroId: number | null;
  items: Map<number, Item> | null;
  abilities: Map<number, Ability> | null;
  rankLabel: string;
  minBadge: number;
  maxBadge?: number;
  dataWindow: TimeWindow;
  priorWin: TimeWindow;
  /** The movers' comparator window: as much time immediately before the patch as it has run for
   * (lib/patchWindows). Separate from `priorWin`, which is the blend's 30-day borrow window — the
   * blend wants all the evidence it can get, the movers want a like-for-like contrast. */
  moversWin: TimeWindow;
  canBackfill: boolean;
  priorKey: TimeWindow | null;
  lineAware: boolean;
  urlBuild: string | undefined;
  /** Notes body of the selected patch, for the movers' causal tag (lib/patchChanges). */
  patchNotes: string | undefined;
}) {
  const {
    hero,
    heroId,
    items,
    abilities,
    rankLabel,
    minBadge,
    maxBadge,
    dataWindow,
    priorWin,
    moversWin,
    canBackfill,
    priorKey,
    lineAware,
    urlBuild,
    patchNotes,
  } = opts;

  // Whether the URL's archetype has been honored yet — only on the first build of the linked hero;
  // after that, switching hero falls back to the best-win-rate archetype as usual.
  const urlArchApplied = useRef(false);
  const [archKey, setArchKey] = useState<ArchetypeKey>("all");

  // Generate builds, split by archetype for flex heroes.
  const buildKey = [
    "build",
    heroId,
    { minBadge, maxBadge },
    rankLabel,
    dataWindow,
    priorKey,
    canBackfill ? moversWin : null,
    lineAware,
  ];
  const buildQ = useQuery({
    queryKey: buildKey,
    enabled: !!hero && !!items,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      fetchBuildSet({
        hero: hero!,
        items: items!,
        rankLabel,
        slice: {
          minBadge,
          maxBadge,
          dataWindow,
          priorWin,
          moversWin,
          canBackfill,
          lineAware,
          patchNotes,
        },
        signal,
      }),
  });

  // Abandon the previous selection's fan-out. A key change leaves the old build query observer-less
  // but still running — TanStack does not cancel those on its own — and its archetype flows are the
  // longest requests the app makes (~6s each, four at a time), so it would sit on most of the
  // concurrency budget while the hero you just picked waits. cancelQueries aborts their signals;
  // api/deadlock only lets that reach the socket once every *other* query wanting the same URL has
  // gone too, so a shared slice is never pulled out from under a live panel.
  const buildKeyStr = JSON.stringify(buildKey);
  useEffect(() => {
    queryClient.cancelQueries({
      predicate: (q) =>
        q.queryKey[0] === "build" && JSON.stringify(q.queryKey) !== buildKeyStr,
    });
  }, [buildKeyStr]);

  const archetypeSet = buildQ.data?.set ?? null;
  // "What changed this patch" — FDR-gated movers from the two item-stats windows the backfill
  // already fetches (needs both, so only computed while backfill is on).
  const movers = buildQ.data?.movers ?? null;
  const adoption = buildQ.data?.adoption ?? null;
  const backfill = buildQ.data?.backfillShare ?? null;

  // Pick the shown archetype whenever a new set bakes: the deep-linked one on the first build of
  // the linked hero, best win rate afterwards.
  useEffect(() => {
    const set = buildQ.data?.set;
    if (!set) return;
    const linked = urlBuild;
    if (
      !urlArchApplied.current &&
      linked &&
      set.archetypes.some((x) => x.key === linked)
    ) {
      setArchKey(linked as ArchetypeKey);
    } else {
      setArchKey(set.archetypes[0].key);
    }
    urlArchApplied.current = true;
  }, [buildQ.data, urlBuild]);

  const activeArchetype =
    archetypeSet?.archetypes.find((a) => a.key === archKey) ??
    archetypeSet?.archetypes[0] ??
    null;
  const build = activeArchetype?.build ?? null;

  // The hero's abilities in in-game slot order (signature1→4), as ability ids.
  const slotOrder = useMemo(() => {
    if (!hero || !abilities) return [];
    const byClass = new Map<string, number>();
    for (const a of abilities.values()) byClass.set(a.className, a.id);
    return hero.signatureClasses
      .map((c) => byClass.get(c))
      .filter((id): id is number => id !== undefined);
  }, [hero, abilities]);

  // Skill (ability upgrade) build, conditioned on the active archetype so gun/spirit
  // builds get their own order (they differ — and the spirit order often wins more).
  const activeSignatureId = activeArchetype?.signature?.id;
  const skillQ = useQuery({
    queryKey: [
      "skill",
      heroId,
      { minBadge, maxBadge },
      dataWindow,
      priorKey,
      activeSignatureId ?? null,
    ],
    enabled: !!hero,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const base = {
        heroId: hero!.id,
        minBadge,
        maxBadge,
        ...dataWindow,
      };
      // Prefer the order players ran *with* this archetype's signature item — but that
      // slice is narrow, so at a high rank floor on one patch it can come back empty.
      // Fall back to the hero's overall order, and on a young patch where even that is
      // empty, to the pre-patch month — a stale-but-real order beats no order (skill
      // order is descriptive, and patches rarely reshape it).
      const conditioned = await getAbilityOrder({
        ...base,
        includeItemIds: activeSignatureId ? [activeSignatureId] : undefined,
      });
      let skill = bestSkillBuild(conditioned);
      if (!skill && activeSignatureId) {
        skill = bestSkillBuild(await getAbilityOrder(base));
      }
      if (!skill && canBackfill) {
        skill = bestSkillBuild(
          await getAbilityOrder({
            heroId: hero!.id,
            minBadge,
            maxBadge,
            ...priorWin,
          }),
        );
      }
      return skill;
    },
  });
  const skillBuild = skillQ.data ?? null;

  // Community builds + their win rate at this rank/patch. Joined and scored against the
  // generated build in a memo below, so changing the active archetype re-scores without
  // refetching.
  const communityQ = useQuery({
    queryKey: ["community", heroId, { minBadge, maxBadge }, dataWindow],
    enabled: !!hero,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const [builds, stats] = await Promise.all([
        getCommunityBuilds(hero!.id),
        getHeroBuildStats({
          heroId: hero!.id,
          minBadge,
          maxBadge,
          ...dataWindow,
        }),
      ]);
      return { builds, stats };
    },
  });
  const community = communityQ.data ?? null;

  // Items the generated build recommends (core picks across phases) — the set we match
  // community builds against.
  // Compare like-for-like: our core ranks against their core, our situational against
  // theirs (secondary). The same split feeds the preview's structured diff (diffBuild).
  const ourCoreIds = useMemo(
    () =>
      build
        ? [
            ...new Set(
              build.phases.flatMap((p) => p.core.map((b) => b.item.id)),
            ),
          ]
        : [],
    [build],
  );
  const ourSituationalIds = useMemo(() => {
    if (!build) return [];
    const core = new Set(
      build.phases.flatMap((p) => p.core.map((b) => b.item.id)),
    );
    return [
      ...new Set(
        build.phases.flatMap((p) => p.situational.map((b) => b.item.id)),
      ),
    ].filter((id) => !core.has(id));
  }, [build]);
  // Our recommended max order, shown in the build hover for a like-for-like skill-order
  // comparison (descriptive only — it doesn't influence the match).
  const ourMaxOrder = skillBuild?.maxPriority;

  const communityMatch = useMemo(
    () =>
      community && (ourCoreIds.length || ourSituationalIds.length)
        ? matchCommunityBuilds(
            community.builds,
            community.stats,
            ourCoreIds,
            ourSituationalIds,
          )
        : null,
    [community, ourCoreIds, ourSituationalIds],
  );

  // The plurality ability each imbue item gets imbued onto, from the hero's community builds —
  // surfaced as a tag on imbue items in the build (the most important choice for those items).
  const imbueByItem = useMemo(
    () =>
      community && abilities
        ? bestImbueTargets(community.builds, abilities, slotOrder)
        : new Map<number, ImbueTarget>(),
    [community, abilities, slotOrder],
  );

  // Current breakouts (rising + winning this patch), keyed by item id — the "emerging meta" set. Used
  // to tag any pick already in the build with 🔥, and (below) to fold un-built ones into situational.
  const breakouts = useMemo(
    () => (adoption ?? []).filter((a) => a.breakout),
    [adoption],
  );
  const trendingByItem = useMemo(
    () => new Map(breakouts.map((a) => [a.item.id, a])),
    [breakouts],
  );

  // The flow the shown build was generated from (the active archetype's slice), for the why-not
  // verdict — scoring against a different flow would report gates that never ran.
  const flows = buildQ.data?.flows;
  const activeFlow = flows ? (flows[archKey] ?? flows.all) : null;

  return {
    archKey,
    setArchKey,
    buildQ,
    archetypeSet,
    movers,
    adoption,
    backfill,
    activeArchetype,
    build,
    slotOrder,
    skillQ,
    skillBuild,
    communityQ,
    community,
    ourCoreIds,
    ourSituationalIds,
    ourMaxOrder,
    communityMatch,
    imbueByItem,
    breakouts,
    trendingByItem,
    activeFlow,
  };
}
