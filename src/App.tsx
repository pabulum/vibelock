import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import "./App.css";
import { persistOptions, queryClient } from "./queryClient";
import { itemVerdict, rerankBuildForComp } from "./lib/buildGenerator";
import { friendlyError } from "./lib/errors";
import {
  decodeUrlState,
  encodeUrlState,
  slugify,
  type UrlState,
} from "./lib/urlState";
import { priorWindowFor, windowFor } from "./lib/patchWindows";
import { switchTransition } from "./lib/viewTransition";
import { foldTrendingBreakouts } from "./lib/patchMovers";
import { heroFarmProfile } from "./lib/matchAnalysis";
import { heroAccent } from "./lib/heroAccent";
import {
  buildPaletteCommands,
  type PaletteAction,
  type PaletteItem,
} from "./lib/palette";
import {
  bandForTier,
  rankSelLabel,
  rankSelToBadges,
  tierOf,
  type RankSel,
} from "./lib/ranks";
import { useSettle } from "./hooks";
import { useAssets } from "./features/useAssets";
import { useProfile } from "./features/useProfile";
import { useBuildData } from "./features/useBuildData";
import { useCounters } from "./features/useCounters";
import { useModals } from "./features/useModals";
import { wpStatsQueryOptions } from "./api/wpStats";
import { LoadingState } from "./components/panels";
import { TopBar } from "./features/TopBar";
import { MoversStrip } from "./features/MoversStrip";
import { MyHeroes } from "./features/MyHeroes";
import { BuildMeta } from "./features/BuildMeta";
import { DashGrid } from "./features/DashGrid";
import { CountersSection } from "./features/CountersSection";
import { PhaseColumns } from "./features/PhaseColumns";
import { Footer } from "./features/Footer";
import { AppModals } from "./features/AppModals";
import type { Hero, Item } from "./types";

/** Scroll the build row for `id` into view and flash it — the palette's item jump. Direct DOM on
 * purpose: the rows already exist (data-item-row, see ItemHover), and a React state round-trip
 * would re-render every row just to toggle one class for 1.5s. */
function flashItemRow(id: number) {
  const el = document.querySelector<HTMLElement>(`[data-item-row="${id}"]`);
  if (!el) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  el.classList.remove("rowflash");
  void el.offsetWidth; // restart the animation when the same row is jumped to twice
  el.classList.add("rowflash");
  el.addEventListener("animationend", () => el.classList.remove("rowflash"), {
    once: true,
  });
}

function AppInner() {
  // Selection parsed once from the URL on first load (a deep link), via a lazy initializer so it's
  // computed a single time and stays stable. Consumed by the deep-link effect and the first build
  // as the data each field needs arrives, then the URL flips to a write-only mirror of state (see
  // the replaceState effect).
  const [url0] = useState<UrlState>(() =>
    decodeUrlState(window.location.search),
  );

  // ---- Assets (persisted queries; see features/useAssets) ----
  const {
    heroesQ,
    itemListQ,
    patchesQ,
    abilitiesQ,
    heroes,
    patches,
    items,
    abilities,
    patchesReady,
  } = useAssets();

  const [heroId, setHeroId] = useState<number | null>(null);
  // Whether the player chose a hero deliberately (deep link or any click). Until then the
  // profile's most-played hero makes a better default than the alphabetical first (Abrams) —
  // "why am I looking at Abrams" mid-match confusion is real.
  const heroTouched = useRef(false);
  const pickHero = (id: number) => {
    heroTouched.current = true;
    switchTransition(() => setHeroId(id));
  };
  // Rank selection: a floor tier ("Emissary+") or a band ("around my rank" — profile-anchored, or
  // whatever resolved band a shared link carried). Default Eternus floor until a profile pre-selects.
  const [rankSel, setRankSel] = useState<RankSel>(
    () => url0.band ?? url0.tier ?? 11,
  );
  const [patchIdx, setPatchIdx] = useState<number>(0); // newest patch (backfilled from pre-patch data)
  // Pre-patch backfill toggle (lib/patchBlend). Default on — a young patch alone starves the
  // build's support/significance gates; off = the selected window raw, exactly the old behavior.
  const [backfillOn, setBackfillOn] = useState<boolean>(url0.backfill ?? true);
  // Line-aware generation (survivorship gate + down-payment + line collapse — see
  // BuildOptions.lineAware). Experimental, off by default; only the palette flips it.
  const [lineAware, setLineAware] = useState(false);
  const [enemies, setEnemies] = useState<number[]>([]);

  // Overlay UI state (features/useModals): the guide/lab/match/export/share modals, the command
  // palette + its pending jump, the why-not verdict card, and the global Ctrl/⌘+K handler.
  const {
    showGuide,
    setShowGuide,
    showLab,
    setShowLab,
    showMatch,
    setShowMatch,
    matchAutoLatest,
    setMatchAutoLatest,
    showExport,
    setShowExport,
    showShare,
    setShowShare,
    palette,
    setPalette,
    whyItem,
    setWhyItem,
  } = useModals();
  // An item-jump commit waits here until the palette dialog has closed — the page behind a modal
  // dialog is scroll-frozen, so scrolling to the row only works after the unmount unfreezes it.
  // Stays in App (not useModals): it's mutated by the palette handlers below.
  const pendingJump = useRef<number | null>(null);
  // The nightly wp-stats bake (18KB, static): roster-wide purchase context per item (backs the
  // win-more/comeback tags), per-hero closing power (annotates the your-heroes chips), and the
  // WP-vs-lead surface (the "typical lead ≈ X% win" note on each phase). Fail-soft: its query
  // error is deliberately not surfaced — without it the page renders exactly as before.
  const wpStats = useQuery(wpStatsQueryOptions).data ?? null;
  const labItems = useMemo(
    () =>
      wpStats &&
      new Map(
        wpStats.items.map((i) => [i.id, { wpBuy: i.wpBuy, excess: i.excess }]),
      ),
    [wpStats],
  );
  const labOf = useMemo(
    () => (labItems ? (id: number) => labItems.get(id) : undefined),
    [labItems],
  );
  // Chips key off the WR-RESIDUAL of closing power, not raw closing: raw closing tracks plain
  // hero WR (r≈0.93), which the chip already shows as its expected %. The residual is the part
  // WR doesn't explain — the hero's style (converts even games vs needs a soul lead).
  const labHeroes = useMemo(
    () =>
      wpStats &&
      new Map(
        wpStats.heroes
          .filter((h) => h.resid !== undefined)
          .map((h) => [h.id, h.resid!]),
      ),
    [wpStats],
  );
  // The profile's rank pre-selects the band only until the player picks a rank deliberately —
  // a deep-linked rank or a manual select always wins and is never overridden afterwards.
  const tierTouched = useRef(
    url0.tier !== undefined || url0.band !== undefined,
  );
  // One-time cue when a Steam profile silently re-slices the data: the auto-selected band's label,
  // shown as a note under the Rank control (friend feedback: the rank flip read as "Steam ID changes
  // the items"). Cleared on a deliberate rank pick or a profile change; also fades out via CSS.
  const [rankAutoSet, setRankAutoSet] = useState<string | null>(null);
  // A deliberate rank choice, shared by the Rank select and the command palette: stops the
  // profile pre-selecting, clears its cue, and runs inside the switch view transition.
  const pickRank = (sel: RankSel) => {
    tierTouched.current = true;
    setRankAutoSet(null);
    switchTransition(() => setRankSel(sel));
  };

  // Apply any deep-link selection once the assets can resolve slugs/timestamps. (The queries
  // themselves need no kickoff — mounting them starts the fetches, cached-first.)
  const deepLinkApplied = useRef(false);
  useEffect(() => {
    if (deepLinkApplied.current) return;
    if (!heroesQ.data || !itemListQ.data || !patchesQ.data || !abilitiesQ.data)
      return;
    // A restored-but-stale patch list may still be refreshing; resolving a deep link's patchTs
    // against it could land on an index the fresh list is about to shift. Wait it out.
    if (url0.patchTs !== undefined && patchesQ.isFetching) return;
    deepLinkApplied.current = true;
    const h = heroesQ.data;
    if (h.length) {
      const idBySlug = new Map(h.map((x) => [slugify(x.name), x.id]));
      const linked = url0.hero ? idBySlug.get(url0.hero) : undefined;
      if (linked) heroTouched.current = true; // a deep-linked hero is a deliberate choice
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing the resolved deep link into selection state
      setHeroId(linked || h[0].id);
      if (url0.enemies?.length) {
        const ids = url0.enemies
          .map((s) => idBySlug.get(s))
          .filter((id): id is number => id !== undefined);

        if (ids.length) setEnemies(ids);
      }
    }
    if (url0.patchTs !== undefined) {
      const idx = patchesQ.data.findIndex((pt) => pt.ts === url0.patchTs);

      if (idx >= 0) setPatchIdx(idx);
    }
  }, [
    heroesQ.data,
    itemListQ.data,
    patchesQ.data,
    abilitiesQ.data,
    patchesQ.isFetching,
    url0,
  ]);

  const hero = useMemo(
    () => heroes.find((h) => h.id === heroId) ?? null,
    [heroes, heroId],
  );
  // Per-hero accent: retune --accent from the selected hero's portrait (one-time canvas
  // sample per portrait, cached — see lib/heroAccent). Set on :root so every accent-tinted
  // detail follows; the @property registration in App.css makes the change cross-fade.
  // Fail-soft: no portrait / colorless art / CORS surprise ⇒ the default accent stays.
  useEffect(() => {
    const root = document.documentElement;
    if (!hero?.image) {
      root.style.removeProperty("--accent");
      return;
    }
    let live = true;
    heroAccent(hero.image).then((color) => {
      if (!live) return;
      if (color) root.style.setProperty("--accent", color);
      else root.style.removeProperty("--accent");
    });
    return () => {
      live = false;
    };
  }, [hero]);
  const { minBadge, maxBadge } = rankSelToBadges(rankSel);
  const rankLabel = rankSelLabel(rankSel);
  // Descriptive soul-income shape for this hero at this rank (population median from the Lab's farm
  // norms). Independent of the player's account — it renders whenever a hero + rank cell is baked.
  const farmProfile = useMemo(
    () =>
      hero && wpStats
        ? heroFarmProfile(wpStats, hero.id, tierOf(rankSel))
        : null,
    [hero, wpStats, rankSel],
  );
  // Numeric anchor for rank-scaled heuristics (the new-hero learning tax): the floor tier, or a
  // band's midpoint.
  const tierAnchor =
    typeof rankSel === "number" ? rankSel : (rankSel.lo + rankSel.hi) / 2;

  // The selected patch window and its pre-patch prior — the two time slices every windowed query
  // below keys on. Memoized so query keys stay referentially honest across renders.
  const dataWindow = useMemo(
    () => windowFor(patches, patchIdx),
    [patches, patchIdx],
  );
  const priorWin = useMemo(
    () => priorWindowFor(patches, patchIdx),
    [patches, patchIdx],
  );
  // Backfill needs a patch boundary to blend across; when the patch feed is down (empty list,
  // see patchesQueryOptions) we degrade to the plain window instead of dead-ending queries.
  const canBackfill = backfillOn && patches.length > 0;
  // The prior window's contribution to query keys: null when backfill is off, so toggling it
  // re-keys (and re-fetches) exactly the queries whose results it changes.
  const priorKey = canBackfill ? priorWin : null;

  // The player-identity feature (features/useProfile): Steam id + profile + your-heroes rows +
  // fundamentals benchmark + last-game overlay, with all their queries and derived state.
  const {
    steamId,
    setSteamId,
    accountId,
    steamMatches,
    setSteamMatches,
    recentGames,
    setRecentGames,
    profileQ,
    profile,
    heroPool,
    profileTier,
    heroMetaQ,
    topHeroes,
    tryHeroes,
    NEW_HERO_TAX,
    fundamentalsQ,
    fundamentals,
    soulsPerMinRow,
    combatRows,
    lastGameFarm,
    lastHeroMatchId,
  } = useProfile({
    hero,
    heroId,
    heroes,
    items,
    patchesReady,
    rankSel,
    minBadge,
    maxBadge,
    tierAnchor,
    dataWindow,
    priorWin,
    canBackfill,
    priorKey,
    wpStats,
  });
  // The band the Rank dropdown offers: the active one (a shared link's band survives even without
  // a matching profile), else the profile's own. No profile and no band ⇒ the option is hidden.
  const bandChoice =
    typeof rankSel === "object"
      ? rankSel
      : profileTier !== null
        ? bandForTier(profileTier)
        : null;

  // Sync the profile's defaults into the selection — most-played hero until one is picked
  // deliberately, and the profile's band, not a floor: match volume piles up at high-mid ranks,
  // so a below-the-mode floor is dominated by games well above the player — the capped band is
  // their actual neighborhood, tilted one rank into the climb.
  useEffect(() => {
    if (!profile) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- profile cleared; drop its cue
      setRankAutoSet(null);
      return;
    }
    if (!heroTouched.current && heroPool?.[0]) {
      setHeroId(heroPool[0].hero.id);
    }
    if (!tierTouched.current && profile.rankTier !== null) {
      const band = bandForTier(profile.rankTier);

      setRankSel(band);

      setRankAutoSet(rankSelLabel(band));
    } else {
      setRankAutoSet(null);
    }
  }, [profile, heroPool]);

  // The build feature (features/useBuildData): the generator query split by archetype, the
  // skill-order and community-build queries that hang off it, and all their derived state.
  const {
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
    ourCoreIds,
    ourSituationalIds,
    ourMaxOrder,
    communityMatch,
    imbueByItem,
    breakouts,
    trendingByItem,
    activeFlow,
  } = useBuildData({
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
    urlBuild: url0.build,
  });

  // The live selection as URL state — mirrored into the address bar below, and the state the
  // Share panel's links carry. Null until a hero resolves, so it can't overwrite the deep-link
  // params before the deep-link effect above has consumed them.
  const liveUrlState: UrlState | null = useMemo(
    () =>
      hero
        ? {
            hero: slugify(hero.name),
            ...(typeof rankSel === "number"
              ? { tier: rankSel }
              : { band: rankSel }),
            patchTs: patches[patchIdx]?.ts,
            backfill: backfillOn,
            build: archKey,
            enemies: enemies
              .map((id) => heroes.find((h) => h.id === id)?.name)
              .filter((n): n is string => !!n)
              .map(slugify),
          }
        : null,
    [hero, rankSel, patchIdx, patches, backfillOn, archKey, enemies, heroes],
  );

  // Mirror the live selection into the URL (replaceState, so links stay shareable without
  // spamming history).
  useEffect(() => {
    if (!liveUrlState) return;
    const url = `${window.location.pathname}${encodeUrlState(liveUrlState)}${window.location.hash}`;
    window.history.replaceState(null, "", url);
  }, [liveUrlState]);

  // Reflect the selected hero — and its in-game role flavor line — in the tab title. Nice for
  // bookmarks and shared deep links. Falls back to the brand title while assets load, and to just
  // the name for heroes that have no role yet.
  useEffect(() => {
    document.title = hero
      ? `${hero.name} · Vibelock`
      : "Vibelock — data-driven Deadlock builds";
  }, [hero]);

  // The counters feature (features/useCounters): item counters vs the enemy comp, the matchup
  // matrix, and the per-item / per-phase lookups the build render tags rows from.
  const {
    countersQ,
    compEdges,
    matrixQ,
    matchups,
    counterByItem,
    countersByPhase,
  } = useCounters({
    hero,
    heroId,
    items,
    enemies,
    minBadge,
    maxBadge,
    dataWindow,
    priorWin,
    canBackfill,
    priorKey,
    patchesReady,
  });

  const toggleEnemy = (id: number) =>
    setEnemies((e) =>
      e.includes(id) ? e.filter((x) => x !== id) : [...e, id],
    );

  // Empty patch list = the feed failed and the patches query degraded (see api/deadlock) —
  // windowless queries fall back to the API's default last-30-days, so label it that way.
  const patchLabel =
    patches[patchIdx]?.title ?? (patches.length ? "…" : "last 30 days");
  // "leans N% on pre-patch data" — only worth saying when the borrow is real (≥ 1%).
  const backfillLabel =
    backfill !== null && backfill >= 0.01
      ? ` (${Math.round(backfill * 100)}% backfilled from the prior 30 days)`
      : "";
  const enemyNames = enemies
    .map((id) => heroes.find((h) => h.id === id)?.name ?? "?")
    .join(", ");
  const enemiesById = useMemo(() => {
    const m = new Map<number, Hero>();
    for (const id of enemies) {
      const h = heroes.find((x) => x.id === id);
      if (h) m.set(id, h);
    }
    return m;
  }, [enemies, heroes]);
  // With a comp selected, re-rank the build for it: the comp decides which non-staples fill
  // each phase's core slots, the role labels, and the order (category counts + staples held).
  const displayBuild = useMemo(
    () =>
      build && compEdges && items && enemies.length > 0
        ? rerankBuildForComp(build, compEdges, items)
        : build,
    [build, compEdges, items, enemies.length],
  );
  // The build as rendered: the (comp-re-ranked) build with un-built breakouts folded in as tagged
  // situational options — the discovery half of the app, surfaced where you pick flex items. Purely
  // additive (see foldTrendingBreakouts), so it can't disturb the core build.
  const shownBuild = useMemo(
    () =>
      displayBuild ? foldTrendingBreakouts(displayBuild, breakouts) : null,
    [displayBuild, breakouts],
  );
  // Every item the build already shows anywhere — a counter pick in this set gets a tag
  // in place rather than a duplicate "add" row (its buy-time phase can differ from where
  // the build files it).
  const buildItemIds = useMemo(
    () =>
      new Set(
        (shownBuild?.phases ?? []).flatMap((p) =>
          [...p.core, ...p.situational].map((b) => b.item.id),
        ),
      ),
    [shownBuild],
  );
  const lowPopulation = build !== null && build.population.matches < 400;

  const paletteCommands = useMemo(() => {
    if (!palette) return [];
    // The Items groups are assembled only while the palette is up: what the shown build lists
    // anywhere becomes a jump target, the rest of the catalog a search-only why-not verdict.
    const seen = new Set<number>();
    const buildItems: PaletteItem[] = [];
    const pushItem = (it: Item) => {
      if (seen.has(it.id)) return;
      seen.add(it.id);
      buildItems.push({ id: it.id, name: it.name, image: it.image });
    };
    if (shownBuild) {
      for (const p of shownBuild.phases)
        for (const b of [...p.core, ...p.situational]) pushItem(b.item);
      for (const b of shownBuild.overtimeBuys) pushItem(b.item);
    }
    const otherItems: PaletteItem[] = (itemListQ.data ?? [])
      .filter((i) => !seen.has(i.id))
      .map((i) => ({ id: i.id, name: i.name, image: i.image }));
    return buildPaletteCommands(palette, {
      heroes,
      heroId,
      enemies,
      patches,
      patchIdx,
      rankSel,
      bandChoice,
      buildItems,
      otherItems,
      hasBuild: !!shownBuild,
      backfillOn,
      lineAwareOn: lineAware,
    });
  }, [
    palette,
    heroes,
    heroId,
    enemies,
    patches,
    patchIdx,
    rankSel,
    bandChoice,
    shownBuild,
    itemListQ.data,
    backfillOn,
    lineAware,
  ]);
  // Commands carry data-only actions (lib/palette); this maps a committed one onto the same
  // handlers the header controls use. Runs only from the palette's commit events.
  const runPaletteAction = (a: PaletteAction) => {
    if (a.kind === "hero") pickHero(a.id);
    else if (a.kind === "rank") pickRank(a.sel);
    else if (a.kind === "patch") setPatchIdx(a.idx);
    else if (a.kind === "enemy") {
      toggleEnemy(a.id);
      // A "vs …" add from the main palette starts a counter-adding run: switch into enemies mode
      // so the next bare name is another pick. Already-in-enemies-mode adds carry no chain flag.
      if (a.chain) setPalette("enemies");
    }
    else if (a.kind === "mode") setPalette(a.mode);
    else if (a.kind === "jump") pendingJump.current = a.id;
    else if (a.kind === "why") setWhyItem(items?.get(a.id) ?? null);
    else if (a.kind === "toggle") {
      if (a.toggle === "backfill") setBackfillOn((v) => !v);
      else setLineAware((v) => !v);
    } else if (a.kind === "panel") {
      if (a.panel === "share") setShowShare(true);
      else if (a.panel === "export") setShowExport(true);
      else if (a.panel === "lab") setShowLab(true);
      else if (a.panel === "guide") setShowGuide(true);
      else {
        setMatchAutoLatest(false);
        setShowMatch(true);
      }
    }
  };

  // activeFlow (the flow the shown build was generated from) comes from useBuildData; the why-not
  // verdict re-runs the generator's gates for any item against that same flow.
  const whyVerdict = useMemo(
    () =>
      whyItem && activeFlow && shownBuild && items
        ? itemVerdict(whyItem.id, activeFlow, shownBuild, items)
        : null,
    [whyItem, activeFlow, shownBuild, items],
  );

  // The one error banner: the first query with a live error wins, mapped to a friendly line.
  // Asset failures are fatal (nothing to render); the rest surface while their panels keep
  // showing the previous data. wp-stats and the last-game overlay stay silent by design.
  const queryError =
    heroesQ.error ??
    itemListQ.error ??
    abilitiesQ.error ??
    patchesQ.error ??
    buildQ.error ??
    countersQ.error ??
    matrixQ.error ??
    skillQ.error ??
    communityQ.error ??
    profileQ.error ??
    heroMetaQ.error ??
    fundamentalsQ.error ??
    null;
  const error = queryError ? friendlyError(queryError) : null;

  // Loading flags for the settle veils and the header strip — straight off each query's
  // fetching state, so a veil can't clear before its data actually lands.
  const loading = buildQ.isFetching;
  const countersLoading = countersQ.isFetching;
  const skillLoading = skillQ.isFetching;
  const communityLoading = communityQ.isFetching;
  const matrixLoading = matrixQ.isFetching;
  const profileLoading = profileQ.isFetching;
  const heroMetaLoading = heroMetaQ.isFetching;
  const fundamentalsLoading = fundamentalsQ.isFetching;
  // Any data in flight — drives the single loading strip under the header. `!items`
  // covers the very first paint, before the asset queries have resolved.
  const busy =
    loading ||
    countersLoading ||
    skillLoading ||
    communityLoading ||
    matrixLoading ||
    profileLoading ||
    heroMetaLoading ||
    fundamentalsLoading ||
    (!items && !error);
  // The brand mark's icon is a function of the current selection, so it flips to a new
  // item on each action (hero/rank/patch/build-style/enemy change) and is otherwise still.
  const shuffleSeed = `${heroId}|${rankLabel}|${patchIdx}|${archKey}|${enemies.join(",")}`;

  // Per-piece "developing" veils — each tracks its own query's fetching state so panels settle as
  // their data actually lands, independently of the single strip in the header. The build wears
  // the veil for its own archetype query *and* for a counters re-rank: picking an enemy
  // re-orders the build in place, so it should visibly develop into the answer too.
  const buildRef = useSettle<HTMLElement>(loading || countersLoading);
  const skillRef = useSettle<HTMLElement>(skillLoading);
  const communityRef = useSettle<HTMLElement>(communityLoading);
  const matrixRef = useSettle<HTMLDivElement>(matrixLoading);
  // The movers/trending strip is populated by the build query; the fundamentals card by its own. Both
  // wear the same settle scrim so a reload visibly develops rather than silently swapping numbers.
  const moversRef = useSettle<HTMLDivElement>(loading);
  const fundamentalsRef = useSettle<HTMLElement>(fundamentalsLoading);
  // The hero name/metadata block. Its identity (face + name) reads from the live selection so it
  // swaps the instant you click a hero, while the stats it carries (matches, WR, standing slots)
  // are still the *previous* hero's until the build query lands — so the block wears the settle
  // scrim, developing the new numbers under the frost rather than showing a truthful face over
  // stale figures with no cue that anything is loading.
  const metaRef = useSettle<HTMLDivElement>(loading);
  return (
    <div className="app">
      <TopBar
        items={items}
        shuffleSeed={shuffleSeed}
        hero={hero}
        heroes={heroes}
        heroId={heroId}
        pickHero={pickHero}
        rankSel={rankSel}
        pickRank={pickRank}
        bandChoice={bandChoice}
        patchIdx={patchIdx}
        setPatchIdx={setPatchIdx}
        patches={patches}
        backfillOn={backfillOn}
        setBackfillOn={setBackfillOn}
        steamId={steamId}
        setSteamId={setSteamId}
        steamMatches={steamMatches}
        setSteamMatches={setSteamMatches}
        rankAutoSet={rankAutoSet}
        setPalette={setPalette}
        onOpenGuide={() => setShowGuide(true)}
        onOpenLab={() => setShowLab(true)}
        onOpenMatch={() => {
          setMatchAutoLatest(false);
          setShowMatch(true);
        }}
        busy={busy}
      />

      {error && <div className="banner error">⚠ {error}</div>}

      {movers && (
        <MoversStrip
          movers={movers}
          adoption={adoption}
          hero={hero}
          moversRef={moversRef}
        />
      )}

      {topHeroes && topHeroes.length > 0 && (
        <MyHeroes
          topHeroes={topHeroes}
          tryHeroes={tryHeroes}
          heroId={heroId}
          pickHero={pickHero}
          newHeroTax={NEW_HERO_TAX}
          labHeroes={labHeroes}
        />
      )}

      <BuildMeta
        build={build}
        hero={hero}
        archetypeSet={archetypeSet}
        activeArchetype={activeArchetype}
        archKey={archKey}
        setArchKey={setArchKey}
        displayBuild={displayBuild}
        patchLabel={patchLabel}
        backfillLabel={backfillLabel}
        lowPopulation={lowPopulation}
        metaRef={metaRef}
        onOpenExport={() => setShowExport(true)}
        onOpenShare={() => setShowShare(true)}
      />

      <DashGrid
        hero={hero}
        rankLabel={rankLabel}
        items={items}
        abilities={abilities}
        farmProfile={farmProfile}
        soulsPerMinRow={soulsPerMinRow}
        lastGameFarm={lastGameFarm}
        fundamentals={fundamentals}
        combatRows={combatRows}
        recentGames={recentGames}
        setRecentGames={setRecentGames}
        fundamentalsRef={fundamentalsRef}
        skillBuild={skillBuild}
        slotOrder={slotOrder}
        skillRef={skillRef}
        skillLoading={skillLoading}
        communityMatch={communityMatch}
        buildRankLabel={build?.rankLabel}
        ourCoreIds={ourCoreIds}
        ourSituationalIds={ourSituationalIds}
        ourMaxOrder={ourMaxOrder}
        communityRef={communityRef}
        lastHeroMatchId={lastHeroMatchId}
        onOpenGuide={() => setShowGuide(true)}
        onAnalyzeLastGame={() => {
          setMatchAutoLatest(true);
          setShowMatch(true);
        }}
      />

      <CountersSection
        matchups={matchups}
        heroes={heroes}
        enemies={enemies}
        enemyNames={enemyNames}
        toggleEnemy={toggleEnemy}
        onRemoveEnemy={(id) => setEnemies((e) => e.filter((x) => x !== id))}
        onOpenPicker={() => setPalette("enemies")}
        onOpenGuide={() => setShowGuide(true)}
        matrixRef={matrixRef}
      />

      {((loading && !build) || (!items && !error)) && (
        <LoadingState
          items={items}
          label={
            items
              ? `Crunching ${hero?.name ?? "match"} data…`
              : "Loading game assets…"
          }
        />
      )}

      {shownBuild && (
        <PhaseColumns
          shownBuild={shownBuild}
          items={items}
          counterByItem={counterByItem}
          countersByPhase={countersByPhase}
          buildItemIds={buildItemIds}
          enemiesById={enemiesById}
          imbueByItem={imbueByItem}
          trendingByItem={trendingByItem}
          wpStats={wpStats}
          labOf={labOf}
          buildRef={buildRef}
        />
      )}

      <Footer onOpenGuide={() => setShowGuide(true)} />

      <AppModals
        palette={palette}
        paletteCommands={paletteCommands}
        onRunPalette={runPaletteAction}
        onClosePalette={() => {
          setPalette(null);
          // Flush a committed item jump only now: the palette dialog scroll-freezes the page,
          // so the scroll must wait for the unmount (and its overflow cleanup) to land.
          const jump = pendingJump.current;
          pendingJump.current = null;
          if (jump !== null) setTimeout(() => flashItemRow(jump), 50);
        }}
        whyItem={whyItem}
        whyVerdict={whyVerdict}
        onCloseWhy={() => setWhyItem(null)}
        showGuide={showGuide}
        onCloseGuide={() => setShowGuide(false)}
        showLab={showLab}
        heroId={heroId}
        onCloseLab={() => setShowLab(false)}
        showMatch={showMatch}
        accountId={accountId}
        heroes={heroes}
        matchAutoLatest={matchAutoLatest}
        lastHeroMatchId={lastHeroMatchId}
        onCloseMatch={() => setShowMatch(false)}
        build={build}
        displayBuild={displayBuild}
        hero={hero}
        archetypeSet={archetypeSet}
        activeArchetype={activeArchetype}
        patchLabel={patchLabel}
        skillBuild={skillBuild}
        imbueByItem={imbueByItem}
        steamId={steamId}
        setSteamId={setSteamId}
        showExport={showExport}
        onCloseExport={() => setShowExport(false)}
        showShare={showShare}
        liveUrlState={liveUrlState}
        enemies={enemies}
        fundamentalsRows={fundamentals?.rows}
        onCloseShare={() => setShowShare(false)}
      />
    </div>
  );
}

/** Root component: the query provider around the page. PersistQueryClientProvider (rather than a
 * plain QueryClientProvider) restores the persisted asset cache before any query fires, so a warm
 * session paints heroes/items without a network round trip (see queryClient.ts). Wrapping here —
 * not in main.tsx — keeps the provider with the app itself, so tests render <App /> unchanged. */
export default function App() {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={persistOptions}
    >
      <AppInner />
    </PersistQueryClientProvider>
  );
}
