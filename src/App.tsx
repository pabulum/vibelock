import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import "./App.css";
import { persistOptions, queryClient } from "./queryClient";
import {
  abilityListQueryOptions,
  getAbilityOrder,
  getCommunityBuilds,
  getHeroBuildStats,
  getHeroCounters,
  getHeroLadderStats,
  getItemFlowStats,
  getItemPermutationStats,
  getItemStats,
  getMatchMetadata,
  getPlayerHeroStats,
  getPlayerMatchHistory,
  getPlayerMetrics,
  getPlayerRankTier,
  heroesQueryOptions,
  itemListQueryOptions,
  patchesQueryOptions,
  searchSteamPlayers,
  type SteamPlayerMatch,
  type TimeWindow,
} from "./api/deadlock";
import { assembleArchetypes, pickSignatures } from "./lib/archetypes";
import { phaseTempo, rerankBuildForComp, SLOT_CAP } from "./lib/buildGenerator";
import { matchCommunityBuilds } from "./lib/communityBuilds";
import { computeItemCounters } from "./lib/counters";
import { friendlyError } from "./lib/errors";
import {
  decodeUrlState,
  encodeUrlState,
  slugify,
  type UrlState,
} from "./lib/urlState";
import { blendFlow, blendItemStats, PRIOR_WINDOW_S } from "./lib/patchBlend";
import {
  findAdoptionMovers,
  findPatchMovers,
  foldTrendingBreakouts,
} from "./lib/patchMovers";
import {
  climbAdvice,
  fundamentalsRows,
  recentWindow,
  RECENT_GAMES_DEFAULT,
} from "./lib/fundamentals";
import { buildJointGamesLookup } from "./lib/pairs";
import { buildSynergyLookup, singleRecordsFromFlow } from "./lib/synergy";
import { bestImbueTargets } from "./lib/imbue";
import {
  benchmarkEconomy,
  economyRows,
  heroFarmProfile,
} from "./lib/matchAnalysis";
import { heroAccent } from "./lib/heroAccent";
import { heroMatchups } from "./lib/matchups";
import {
  buildPaletteCommands,
  IS_MAC,
  type PaletteAction,
  type PaletteMode,
} from "./lib/palette";
import {
  bandForTier,
  climbBand,
  RANK_TIERS,
  rankBandLabel,
  rankFloorLabel,
  rankSelLabel,
  rankSelToBadges,
  tierOf,
  tierToMaxBadge,
  tierToMinBadge,
  type RankSel,
} from "./lib/ranks";
import { bestSkillBuild } from "./lib/skills";
import { parseSteamInput, parseVanityName } from "./lib/steamId";
import { useSettle } from "./hooks";
import { CommandPalette } from "./components/CommandPalette";
import { CommunityRow } from "./components/CommunityRow";
import { ExportPanel } from "./components/ExportPanel";
import { EconomyPanel, type LastGameFarm } from "./components/EconomyPanel";
import { GuideModal } from "./components/GuideModal";
import { LabModal } from "./components/LabModal";
import { MatchModal } from "./components/MatchModal";
import { wpStatsQueryOptions, type WpStats } from "./api/wpStats";
import { ScrubWrap, TimeScrubber } from "./components/TimeScrubber";
import { phaseAtS, timelineAt } from "./lib/timeline";
import { CounterAddRow, ItemRow } from "./components/ItemRow";
import { CAN_HOVER } from "./components/usePinnablePopover";
import {
  CategoryBar,
  CounterPicker,
  LoadingState,
  MatchupChip,
  OvertimeColumn,
  PhaseTempoLines,
  ShuffleMark,
  SkillEmpty,
  SkillOrder,
} from "./components/panels";
import type {
  ArchetypeKey,
  BuildItem,
  BuildPhase,
  ItemCounters,
  ItemRef,
  Hero,
  HeroLadderStat,
  ImbueTarget,
  ItemStat,
  Patch,
  PlayerHeroStat,
  MatchHistoryRow,
} from "./types";

const COUNTER_ADDS_PER_PHASE = 3; // cap on counter-only picks folded into a phase's swaps

/** Runs a hero/rank switch inside a view transition, so the identity swap (portrait, phase
 * columns — the elements carrying `view-transition-name`s) cross-fades instead of popping.
 * This *composes with* the settle veil rather than replacing it: the transition covers the
 * instant, synchronous part of the switch (the ~250ms snapshot cross-fade), while the veil
 * still arms afterwards for the async part (the re-bake) and pulses when the data lands.
 * Straight call-through when unsupported or when the user prefers reduced motion. */
function switchTransition(update: () => void) {
  if (
    !document.startViewTransition ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    update();
    return;
  }
  // flushSync so the DOM is fully updated inside the transition's capture callback.
  document.startViewTransition(() => flushSync(update));
}

/** Fundamentals rows the "Combat & survival" card still shows. Everything soul-shaped moved to the
 * Economy panel (souls/min as its headline; last hits / jungle / denies replaced by the real
 * per-source breakdown), so what's left here is staying alive and what you do in a fight. */
const COMBAT_KEYS = new Set(["deaths", "player_damage_per_min", "accuracy"]);

// Stable empty fallbacks for asset queries that haven't resolved — fresh [] per render would
// re-fire every effect and memo that lists them as a dep.
const NO_HEROES: Hero[] = [];
const NO_PATCHES: Patch[] = [];

/** The core pick a counter item should swap in for: the weakest same-slot core item for this
 * comp (lowest comp-aware score) — the one to drop to make room. */
function swapTargetFor(
  phase: BuildPhase,
  c: ItemCounters,
  baseline: number,
): ItemRef | undefined {
  // Only a non-staple core pick is a fair thing to drop for an experimental counter.
  const slotCore = phase.core.filter(
    (b) => b.item.slot === c.item.slot && b.role !== "universal",
  );
  if (!slotCore.length) return undefined;
  const sc = (b: BuildItem) =>
    (b.compEdge ?? 0) + (b.adjustedWinRate - baseline);
  const worst = slotCore.reduce((w, b) => (sc(b) < sc(w) ? b : w));
  return { id: worst.item.id, name: worst.item.name };
}

/** Time window for a chosen patch index. Patches are newest-first. */
// Midpoint of each flow column's fixed time window (Lane 0–9, Early mid 9–20, Mid 20–30, 30+) —
// where the phase's "typical lead ≈ X% win" note reads the baked WP surface.
const PHASE_MID_S = [270, 870, 1500, 2100];

/** What a typical (one-sigma) team soul lead is worth at this phase's midpoint, from the Lab's
 * win-probability model: the per-phase answer to "do leads even matter yet?". Null when the
 * surface has no bin for the time (shouldn't happen — bins cover 0–∞). */
function leadNote(
  wp: WpStats,
  col: number,
): { souls: number; pct: number } | null {
  const t = PHASE_MID_S[col] ?? PHASE_MID_S[PHASE_MID_S.length - 1];
  const bin = wp.wpModel.find(
    (b) => t >= b.fromS && (b.toS === null || t < b.toS),
  );
  if (!bin) return null;
  return {
    souls: bin.sigma,
    pct: Math.round(100 / (1 + Math.exp(-(bin.w0 + bin.w1)))),
  };
}

/** Compact souls figure for the lead note: 1199 → "1.2k", 12304 → "12k". */
function fmtSouls(s: number): string {
  return s >= 10000 ? `${Math.round(s / 1000)}k` : `${(s / 1000).toFixed(1)}k`;
}

// Style hint (Lab): the WR-residual of closing power — what's left after "good heroes win" is
// accounted for (raw closing tracks hero WR at r≈0.93, which the chip already shows). Positive
// ⇒ converts even games; negative ⇒ wins ride on soul leads (snowballer). Only a clear signal
// (1.5pt+, well past the split-half noise) gets a hint — most heroes stay quiet.
const STYLE_NOTE = 0.015;

function closingHint(resid: number | undefined): string {
  if (resid === undefined || Math.abs(resid) < STYLE_NOTE) return "";
  const pt = `${resid > 0 ? "+" : "−"}${Math.abs(resid * 100).toFixed(1)}pt`;
  return resid > 0
    ? ` · style: converts even games (${pt} beyond its win rate) — a rough lane isn't fatal, grind it out`
    : ` · style: snowball hero (${pt} vs its win rate) — wins ride on soul leads, force your advantage early`;
}

function closingGlyph(resid: number | undefined) {
  if (resid === undefined || Math.abs(resid) < STYLE_NOTE) return null;
  return (
    <span className={`closer ${resid > 0 ? "up" : "down"}`} aria-hidden="true">
      {resid > 0 ? "⏱" : "⚡"}
    </span>
  );
}

function windowFor(patches: Patch[], idx: number): TimeWindow {
  if (!patches[idx]) return {};
  return {
    minUnixTimestamp: patches[idx].ts,
    maxUnixTimestamp: idx > 0 ? patches[idx - 1].ts : undefined,
  };
}

/** The borrow window that backfills a young patch: the month *before* the patch dropped. This is
 * where the old "Last 30 days" default went — instead of mixing patches at full weight, the
 * pre-patch month enters the build as a capped, drift-discounted prior (see lib/patchBlend). */
function priorWindowFor(patches: Patch[], idx: number): TimeWindow {
  if (!patches[idx]) return {};
  return {
    minUnixTimestamp: patches[idx].ts - PRIOR_WINDOW_S,
    maxUnixTimestamp: patches[idx].ts,
  };
}

function AppInner() {
  // Selection parsed once from the URL on first load (a deep link), via a lazy initializer so it's
  // computed a single time and stays stable. Consumed by the deep-link effect and the first build
  // as the data each field needs arrives, then the URL flips to a write-only mirror of state (see
  // the replaceState effect).
  const [url0] = useState<UrlState>(() =>
    decodeUrlState(window.location.search),
  );
  // Whether the URL's archetype has been honored yet — only on the first build of the linked hero;
  // after that, switching hero falls back to the best-win-rate archetype as usual.
  const urlArchApplied = useRef(false);

  // ---- Assets (persisted queries; see api/deadlock.ts + queryClient.ts) ----
  const heroesQ = useQuery(heroesQueryOptions);
  const itemListQ = useQuery(itemListQueryOptions);
  const patchesQ = useQuery(patchesQueryOptions);
  const abilitiesQ = useQuery(abilityListQueryOptions);
  const heroes = heroesQ.data ?? NO_HEROES;
  const patches = patchesQ.data ?? NO_PATCHES;
  const items = useMemo(
    () =>
      itemListQ.data ? new Map(itemListQ.data.map((i) => [i.id, i])) : null,
    [itemListQ.data],
  );
  const abilities = useMemo(
    () =>
      abilitiesQ.data ? new Map(abilitiesQ.data.map((a) => [a.id, a])) : null,
    [abilitiesQ.data],
  );
  // Restored-from-storage patches count as ready; only a truly cold load holds the
  // patch-windowed queries below until the feed answers (or degrades to []).
  const patchesReady = !patchesQ.isPending;

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
  const [enemies, setEnemies] = useState<number[]>([]);

  const [archKey, setArchKey] = useState<ArchetypeKey>("all");
  const [showGuide, setShowGuide] = useState(false);
  const [showLab, setShowLab] = useState(false);
  // Game-clock scrubber (prototype, off by default): scrubT is the scrubbed game second.
  const [scrubOn, setScrubOn] = useState(false);
  const [scrubT, setScrubT] = useState(600);
  const [showMatch, setShowMatch] = useState(false);
  // Whether the match modal should open onto the player's most recent game (the "analyze last game"
  // link) vs the blank recent-games list (the header "Match" button).
  const [matchAutoLatest, setMatchAutoLatest] = useState(false);
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
  const [showExport, setShowExport] = useState(false);

  // Steam identity — the single source shared by the header profile control and the export panel
  // (author stamp), persisted locally. Accepts an account id, a steamID64, or a profile URL
  // (lib/steamId converts on sight); a non-parsing value is treated as a name for the search
  // popover. Only public profile data is ever read with it.
  const [steamId, setSteamId] = useState(
    () => localStorage.getItem("vibelock-steam-id") ?? "",
  );
  const accountId = parseSteamInput(steamId);
  const [steamMatches, setSteamMatches] = useState<SteamPlayerMatch[] | null>(
    null,
  );
  // How many recent games the fundamentals card reads. Scoping by *games* (not days) is what keeps a
  // long break out of the average — see lib/fundamentals.recentWindow. Default small: right after a
  // session you want your *current* form, not an average dragged back weeks.
  const [recentGames, setRecentGames] = useState(RECENT_GAMES_DEFAULT);
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

  // Command palette (Ctrl/⌘+K, or the header/counter-picker buttons): 'all' = every control,
  // 'enemies' = scoped to enemy toggles as the counter picker's search-and-browse.
  const [palette, setPalette] = useState<PaletteMode | null>(null);

  useEffect(() => {
    const v = steamId.trim();
    if (parseSteamInput(v) !== null)
      localStorage.setItem("vibelock-steam-id", v);
    else if (v === "") localStorage.removeItem("vibelock-steam-id");
  }, [steamId]);

  // A pasted vanity URL (steamcommunity.com/id/<name>) can't be converted arithmetically — resolve
  // it through the name search automatically (debounced past the paste) and offer the matches.
  useEffect(() => {
    const vanity = parseVanityName(steamId);
    if (!vanity) return;
    const t = setTimeout(async () => {
      setSteamMatches(await searchSteamPlayers(vanity).catch(() => []));
    }, 350);
    return () => clearTimeout(t);
  }, [steamId]);

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

  // Player profile: top heroes for the quick-pick row, and their current rank to pre-select the
  // floor. Both fetches fail soft (bad/empty account ⇒ no row, no rank) so a typo in the id never
  // trips the main error banner.
  const profileQ = useQuery({
    queryKey: ["profile", accountId],
    enabled: accountId !== null,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const [stats, rankTier] = await Promise.all([
        getPlayerHeroStats(accountId!).catch(() => [] as PlayerHeroStat[]),
        getPlayerRankTier(accountId!).catch(() => null),
      ]);
      // Wall-clock is only legal here (render must stay pure) — the recency gate below anchors
      // to when the profile was fetched, which is also the more honest "now" for it.
      return { stats, rankTier, fetchedAtS: Date.now() / 1000 };
    },
  });
  const profile = accountId !== null ? (profileQ.data ?? null) : null;

  // Most-played pool, gated to the last 90 days when possible — meta and rust make all-time
  // mains a worse default; fall back to all-time when the account's been away.
  const heroPool = useMemo(() => {
    if (!profile || heroes.length === 0) return null;
    const RECENT_S = 90 * 86400;
    const nowS = profile.fetchedAtS;
    const withHero = profile.stats
      .map((s) => ({ s, hero: heroes.find((h) => h.id === s.hero_id) }))
      .filter(
        (x): x is { s: PlayerHeroStat; hero: Hero } => x.hero !== undefined,
      );
    const recent = withHero.filter((x) => nowS - x.s.last_played < RECENT_S);
    return (recent.length >= 3 ? recent : withHero)
      .sort((a, b) => b.s.matches_played - a.s.matches_played)
      .slice(0, 6)
      .map((x) => ({
        hero: x.hero,
        matches: x.s.matches_played,
        wins: x.s.wins,
      }));
  }, [profile, heroes]);
  // Heroes the profile already plays meaningfully — the exclusion set for "worth picking up".
  const playedHeroIds = useMemo(
    () =>
      profile
        ? new Set(
            profile.stats
              .filter((s) => s.matches_played >= 10)
              .map((s) => s.hero_id),
          )
        : null,
    [profile],
  );
  // The profile's current tier, kept so the dropdown can offer its "around my rank" band option.
  const profileTier = profile?.rankTier ?? null;
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

  // Ladder-wide hero win rates for the selected rank/patch, backfilled on a young patch exactly
  // like items are — hero rows quack enough like ItemStat that the same power-prior blend applies.
  const heroMetaQ = useQuery({
    queryKey: ["heroMeta", { minBadge, maxBadge }, dataWindow, priorKey],
    // Only wanted once a profile is set — but keyed rank/patch-only, so it's shared across accounts.
    enabled: accountId !== null && !!items && patchesReady,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const [f, q] = await Promise.all([
        getHeroLadderStats({ minBadge, maxBadge, ...dataWindow }),
        canBackfill
          ? getHeroLadderStats({ minBadge, maxBadge, ...priorWin })
          : Promise.resolve([] as HeroLadderStat[]),
      ]);
      const toItemStat = (r: HeroLadderStat): ItemStat => ({
        item_id: r.hero_id,
        wins: r.wins,
        losses: r.losses,
        matches: r.matches,
        players: r.matches,
        avg_buy_time_s: 0,
        avg_sell_time_s: 0,
      });
      const rows =
        q.length > 0
          ? blendItemStats(f.map(toItemStat), q.map(toItemStat)).stats
          : f.map(toItemStat);
      return new Map(
        rows.map((r) => {
          const n = r.wins + r.losses;
          return [
            r.item_id,
            { winRate: n > 0 ? r.wins / n : 0.5, decided: n },
          ] as const;
        }),
      );
    },
  });
  const heroMeta = accountId !== null ? (heroMetaQ.data ?? null) : null;

  // The your-heroes row, what-to-queue ordered. Pool = your most-played heroes, gated to the last
  // 90 days when possible (meta and rust make all-time mains a worse default). Each gets an
  // *expected win rate tonight*: your record on the hero shrunk toward the hero's current ladder
  // rate at this rank/patch, with the ladder prior worth PROFILE_PRIOR_GAMES of evidence — a
  // 20-game one-trick still mostly reads as the ladder, a 300-game main mostly as you. Chips order
  // by that number, so the row answers "what should I queue" rather than "what have I played".
  const topHeroes = useMemo(() => {
    if (!heroPool) return null;
    const PROFILE_PRIOR_GAMES = 20;
    const rows = heroPool.map((x) => {
      const winRate = x.matches > 0 ? x.wins / x.matches : 0;
      const meta = heroMeta?.get(x.hero.id);
      const expected = meta
        ? (x.wins + PROFILE_PRIOR_GAMES * meta.winRate) /
          (x.matches + PROFILE_PRIOR_GAMES)
        : undefined;
      return { hero: x.hero, matches: x.matches, winRate, meta, expected };
    });
    if (rows.some((r) => r.expected !== undefined))
      rows.sort((a, b) => (b.expected ?? 0) - (a.expected ?? 0));
    return rows;
  }, [heroPool, heroMeta]);

  // "Worth picking up": the strongest ladder heroes at this rank/patch that the profile doesn't
  // already play. Learning a hero costs real win rate for the first games (the literature's
  // hero-switching tax), so the shown number is the hero's current rate minus that tax — the
  // honest "expected while learning". The tax scales with rank: unfamiliarity is punished harder
  // the better the lobby (a heuristic in the literature's direction, not fitted — our aggregate
  // data can't split games by per-hero experience), so picking someone up is cheapest exactly
  // where it feels cheapest, at the lower tiers.
  const NEW_HERO_TAX = 0.015 + 0.0015 * tierAnchor; // 1.5pt at the bottom → ~3.2pt at Eternus
  const tryHeroes = useMemo(() => {
    if (!heroMeta || !playedHeroIds || !heroPool) return null;
    const out: Array<{ hero: Hero; metaWinRate: number; taxed: number }> = [];
    for (const [id, m] of heroMeta) {
      if (playedHeroIds.has(id) || m.decided < 200) continue;
      const h = heroes.find((x) => x.id === id);
      if (!h) continue;
      out.push({
        hero: h,
        metaWinRate: m.winRate,
        taxed: m.winRate - NEW_HERO_TAX,
      });
    }
    // Only suggest heroes still worth it after the tax — a coin flip isn't a recommendation.
    return out
      .filter((x) => x.taxed > 0.5)
      .sort((a, b) => b.metaWinRate - a.metaWinRate)
      .slice(0, 2);
  }, [heroMeta, playedHeroIds, heroPool, heroes, NEW_HERO_TAX]);

  // Fundamentals benchmark: my typical game vs the ladder at this rank floor. The metrics that
  // actually separate ranks are farm and deaths (see lib/fundamentals), so this is the "what do I
  // fix to climb" card. The ladder slice spans the pre-patch month too when backfill is on — the
  // distributions drift slowly and a day-one window alone is too thin to grid percentiles from.
  const fundamentalsQ = useQuery({
    queryKey: [
      "fundamentals",
      accountId,
      heroId,
      rankSel,
      dataWindow,
      priorKey,
      recentGames,
    ],
    enabled: accountId !== null && !!hero,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const ladderWindow = canBackfill
        ? {
            minUnixTimestamp: priorWin.minUnixTimestamp,
            maxUnixTimestamp: dataWindow.maxUnixTimestamp,
          }
        : dataWindow;
      // Scope MY side to my last N games on this hero. Without this the metrics endpoint applies its
      // own default (last 30 days), which on an occasionally-played hero is two or three games — and
      // for a player returning from a break it would happily average in a year-old version of them.
      const history = await getPlayerMatchHistory(accountId!).catch(
        () => [] as MatchHistoryRow[],
      );
      const heroWin = recentWindow(history, hero!.id, recentGames);

      // Benchmark against the rank you're CLIMBING TO (one tier up), not your own peers — the card
      // answers "how do I rank up", and your own-rank players are where you already are.
      const climb = climbBand(tierOf(rankSel));
      const benchmarkLabel = rankBandLabel(climb.lo, climb.hi);
      const climbBadges = {
        minBadge: tierToMinBadge(climb.lo),
        maxBadge: tierToMaxBadge(climb.hi),
      };

      const [me, ladder] = await Promise.all([
        getPlayerMetrics({
          accountIds: [accountId!],
          heroId: hero!.id,
          ...(heroWin ? { minUnixTimestamp: heroWin.minUnixTimestamp } : {}),
        }).catch(() => ({})),
        getPlayerMetrics({
          heroId: hero!.id,
          ...climbBadges,
          ...ladderWindow,
        }).catch(() => ({})),
      ]);
      let rows = heroWin ? fundamentalsRows(me, ladder) : [];
      let heroScoped = true;
      let usedWindow = heroWin;
      if (rows.length === 0) {
        // Too few recent games on this hero — benchmark the account's recent all-hero play instead.
        const allWin = recentWindow(history, null, recentGames);
        const meAll = await getPlayerMetrics({
          accountIds: [accountId!],
          ...(allWin ? { minUnixTimestamp: allWin.minUnixTimestamp } : {}),
        }).catch(() => ({}));
        rows = fundamentalsRows(meAll, ladder);
        heroScoped = false;
        usedWindow = allWin;
      }
      // "Your fundamentals" benchmark rows (lib/fundamentals) — your recent games on this hero
      // placed on the selected ladder's percentile distributions. heroScoped=false ⇒ too few recent
      // games on this hero, so the account's all-hero history stands in. `window` records what was
      // actually measured, so the card can say so; `benchmarkLabel` is the climb target, one tier up.
      return rows.length
        ? { rows, heroScoped, window: usedWindow, benchmarkLabel }
        : null;
    },
  });
  const fundamentals =
    accountId !== null && hero ? (fundamentalsQ.data ?? null) : null;

  // The Economy panel owns the soul story now, so souls/min is its headline rather than a combat row.
  // last_hits / neutral_damage / denies aren't displayed anywhere any more — the per-source breakdown
  // says the same thing with real soul numbers instead of the metrics endpoint's damage proxies — but
  // they stay in `fundamentals.rows` so climbAdvice can still raise farm tips from them.
  const soulsPerMinRow =
    fundamentals?.rows.find((r) => r.key === "net_worth_per_min") ?? null;
  const combatRows =
    fundamentals?.rows.filter((r) => COMBAT_KEYS.has(r.key)) ?? [];

  // Last-game overlay for the Soul income card: your most recent game on this hero, its per-source
  // souls placed on the same population grid the card shows. Cached-first (getMatchMetadata never
  // spends Steam budget here) and fully best-effort — a not-yet-ingested game, a missing account, or
  // a hero/rank without baked norms all just leave the card population-only.
  const lastGameQ = useQuery({
    queryKey: [
      "lastGame",
      accountId,
      heroId,
      tierOf(rankSel),
      wpStats?.generatedAt ?? null,
    ],
    enabled: accountId !== null && !!hero,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<{
      farm: LastGameFarm | null;
      matchId: number | null;
    }> => {
      const history = await getPlayerMatchHistory(accountId!).catch(
        () => [] as MatchHistoryRow[],
      );
      // History is newest-first, so the first match on this hero is the latest one.
      const last = history.find((r) => r.hero_id === hero!.id);
      const matchId = last?.match_id ?? null;
      if (!last || !wpStats) return { farm: null, matchId };
      // Cached-first: 404 (not ingested yet) throws and we simply show no overlay.
      const match = await getMatchMetadata(last.match_id).catch(() => null);
      const focus = match?.players.find((p) => p.account_id === accountId);
      if (!match || !focus) return { farm: null, matchId };
      const rows = benchmarkEconomy(
        economyRows(focus, match.duration_s),
        hero!.id,
        tierOf(rankSel),
        wpStats,
      );
      return {
        farm: {
          won: match.winning_team === focus.team,
          bySrc: new Map(
            rows.map((r) => [
              r.key,
              { perMin: r.perMin, percentile: r.percentile },
            ]),
          ),
        },
        matchId,
      };
    },
  });
  // Your last game on this hero, overlaid on the Economy card as a per-source rate. Null unless
  // you're linked and that game is ingested — the card is population-only otherwise.
  const lastGameFarm =
    accountId !== null && hero ? (lastGameQ.data?.farm ?? null) : null;
  // The match id of your most recent game on the SELECTED hero, or null if you've never played it.
  // Separate from lastGameFarm: that one also needs the match to be ingested and the rank baked,
  // whereas this only needs the game to exist — it's what "analyze your last <hero> game" opens.
  const lastHeroMatchId =
    accountId !== null && hero ? (lastGameQ.data?.matchId ?? null) : null;

  // Generate builds, split by archetype for flex heroes.
  const buildQ = useQuery({
    queryKey: [
      "build",
      heroId,
      { minBadge, maxBadge },
      rankLabel,
      dataWindow,
      priorKey,
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
        { synergyOf, jointGamesOf },
      );
      // Share of the build's win-rate evidence borrowed from the pre-patch window (see
      // lib/patchBlend): ~0.85 the day after a patch, fading to ~0 as the patch matures.
      // Surfaced in the meta line so "is this build trustworthy yet?" is a number, not a vibe.
      return {
        set,
        movers,
        adoption,
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
    const linked = url0.build;
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
  }, [buildQ.data, url0.build]);

  const activeArchetype =
    archetypeSet?.archetypes.find((a) => a.key === archKey) ??
    archetypeSet?.archetypes[0] ??
    null;
  const build = activeArchetype?.build ?? null;

  // Mirror the live selection into the URL (replaceState, so links stay shareable without spamming
  // history). Gated on a resolved hero so it can't overwrite the deep-link params before the
  // deep-link effect above has consumed them.
  useEffect(() => {
    if (!hero) return;
    const state: UrlState = {
      hero: slugify(hero.name),
      ...(typeof rankSel === "number" ? { tier: rankSel } : { band: rankSel }),
      patchTs: patches[patchIdx]?.ts,
      backfill: backfillOn,
      build: archKey,
      enemies: enemies
        .map((id) => heroes.find((h) => h.id === id)?.name)
        .filter((n): n is string => !!n)
        .map(slugify),
    };
    const url = `${window.location.pathname}${encodeUrlState(state)}${window.location.hash}`;
    window.history.replaceState(null, "", url);
  }, [hero, rankSel, patchIdx, patches, backfillOn, archKey, enemies, heroes]);

  // Reflect the selected hero — and its in-game role flavor line — in the tab title. Nice for
  // bookmarks and shared deep links. Falls back to the brand title while assets load, and to just
  // the name for heroes that have no role yet.
  useEffect(() => {
    document.title = hero
      ? `${hero.name} · Vibelock`
      : "Vibelock — data-driven Deadlock builds";
  }, [hero]);

  // Compute counters vs the chosen enemies.
  const countersQ = useQuery({
    queryKey: [
      "counters",
      heroId,
      enemies,
      { minBadge, maxBadge },
      dataWindow,
      priorKey,
    ],
    enabled: !!hero && !!items && enemies.length > 0,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const base = { heroId: hero!.id, minBadge, maxBadge };

      // One query per enemy (not a combined `any-of` query) so each item keeps a per-enemy
      // delta — that's what lets a row carry the portrait of the specific hero it answers.
      // With backfill on, each slice is fetched for both windows (all in parallel) and blended.
      // Counters need one rule beyond the build blend: a counter is a *difference* (item-vs-enemy
      // minus base), and if the two sides borrowed differently — a patch-changed item's big base
      // sample pulls fresh while its thin enemy slice stays anchored to pre-patch — the mismatch
      // reads as a fake counter. So the per-item discounts are learned on the base pair and shared
      // into every per-enemy blend (see blendItemStats).
      const slice = (enemyHeroIds?: number[]) =>
        canBackfill
          ? Promise.all([
              getItemStats({
                ...base,
                ...dataWindow,
                minMatches: 5,
                enemyHeroIds,
              }),
              getItemStats({ ...base, ...priorWin, enemyHeroIds }),
            ])
          : Promise.all([
              getItemStats({ ...base, ...dataWindow, enemyHeroIds }),
              Promise.resolve([] as ItemStat[]),
            ]);
      const [basePair, ...enemyPairs] = await Promise.all([
        slice(),
        ...enemies.map((id) => slice([id])),
      ]);

      let baseStats = basePair[0];
      let perEnemy = enemyPairs.map((pair, i) => ({
        enemyHeroId: enemies[i],
        stats: pair[0],
      }));
      if (canBackfill) {
        const baseBlend = blendItemStats(basePair[0], basePair[1]);
        baseStats = baseBlend.stats;
        perEnemy = enemyPairs.map((pair, i) => ({
          enemyHeroId: enemies[i],
          stats: blendItemStats(pair[0], pair[1], baseBlend).stats,
        }));
      }
      return computeItemCounters(baseStats, perEnemy, items!);
    },
  });
  const counters =
    enemies.length > 0 ? (countersQ.data?.counters ?? null) : null;
  const compEdges =
    enemies.length > 0 ? (countersQ.data?.edgeByItem ?? null) : null;

  // The counter matrix is hero-independent, so fetch once per rank/patch and filter by hero.
  const matrixQ = useQuery({
    queryKey: ["counterMatrix", { minBadge, maxBadge }, dataWindow],
    enabled: !!items && patchesReady,
    placeholderData: keepPreviousData,
    queryFn: () => getHeroCounters({ minBadge, maxBadge, ...dataWindow }),
  });
  const counterMatrix = matrixQ.data ?? null;

  const matchups = useMemo(
    () => (counterMatrix && hero ? heroMatchups(counterMatrix, hero.id) : null),
    [counterMatrix, hero],
  );

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

  const toggleEnemy = (id: number) =>
    setEnemies((e) =>
      e.includes(id) ? e.filter((x) => x !== id) : [...e, id],
    );

  // Ctrl/⌘+K opens the palette from anywhere (hijacked even inside inputs, the convention for
  // apps with palettes). Open-only: the toggle-close lives in the palette itself so its exit
  // transition plays. Ignored while another modal owns the top layer.
  const modalOpen = showGuide || showLab || showMatch || showExport;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      if (!modalOpen) setPalette((p) => p ?? "all");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen]);

  const paletteCommands = useMemo(
    () =>
      palette
        ? buildPaletteCommands(palette, {
            heroes,
            heroId,
            enemies,
            patches,
            patchIdx,
            rankSel,
            bandChoice,
          })
        : [],
    [palette, heroes, heroId, enemies, patches, patchIdx, rankSel, bandChoice],
  );
  // Commands carry data-only actions (lib/palette); this maps a committed one onto the same
  // handlers the header controls use. Runs only from the palette's commit events.
  const runPaletteAction = (a: PaletteAction) => {
    if (a.kind === "hero") pickHero(a.id);
    else if (a.kind === "rank") pickRank(a.sel);
    else if (a.kind === "patch") setPatchIdx(a.idx);
    else toggleEnemy(a.id);
  };

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
  // Counters folded into the build: a per-item lookup to tag build rows that answer this
  // comp (with the specific enemy portraits), plus a per-phase bucket (keyed by the same
  // labels buildGenerator uses) for strong counter picks not already in the build.
  const counterByItem = useMemo(() => {
    const m = new Map<number, ItemCounters>();
    for (const c of counters ?? []) m.set(c.item.id, c);
    return m;
  }, [counters]);
  // The plurality ability each imbue item gets imbued onto, from the hero's community builds —
  // surfaced as a tag on imbue items in the build (the most important choice for those items).
  const imbueByItem = useMemo(
    () =>
      community && abilities
        ? bestImbueTargets(community.builds, abilities, slotOrder)
        : new Map<number, ImbueTarget>(),
    [community, abilities, slotOrder],
  );
  const countersByPhase = useMemo(() => {
    const m = new Map<string, ItemCounters[]>();
    for (const c of counters ?? []) {
      const arr = m.get(c.phaseLabel);
      if (arr) arr.push(c);
      else m.set(c.phaseLabel, [c]);
    }
    return m;
  }, [counters]);
  // With a comp selected, re-rank the build for it: the comp decides which non-staples fill
  // each phase's core slots, the role labels, and the order (category counts + staples held).
  const displayBuild = useMemo(
    () =>
      build && compEdges && items && enemies.length > 0
        ? rerankBuildForComp(build, compEdges, items)
        : build,
    [build, compEdges, items, enemies.length],
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
  // Scrubber snapshot at the scrubbed minute (null = scrubber off): the core ids the plan expects
  // owned by then, the next buy, and the expected spend. Cheap (~50 rows), so no memo.
  const scrub = scrubOn && shownBuild ? timelineAt(shownBuild, scrubT) : null;

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
      <header className="topbar">
        <div className="brand">
          <ShuffleMark items={items} seed={shuffleSeed} />
          <span className="brandname">Vibelock</span>
          {hero?.tagline && <span className="tagline">{hero.tagline}</span>}
        </div>
        <div className="controls">
          <label>
            Hero
            <select
              value={heroId ?? ""}
              onChange={(e) => pickHero(Number(e.target.value))}
            >
              {heroes.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </label>
          <label className="rankctl">
            Rank
            <select
              value={typeof rankSel === "number" ? String(rankSel) : "band"}
              onChange={(e) =>
                pickRank(
                  e.target.value === "band" && bandChoice
                    ? bandChoice
                    : Number(e.target.value),
                )
              }
            >
              {bandChoice && (
                <option value="band">
                  Around my rank ({rankSelLabel(bandChoice)})
                </option>
              )}
              {[...RANK_TIERS].reverse().map((t) => (
                <option key={t.tier} value={t.tier}>
                  {rankFloorLabel(t.tier)}
                </option>
              ))}
            </select>
            {rankAutoSet && (
              <span className="autoset" key={rankAutoSet} aria-live="polite">
                set to {rankAutoSet} from your profile
              </span>
            )}
          </label>
          <label>
            Patch
            <select
              value={patchIdx}
              onChange={(e) => setPatchIdx(Number(e.target.value))}
            >
              {patches.length === 0 && (
                <option value={0}>Last 30 days (patch list unavailable)</option>
              )}
              {patches.map((p, i) => (
                <option key={p.ts} value={i}>
                  {p.title}
                  {i === 0 ? " (latest)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label
            className="checkctl"
            title="Pad a young patch's thin data with the 30 days before it, as a capped prior that fades out as the patch accumulates games (see How it works). Off = the selected window only."
          >
            Backfill
            <input
              type="checkbox"
              checked={backfillOn}
              onChange={(e) => setBackfillOn(e.target.checked)}
            />
          </label>
          <label
            className="checkctl"
            title="Prototype: a game-clock scrubber above the build. Drag to a minute to see what you should own by then, the expected soul spend, and what a typical lead is worth at that point."
          >
            Clock
            <input
              type="checkbox"
              checked={scrubOn}
              onChange={(e) => setScrubOn(e.target.checked)}
            />
          </label>
          <label
            className="idctl"
            title="Paste your Steam profile URL, steamID64, or the userdata/<id> number — or type a display name and press Enter to search. Unlocks the your-heroes quick-pick, pre-selects your rank, and signs exported builds. Stored only in this browser."
          >
            Steam ID
            <input
              placeholder="id, URL, or name…"
              value={steamId}
              onChange={(e) => {
                setSteamId(e.target.value);
                setSteamMatches(null);
              }}
              onKeyDown={async (e) => {
                // A value that doesn't parse as an id is a name or vanity URL — search on Enter.
                if (e.key !== "Enter") return;
                const q = steamId.trim();
                if (!q || parseSteamInput(q) !== null) return;
                const query = parseVanityName(q) ?? q;
                setSteamMatches(
                  await searchSteamPlayers(query).catch(() => []),
                );
              }}
              onBlur={() => setTimeout(() => setSteamMatches(null), 200)}
            />
            {steamMatches && (
              <div className="idresults">
                {steamMatches.length === 0 && (
                  <span className="idempty">no matches</span>
                )}
                {steamMatches.slice(0, 8).map((m) => (
                  <button
                    key={m.account_id}
                    type="button"
                    // mousedown, not click: the input's onBlur fires between mousedown and click
                    // and would unmount the list before a click could land.
                    onMouseDown={() => {
                      setSteamId(String(m.account_id));
                      setSteamMatches(null);
                    }}
                  >
                    {m.avatar && <img src={m.avatar} alt="" loading="lazy" />}
                    {m.personaname}
                    <i>#{m.account_id}</i>
                  </button>
                ))}
              </div>
            )}
          </label>
          <button
            type="button"
            className="guidebtn palbtn"
            onClick={() => setPalette("all")}
            title={`Command palette — switch hero, rank, or patch and add enemies (${IS_MAC ? "⌘K" : "Ctrl+K"})`}
          >
            {IS_MAC ? "⌘K" : "Ctrl+K"}
          </button>
          <button
            type="button"
            className="guidebtn"
            onClick={() => setShowGuide(true)}
            title="How these numbers are calculated"
          >
            How it works
          </button>
          <button
            type="button"
            className="guidebtn labbtn"
            onClick={() => setShowLab(true)}
            title="Experimental stats from whole-match data: closing power and state-adjusted item value"
          >
            Lab
          </button>
          <button
            type="button"
            className="guidebtn"
            onClick={() => {
              setMatchAutoLatest(false);
              setShowMatch(true);
            }}
            title="Post-game read of one match: win-probability trajectory, fundamentals vs the ladder, soul economy, deaths"
          >
            Match
          </button>
        </div>
        {busy && <div className="loadstrip" aria-hidden="true" />}
      </header>

      {error && <div className="banner error">⚠ {error}</div>}

      {movers && (
        <div className="movers" ref={moversRef}>
          <span
            className="lbl"
            title="Items whose win rate for this hero verifiably moved across the patch — every sufficiently-sampled item is tested between the pre- and post-patch windows, false discoveries are rate-controlled, and only ≥2pt moves make the list. New items appear once they have a real sample."
          >
            Patch movers
          </span>
          {movers.length === 0 && (
            <span className="mover none">
              none confident yet for {hero?.name ?? "this hero"} — early days
            </span>
          )}
          {movers.map((m) => (
            <span
              key={m.item.id}
              className={`mover${m.isNew ? " newitem" : m.delta > 0 ? " up" : " down"}`}
              title={
                m.isNew
                  ? `New this patch — ${(m.newWinRate * 100).toFixed(1)}% over ${Math.round(m.nNew)} decided games`
                  : `${(m.prevWinRate * 100).toFixed(1)}% → ${(m.newWinRate * 100).toFixed(1)}% (${Math.round(m.nPrev).toLocaleString()} → ${Math.round(m.nNew).toLocaleString()} decided games)`
              }
            >
              {m.item.name}{" "}
              <b>
                {m.isNew
                  ? "new"
                  : `${m.delta > 0 ? "▲" : "▼"}${(Math.abs(m.delta) * 100).toFixed(1)}`}
              </b>
            </span>
          ))}

          {adoption && adoption.length > 0 && (
            <>
              <span
                className="lbl trending"
                title="Emerging meta: items the player base is moving toward this patch (pick rate rising vs the pre-patch window). A ↑ breakout is rising AND winning above this hero's average — get ahead of it; a hype pick is rising but not (yet) paying off, so it's a caution, not a recommendation."
              >
                Trending
              </span>
              {adoption.map((a) => (
                <span
                  key={a.item.id}
                  className={`mover ${a.breakout ? "breakout" : "hype"}`}
                  title={`Pick rate ${(a.pickPrev * 100).toFixed(0)}% → ${(a.pickNew * 100).toFixed(0)}% (+${(a.pickDelta * 100).toFixed(0)}pt). Win rate ${(a.winRate * 100).toFixed(1)}% (${a.winEdge >= 0 ? "+" : ""}${(a.winEdge * 100).toFixed(1)} vs hero avg) over ${a.nNew.toLocaleString()} games. ${a.breakout ? "Rising and winning — a breakout." : "Rising but not beating the hero's average — being tried, not proven."}`}
                >
                  {a.item.name}{" "}
                  <b>
                    {a.breakout ? "↑" : "•"}
                    {(a.pickDelta * 100).toFixed(0)}pt
                  </b>
                </span>
              ))}
            </>
          )}
        </div>
      )}

      {topHeroes && topHeroes.length > 0 && (
        <div className="myheroes">
          <span
            className="lbl"
            title="Your most-played heroes (last 90 days when possible), ordered by expected win rate tonight: your own record on the hero, shrunk toward the hero's current ladder win rate at this rank and patch. You queue 3–4 and the game assigns one — take your picks from the left."
          >
            Your heroes
          </span>
          {topHeroes.map(({ hero: h, matches, winRate, meta, expected }) => (
            <button
              key={h.id}
              className={`chip${h.id === heroId ? " active" : ""}`}
              onClick={() => pickHero(h.id)}
              title={
                `you: ${Math.round(winRate * 100)}% over ${matches} matches` +
                (meta
                  ? ` · hero now: ${(meta.winRate * 100).toFixed(1)}% at this rank/patch · expected tonight ≈ ${Math.round((expected ?? 0) * 100)}%`
                  : "") +
                closingHint(labHeroes?.get(h.id))
              }
            >
              <img src={h.image} alt="" loading="lazy" />
              {h.name}
              {closingGlyph(labHeroes?.get(h.id))}
              {expected !== undefined && <i>{Math.round(expected * 100)}%</i>}
            </button>
          ))}
          {tryHeroes && tryHeroes.length > 0 && (
            <>
              <span
                className="lbl"
                title={`Strong at this rank/patch and not in your pool — a queue-slot candidate. The number is the hero's current ladder win rate minus a ~${(NEW_HERO_TAX * 100).toFixed(1)}pt new-hero tax (your first games on a hero run below your eventual rate; the tax grows with rank, so picking someone up is cheapest at lower tiers).`}
              >
                Worth picking up
              </span>
              {tryHeroes.map(({ hero: h, metaWinRate, taxed }) => (
                <button
                  key={h.id}
                  className={`chip try${h.id === heroId ? " active" : ""}`}
                  onClick={() => pickHero(h.id)}
                  title={`${(metaWinRate * 100).toFixed(1)}% at this rank/patch − ~${(NEW_HERO_TAX * 100).toFixed(1)}pt learning tax ≈ ${(taxed * 100).toFixed(1)}% while you pick them up${closingHint(labHeroes?.get(h.id))}`}
                >
                  <img src={h.image} alt="" loading="lazy" />
                  {h.name}
                  {closingGlyph(labHeroes?.get(h.id))}
                  <i>{Math.round(taxed * 100)}%</i>
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {build && (
        // Identity (face + name) comes from the live selection, NOT build.hero, so it swaps the
        // instant you pick a hero instead of lagging until the build query returns. The numbers
        // below are still the old hero's until then, so the block wears the settle scrim.
        <div className="meta" ref={metaRef}>
          {(hero ?? build.hero).image && (
            // The unmissable "you are looking at THIS hero" anchor — a friend read Abrams
            // numbers mid-match while playing someone else; a name alone is too quiet.
            // Named for the switch view transition: the portrait cross-fades in place.
            <img
              className="metaface"
              style={{ viewTransitionName: "hero-face" }}
              src={(hero ?? build.hero).image}
              alt=""
            />
          )}
          <div className="metabody">
            <div className="metatitle">
              {(hero ?? build.hero).name}
              {archetypeSet?.flex && activeArchetype && (
                <span className="metaarch">{activeArchetype.label}</span>
              )}
            </div>
            {build.rankLabel} · {patchLabel}
            {backfillLabel} · {build.population.matches.toLocaleString()}{" "}
            matches · avg game {Math.round(build.population.avgDurationS / 60)}{" "}
            min · {(build.population.baselineWinRate * 100).toFixed(0)}% avg WR
            (rows show ± vs this) ·{" "}
            <span
              className={
                (displayBuild ?? build).standingSlots > SLOT_CAP
                  ? "warn"
                  : undefined
              }
            >
              {(displayBuild ?? build).standingSlots}/{SLOT_CAP} standing slots
            </span>
            {lowPopulation && (
              <span className="warn"> · ⚠ low sample, treat as noisy</span>
            )}{" "}
            ·{" "}
            <button
              type="button"
              className="guidelink"
              onClick={() => setShowExport(true)}
              title="Add this build to your in-game build list so the shop guides you through it"
            >
              ⬇ Export to in-game build
            </button>
          </div>
        </div>
      )}

      {archetypeSet?.flex && (
        <div className="archetypes">
          <span className="lbl">Build style</span>
          {archetypeSet.archetypes.map((a) => (
            <button
              key={a.key}
              className={`archtab ${a.key === archKey ? "active" : ""}`}
              onClick={() => setArchKey(a.key)}
              title={
                a.signature
                  ? `players who built ${a.signature.name}`
                  : "every build, blended"
              }
            >
              <span className="atlabel">{a.label}</span>
              <span className="atmeta">
                {(a.winRate * 100).toFixed(0)}% WR ·{" "}
                {(a.share * 100).toFixed(0)}% of games
              </span>
            </button>
          ))}
        </div>
      )}

      {archetypeSet && <div className="identity">{archetypeSet.note}</div>}

      <div className="dash">
        {/* The flagship: your souls/min, where this hero's souls come from, and your last game on
            top of it. Shows whenever EITHER layer has data — the farm breakdown is baked per
            (hero, rank) and is still filling in, so souls/min must not vanish with it. */}
        {hero && (farmProfile || soulsPerMinRow) && (
          <EconomyPanel
            profile={farmProfile}
            heroName={hero.name}
            rankLabel={rankLabel}
            dataRankLabel={
              farmProfile ? rankFloorLabel(farmProfile.tier) : undefined
            }
            soulsPerMin={soulsPerMinRow}
            lastGame={lastGameFarm}
          />
        )}

        {fundamentals && hero && (
          <section
            className="fundamentals"
            ref={fundamentalsRef}
            title="Your average per game, placed on the distribution of games at this rank floor (percentile, higher = better; deaths inverted). Farm lives in the Economy panel; this is what's left — staying alive and what you do in fights."
          >
            <h2>
              Combat &amp; survival{" "}
              <span className="sub">
                {fundamentals.heroScoped ? hero.name : "all heroes"}
                {fundamentals.window && (
                  <>
                    ,{" "}
                    {fundamentals.window.games === 1
                      ? "last game"
                      : `last ${fundamentals.window.games} games`}{" "}
                    ({fundamentals.window.spanDays}d)
                  </>
                )}{" "}
                vs {fundamentals.benchmarkLabel}{" "}
                <span className="climbmark">climbing</span>
              </span>
              <select
                className="fundwin"
                value={recentGames}
                onChange={(e) => setRecentGames(Number(e.target.value))}
                onClick={(e) => e.stopPropagation()}
                aria-label="How many recent games to benchmark"
                title="How many of your recent games to read. Scoping by games (not days) keeps a long break — or an old, worse version of you — out of the average."
              >
                {[1, 5, 10, 20].map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? "last game" : `last ${n}`}
                  </option>
                ))}
              </select>
            </h2>
            <div className="fundrows">
              {combatRows.map((r) => (
                <div
                  className="fundrow"
                  key={r.key}
                  title={`ladder median: ${r.ladderMedian}`}
                >
                  <span className="flabel">{r.label}</span>
                  <span className="fval">{r.value}</span>
                  <span className="fbar">
                    <span
                      className={
                        r.percentile >= 75
                          ? "hi"
                          : r.percentile < 25
                            ? "lo"
                            : ""
                      }
                      style={{ width: `${r.percentile}%` }}
                    />
                  </span>
                  <span className="fpct">p{r.percentile}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {abilities && skillBuild ? (
          <SkillOrder
            skill={skillBuild}
            abilities={abilities}
            slotOrder={slotOrder}
            settleRef={skillRef}
          />
        ) : (
          hero && !skillLoading && <SkillEmpty />
        )}

        {communityMatch && (communityMatch.best || communityMatch.aligned) && (
          <section className="community" ref={communityRef}>
            <h2>
              Community check{" "}
              <span className="sub">player builds at {build?.rankLabel}</span>
            </h2>
            <div className="crows">
              {communityMatch.agree && communityMatch.best ? (
                <CommunityRow
                  tag="Top build = closest to ours ✓"
                  rb={communityMatch.best}
                  ourCoreIds={ourCoreIds}
                  ourSituIds={ourSituationalIds}
                  items={items}
                  abilities={abilities}
                  ourMaxOrder={ourMaxOrder}
                  slotOrder={slotOrder}
                  agree
                />
              ) : (
                <>
                  {communityMatch.best && (
                    <CommunityRow
                      tag="Best win rate"
                      rb={communityMatch.best}
                      ourCoreIds={ourCoreIds}
                      ourSituIds={ourSituationalIds}
                      items={items}
                      abilities={abilities}
                      ourMaxOrder={ourMaxOrder}
                      slotOrder={slotOrder}
                    />
                  )}
                  {communityMatch.aligned && (
                    <CommunityRow
                      tag="Most like ours"
                      rb={communityMatch.aligned}
                      ourCoreIds={ourCoreIds}
                      ourSituIds={ourSituationalIds}
                      items={items}
                      abilities={abilities}
                      ourMaxOrder={ourMaxOrder}
                      slotOrder={slotOrder}
                    />
                  )}
                </>
              )}
            </div>
            <p className="hint">
              {CAN_HOVER ? "Hover" : "Tap"} a build to see where it agrees with
              ours and where it differs; {CAN_HOVER ? "click" : "tap"}{" "}
              <code>#id</code> to copy it for the in-game search.{" "}
              <button
                type="button"
                className="guidelink"
                onClick={() => setShowGuide(true)}
              >
                What “% match”, core &amp; flex mean →
              </button>
            </p>
          </section>
        )}

        {/* "To climb" spans farm AND survival, so it's its own card rather than a corner of either
            panel. Last in the flow: the column packer drops it into whichever column has room,
            which keeps it compact instead of a page-wide band. */}
        {fundamentals && hero && (
          <section className="climbcard">
            <h2>To climb</h2>
            {(() => {
              // Reads the FULL row set — including the farm rows the Economy panel displays — so
              // farm advice survives those rows having moved out of the combat card.
              const tips = climbAdvice(
                fundamentals.rows,
                fundamentals.heroScoped ? hero.name : "these",
              );
              return tips.length === 0 ? (
                <p className="climbnote">
                  Your controllables are at or above the ladder here — play your
                  game.
                </p>
              ) : (
                tips.map((t) => (
                  <div className="climbtip" key={t.key}>
                    <span className="climbaction">{t.action}</span>
                    <span className="climbdetail">{t.detail}</span>
                  </div>
                ))
              );
            })()}
            <button
              type="button"
              className="lastgamelink"
              onClick={() => {
                setMatchAutoLatest(true);
                setShowMatch(true);
              }}
            >
              {lastHeroMatchId
                ? `Analyze your last ${hero.name} game →`
                : "Analyze your last game →"}
            </button>
          </section>
        )}
      </div>

      <div className="counters">
        {matchups &&
          (matchups.tough.length > 0 || matchups.favorable.length > 0) && (
            <div className="matchups" ref={matrixRef}>
              {matchups.tough.length > 0 && (
                <div className="mrow">
                  <span className="lbl tough">Tough vs</span>
                  {matchups.tough.map((m) => (
                    <MatchupChip
                      key={m.enemyHeroId}
                      m={m}
                      tough
                      hero={heroes.find((h) => h.id === m.enemyHeroId)}
                      active={enemies.includes(m.enemyHeroId)}
                      onClick={() => toggleEnemy(m.enemyHeroId)}
                    />
                  ))}
                </div>
              )}
              {matchups.favorable.length > 0 && (
                <div className="mrow">
                  <span className="lbl fav">Favored vs</span>
                  {matchups.favorable.map((m) => (
                    <MatchupChip
                      key={m.enemyHeroId}
                      m={m}
                      hero={heroes.find((h) => h.id === m.enemyHeroId)}
                      active={enemies.includes(m.enemyHeroId)}
                      onClick={() => toggleEnemy(m.enemyHeroId)}
                    />
                  ))}
                </div>
              )}
              <p className="hint">
                Click a hero to add it below and see what to build against it.{" "}
                <button
                  type="button"
                  className="guidelink"
                  onClick={() => setShowGuide(true)}
                >
                  How matchup rates work →
                </button>
              </p>
            </div>
          )}

        <CounterPicker
          heroes={heroes}
          enemies={enemies}
          onRemove={(id) => setEnemies((e) => e.filter((x) => x !== id))}
          onOpen={() => setPalette("enemies")}
        />
      </div>

      {enemies.length > 0 && (
        <p className="counters-note">
          The build below is re-ranked for {enemyNames}: picks that answer the
          comp rise and carry the enemy portrait (hover any row for the per-hero
          gain); picks that are weak into it are flagged{" "}
          <span className="weakcomp">▼</span>.{" "}
          <button
            type="button"
            className="guidelink"
            onClick={() => setShowGuide(true)}
          >
            How comp re-ranking works →
          </button>
        </p>
      )}

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
        <main className="phases" ref={buildRef}>
          {scrub && (
            <TimeScrubber
              build={shownBuild}
              wpStats={wpStats}
              t={scrubT}
              onScrub={setScrubT}
            />
          )}
          {shownBuild.phases.map((phase) => {
            // Strong counter picks that file under this phase but aren't already in the build
            // get mixed into the situational list (capped); ones already shown get a portrait
            // tag in place instead, so nothing is duplicated and the page doesn't sprout
            // separate counter sections.
            const counterAdds = (countersByPhase.get(phase.label) ?? [])
              .filter((c) => !buildItemIds.has(c.item.id))
              .slice(0, COUNTER_ADDS_PER_PHASE);
            const lead = wpStats ? leadNote(wpStats, phase.column) : null;
            return (
              <section
                className={
                  scrub && phaseAtS(scrubT) === phase.column
                    ? "phase scrub-now"
                    : "phase"
                }
                key={phase.column}
                // Named per column so a hero/rank switch cross-fades each column independently
                // inside the view transition (see switchTransition).
                style={{ viewTransitionName: `phase-${phase.column}` }}
              >
                <h2>
                  {phase.label} <span className="time">{phase.timeLabel}</span>
                </h2>
                <div className="budget">
                  {phase.itemsBought}/{phase.targetItems} items ·{" "}
                  {Math.round(phase.coreSouls).toLocaleString()} /{" "}
                  {Math.round(phase.soulBudget).toLocaleString()} souls
                  {lead && (
                    <span
                      className="wpnote"
                      title={`From the Lab's win-probability model (refit nightly): mid-phase, a team up ${lead.souls.toLocaleString()} souls — a typical lead for this stage — wins ~${lead.pct}% of its games. Leads barely convert in lane and peak past 25 minutes: the higher this number, the more a lead is worth protecting.`}
                    >
                      {" "}
                      · {fmtSouls(lead.souls)} lead ≈ {lead.pct}% win
                    </span>
                  )}
                </div>
                <CategoryBar split={phase.categorySouls} />

                <PhaseTempoLines
                  tempo={phaseTempo(
                    phase,
                    shownBuild.population.baselineWinRate,
                    labOf,
                  )}
                />

                <h3 className="grouphdr core">Build</h3>
                {phase.core.length ? (
                  phase.core.map((b) => (
                    <ScrubWrap key={b.item.id} scrub={scrub} id={b.item.id}>
                      <ItemRow
                        b={b}
                        items={items}
                        baseline={shownBuild.population.baselineWinRate}
                        counter={counterByItem.get(b.item.id)}
                        enemiesById={enemiesById}
                        imbue={imbueByItem.get(b.item.id)}
                        trending={trendingByItem.get(b.item.id)}
                        lab={labOf?.(b.item.id)}
                      />
                    </ScrubWrap>
                  ))
                ) : (
                  <p className="empty">No clear staple here.</p>
                )}

                <h3 className="grouphdr situational">Situational swaps</h3>
                {phase.situational.map((b) => (
                  <ScrubWrap key={b.item.id} scrub={scrub} id={b.item.id}>
                    <ItemRow
                      b={b}
                      items={items}
                      baseline={shownBuild.population.baselineWinRate}
                      counter={counterByItem.get(b.item.id)}
                      enemiesById={enemiesById}
                      imbue={imbueByItem.get(b.item.id)}
                      trending={trendingByItem.get(b.item.id)}
                      lab={labOf?.(b.item.id)}
                      muted
                    />
                  </ScrubWrap>
                ))}
                {counterAdds.map((c) => (
                  <CounterAddRow
                    key={c.item.id}
                    c={c}
                    items={items}
                    enemiesById={enemiesById}
                    swapFor={swapTargetFor(
                      phase,
                      c,
                      shownBuild.population.baselineWinRate,
                    )}
                  />
                ))}
                {phase.situational.length === 0 && counterAdds.length === 0 && (
                  <p className="empty">—</p>
                )}
              </section>
            );
          })}
          <OvertimeColumn
            build={shownBuild}
            items={items}
            counterByItem={counterByItem}
            enemiesById={enemiesById}
            imbueByItem={imbueByItem}
            labOf={labOf}
          />
        </main>
      )}

      <footer className="foot">
        Data:{" "}
        <a href="https://deadlock-api.com" target="_blank" rel="noreferrer">
          deadlock-api.com
        </a>
        .{" "}
        <button
          type="button"
          className="guidelink"
          onClick={() => setShowGuide(true)}
        >
          Methodology &amp; glossary →
        </button>
        <div className="disclaimer">
          Vibelock is a fan-made, unofficial tool. Not affiliated with, endorsed
          by, or sponsored by Valve. Deadlock and all related assets are
          trademarks of Valve Corporation.
        </div>
      </footer>

      {palette && (
        <CommandPalette
          commands={paletteCommands}
          placeholder={
            palette === "enemies"
              ? "Add or remove enemies — type, Enter, repeat…"
              : "Hero, rank, patch, or “vs enemy”…"
          }
          onRun={runPaletteAction}
          onClose={() => setPalette(null)}
        />
      )}

      {showGuide && <GuideModal onClose={() => setShowGuide(false)} />}
      {showLab && (
        <LabModal heroId={heroId} onClose={() => setShowLab(false)} />
      )}
      {showMatch && (
        <MatchModal
          accountId={accountId}
          heroes={heroes}
          autoLoadLatest={matchAutoLatest}
          autoLoadMatchId={lastHeroMatchId}
          onClose={() => setShowMatch(false)}
        />
      )}

      {showExport && build && (
        <ExportPanel
          build={displayBuild ?? build}
          skillOrder={skillBuild?.order}
          imbues={imbueByItem}
          name={`Vibelock — ${build.hero.name}${
            archetypeSet?.flex && activeArchetype
              ? ` · ${activeArchetype.label}`
              : ""
          } (${build.rankLabel})`}
          description={`Top-to-bottom build from Vibelock · ${build.rankLabel} · ${patchLabel} · ${build.population.matches.toLocaleString()} matches. Core phases + a Situational (optional) row; each item's note says why it's picked. Made with vibelock.`}
          steamId={steamId}
          onSteamIdChange={setSteamId}
          onClose={() => setShowExport(false)}
        />
      )}
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
