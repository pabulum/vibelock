// The build feature: the item-build generator query (split by archetype), the skill-order and
// community-build queries that hang off it, and the derived state the render reads. Owns the
// active-archetype selection (deep-linked on the first build, best-win-rate afterwards).
import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  getAbilityOrder,
  getCommunityBuilds,
  getHeroBuildStats,
  getItemFlowStats,
  getItemPermutationStats,
  getItemStats,
} from "../api/deadlock";
import type { TimeWindow } from "../api/deadlock";
import { assembleArchetypes, pickSignatures } from "../lib/archetypes";
import { matchCommunityBuilds } from "../lib/communityBuilds";
import { blendFlow } from "../lib/patchBlend";
import { findAdoptionMovers, findPatchMovers } from "../lib/patchMovers";
import { buildJointGamesLookup } from "../lib/pairs";
import { buildSynergyLookup, singleRecordsFromFlow } from "../lib/synergy";
import { bestImbueTargets } from "../lib/imbue";
import { bestSkillBuild } from "../lib/skills";
import type {
  Ability,
  ArchetypeKey,
  Hero,
  ImbueTarget,
  Item,
  ItemStat,
} from "../types";

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
  canBackfill: boolean;
  priorKey: TimeWindow | null;
  lineAware: boolean;
  urlBuild: string | undefined;
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
    canBackfill,
    priorKey,
    lineAware,
    urlBuild,
  } = opts;

  // Whether the URL's archetype has been honored yet — only on the first build of the linked hero;
  // after that, switching hero falls back to the best-win-rate archetype as usual.
  const urlArchApplied = useRef(false);
  const [archKey, setArchKey] = useState<ArchetypeKey>("all");

  // Generate builds, split by archetype for flex heroes.
  const buildQ = useQuery({
    queryKey: [
      "build",
      heroId,
      { minBadge, maxBadge },
      rankLabel,
      dataWindow,
      priorKey,
      lineAware,
    ],
    enabled: !!hero && !!items,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const h = hero!;
      const itemMap = items!;
      // With backfill on (default), every flow is fetched twice — the selected patch and the month
      // before it — and blended (lib/patchBlend): the pre-patch window backfills a young patch as a
      // capped, drift-discounted prior, so a day-one build is complete instead of starved by the
      // support/significance gates. The blend self-anneals, so on a mature patch the prior
      // contributes ~nothing. The fresh fetch drops the server-side min_matches floor (default 100)
      // to 10 — on day one most nodes are below 100 matches, and the client-side gates run on the
      // blended effective sample anyway. Backfill off = the selected window raw, single fetch.
      const flowFor = (includeItemIds?: number[]) =>
        canBackfill
          ? Promise.all([
              getItemFlowStats({
                heroId: h.id,
                minBadge,
                maxBadge,
                ...dataWindow,
                minMatches: 10,
                includeItemIds,
              }),
              getItemFlowStats({
                heroId: h.id,
                minBadge,
                maxBadge,
                ...priorWin,
                includeItemIds,
              }),
            ]).then(([f, q]) => blendFlow(f, q))
          : getItemFlowStats({
              heroId: h.id,
              minBadge,
              maxBadge,
              ...dataWindow,
              includeItemIds,
            }).then((f) => ({
              flow: f,
              borrowedShare: 0,
              patchK: 0,
              freshGames: f.baseline.matches,
              priorGames: 0,
            }));

      // Base population + buy times (for buy-order) + item-pair permutation stats, in parallel. The
      // permutation payload is large but overlaps the flow fetches below; a failure is non-fatal (the
      // build just ranks on win rate alone and the synergy panel hides). Buy/sell times come from
      // both windows too: per item, prefer the fresh average once it has a steady sample, else keep
      // the pre-patch one (timing barely drifts across patches; ordering stability wins). Permutation
      // stats span both windows in ONE fetch — synergy is a centered, shrunk tiebreak, so the mixed
      // window is fine and the payload is too big to double.
      const [baseBlend, statsFresh, statsPrior, permRows] = await Promise.all([
        flowFor(),
        getItemStats({
          heroId: h.id,
          minBadge,
          maxBadge,
          ...dataWindow,
          ...(canBackfill ? { minMatches: 5 } : {}),
        }),
        canBackfill
          ? getItemStats({
              heroId: h.id,
              minBadge,
              maxBadge,
              ...priorWin,
            })
          : Promise.resolve([] as ItemStat[]),
        getItemPermutationStats({
          heroId: h.id,
          minBadge,
          maxBadge,
          ...(canBackfill
            ? {
                minUnixTimestamp: priorWin.minUnixTimestamp,
                maxUnixTimestamp: dataWindow.maxUnixTimestamp,
              }
            : dataWindow),
        }).catch(() => null),
      ]);
      const base = baseBlend.flow;
      // Movers compare the RAW windows (blending them first would test the prior against itself).
      const movers = canBackfill
        ? findPatchMovers(statsFresh, statsPrior, itemMap)
        : null;
      const BUY_TIME_MIN_MATCHES = 40;
      const timeStats = new Map(statsPrior.map((s) => [s.item_id, s]));
      for (const s of statsFresh)
        if (s.matches >= BUY_TIME_MIN_MATCHES || !timeStats.has(s.item_id))
          timeStats.set(s.item_id, s);
      const buyTimes = new Map(
        [...timeStats.values()].map((s) => [s.item_id, s.avg_buy_time_s]),
      );
      const sellTimes = new Map(
        [...timeStats.values()].map((s) => [s.item_id, s.avg_sell_time_s]),
      );

      // Pairwise synergy lookup (#5/#6): centered + shrunk interaction between item ids, from the
      // unconditioned pairs + singles. Passed into the generator so discretionary core picks lean toward
      // items that reinforce the build; absent pairs ⇒ the build ranks on win rate alone (unchanged).
      const decided = base.baseline.wins + base.baseline.losses;
      const baseline = decided > 0 ? base.baseline.wins / decided : 0.5;
      // Adoption movers reuse the same raw windows + the honest per-window game totals from the blend:
      // items the player base is moving toward this patch (rising pick rate), split into breakouts
      // (rising *and* winning) and hype (rising but not paying off).
      const adoption = canBackfill
        ? findAdoptionMovers(
            statsFresh,
            statsPrior,
            baseBlend.freshGames,
            baseBlend.priorGames,
            baseline,
            itemMap,
          )
        : null;
      const synergyOf = permRows
        ? buildSynergyLookup(permRows, singleRecordsFromFlow(base), baseline)
        : undefined;
      // Same payload, plainer lens: measured joint-purchase counts, for the generator's
      // substitute / most-build-into / swap decisions (see lib/pairs.ts).
      const jointGamesOf = permRows
        ? buildJointGamesLookup(permRows)
        : undefined;

      // Condition on each archetype's signature item. The gun/spirit overlap (for the
      // flex/hybrid decision) is read out of the gun flow itself, so no extra query.
      const sig = pickSignatures(base, itemMap);
      const [gunBlend, spiritBlend] = await Promise.all([
        sig.gun ? flowFor([sig.gun]) : Promise.resolve(undefined),
        sig.spirit ? flowFor([sig.spirit]) : Promise.resolve(undefined),
      ]);
      const gun = gunBlend?.flow;
      const spirit = spiritBlend?.flow;

      const set = assembleArchetypes(
        h,
        rankLabel,
        itemMap,
        buyTimes,
        sellTimes,
        { all: base, gun, spirit },
        sig,
        { synergyOf, jointGamesOf, lineAware },
      );
      // Share of the build's win-rate evidence borrowed from the pre-patch window (see
      // lib/patchBlend): ~0.85 the day after a patch, fading to ~0 as the patch matures.
      // Surfaced in the meta line so "is this build trustworthy yet?" is a number, not a vibe.
      // The flows ride along so the why-not verdict (lib/buildgen/verdict) can re-run the
      // generator's gates for any item against the same data the build was generated from.
      return {
        set,
        movers,
        adoption,
        flows: { all: base, gun, spirit },
        backfillShare: canBackfill ? baseBlend.borrowedShare : null,
      };
    },
  });
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
