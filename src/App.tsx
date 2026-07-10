import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import {
  getAbilities,
  getAbilityOrder,
  getCommunityBuilds,
  getHeroBuildStats,
  getHeroCounters,
  getHeroes,
  getItemFlowStats,
  getItemPermutationStats,
  getItems,
  getHeroLadderStats,
  getItemStats,
  getPatches,
  getPlayerHeroStats,
  getPlayerMetrics,
  getPlayerRankTier,
  searchSteamPlayers,
  type SteamPlayerMatch,
  type TimeWindow,
} from "./api/deadlock";
import { assembleArchetypes, pickSignatures } from "./lib/archetypes";
import { phaseTempo, rerankBuildForComp, SLOT_CAP } from "./lib/buildGenerator";
import { matchCommunityBuilds } from "./lib/communityBuilds";
import { computeItemCounters, type CompEdge } from "./lib/counters";
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
  type AdoptionMover,
  type PatchMover,
} from "./lib/patchMovers";
import { fundamentalsRows, type FundamentalRow } from "./lib/fundamentals";
import { buildJointGamesLookup } from "./lib/pairs";
import { buildSynergyLookup, singleRecordsFromFlow } from "./lib/synergy";
import { bestImbueTargets } from "./lib/imbue";
import { heroMatchups } from "./lib/matchups";
import {
  bandForTier,
  RANK_TIERS,
  rankFloorLabel,
  rankSelLabel,
  rankSelToBadges,
  type RankSel,
} from "./lib/ranks";
import { bestSkillBuild } from "./lib/skills";
import { parseSteamInput, parseVanityName } from "./lib/steamId";
import { useAsyncTask, useSettle } from "./hooks";
import { CommunityRow } from "./components/CommunityRow";
import { ExportPanel } from "./components/ExportPanel";
import { GuideModal } from "./components/GuideModal";
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
  Ability,
  ArchetypeKey,
  ArchetypeSet,
  BuildItem,
  BuildPhase,
  CommunityBuild,
  ItemCounters,
  ItemRef,
  Hero,
  HeroBuildStatRow,
  HeroCounterRow,
  HeroLadderStat,
  ImbueTarget,
  ItemStat,
  Patch,
  PlayerHeroStat,
  Item,
  SkillBuild,
} from "./types";

const COUNTER_ADDS_PER_PHASE = 3; // cap on counter-only picks folded into a phase's swaps

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

export default function App() {
  // Selection parsed once from the URL on first load (a deep link), via a lazy initializer so it's
  // computed a single time and stays stable. Consumed by the asset-load and build effects below as
  // the data each field needs arrives, then the URL flips to a write-only mirror of state (see the
  // replaceState effect).
  const [url0] = useState<UrlState>(() =>
    decodeUrlState(window.location.search),
  );
  // Whether the URL's archetype has been honored yet — only on the first build of the linked hero;
  // after that, switching hero falls back to the best-win-rate archetype as usual.
  const urlArchApplied = useRef(false);

  const [heroes, setHeroes] = useState<Hero[]>([]);
  const [items, setItems] = useState<Map<number, Item> | null>(null);
  const [patches, setPatches] = useState<Patch[]>([]);
  const [heroId, setHeroId] = useState<number | null>(null);
  // Whether the player chose a hero deliberately (deep link or any click). Until then the
  // profile's most-played hero makes a better default than the alphabetical first (Abrams) —
  // "why am I looking at Abrams" mid-match confusion is real.
  const heroTouched = useRef(false);
  const pickHero = (id: number) => {
    heroTouched.current = true;
    setHeroId(id);
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
  // Experimental: line-aware generation (survivorship shrink on upgrades). Default off — see
  // BuildOptions.lineAware. A toggle so it can be A/B'd against the current build in the live app.
  const [lineAware, setLineAware] = useState<boolean>(false);
  const [enemies, setEnemies] = useState<number[]>([]);

  const [archetypeSet, setArchetypeSet] = useState<ArchetypeSet | null>(null);
  const [archKey, setArchKey] = useState<ArchetypeKey>("all");
  const [counterMatrix, setCounterMatrix] = useState<HeroCounterRow[] | null>(
    null,
  );
  const [abilities, setAbilities] = useState<Map<number, Ability> | null>(null);
  const [skillBuild, setSkillBuild] = useState<SkillBuild | null>(null);
  const [counters, setCounters] = useState<ItemCounters[] | null>(null);
  const [compEdges, setCompEdges] = useState<Map<number, CompEdge> | null>(
    null,
  );
  const [community, setCommunity] = useState<{
    builds: CommunityBuild[];
    stats: HeroBuildStatRow[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [showExport, setShowExport] = useState(false);
  // Share of the build's win-rate evidence borrowed from the pre-patch window (see lib/patchBlend):
  // ~0.85 the day after a patch, fading to ~0 as the patch matures. Surfaced in the meta line so
  // "is this build trustworthy yet?" is a number, not a vibe.
  const [backfill, setBackfill] = useState<number | null>(null);
  // "What changed this patch" — FDR-gated movers from the two item-stats windows the backfill
  // already fetches (needs both, so only computed while backfill is on).
  const [movers, setMovers] = useState<PatchMover[] | null>(null);
  // "Emerging meta" — items the player base is moving toward this patch (rising pick rate), split
  // into breakouts (rising *and* winning) and hype (rising but not paying off). Same two windows as
  // the WR movers, so no extra queries.
  const [adoption, setAdoption] = useState<AdoptionMover[] | null>(null);

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
  // The profile's most-played-hero pool (recency-gated in the fetch effect, where wall-clock time
  // is legal), joined with ladder meta in a memo below.
  const [heroPool, setHeroPool] = useState<Array<{
    hero: Hero;
    matches: number;
    wins: number;
  }> | null>(null);
  // Heroes the profile already plays meaningfully — the exclusion set for "worth picking up".
  const [playedHeroIds, setPlayedHeroIds] = useState<Set<number> | null>(null);
  // Every hero's blended ladder win rate at the selected rank/patch — the "meta strength" half of
  // the what-to-queue ordering on the your-heroes row. Only fetched when a profile is set.
  const [heroMeta, setHeroMeta] = useState<Map<
    number,
    { winRate: number; decided: number }
  > | null>(null);
  // "Your fundamentals" benchmark rows (lib/fundamentals) — your typical game on this hero placed
  // on the selected ladder's percentile distributions. heroScoped=false ⇒ the account had no games
  // on this hero, so the all-heroes history stands in (still your fundamentals, less specific).
  const [fundamentals, setFundamentals] = useState<{
    rows: FundamentalRow[];
    heroScoped: boolean;
  } | null>(null);
  // The profile's rank pre-selects the band only until the player picks a rank deliberately —
  // a deep-linked rank or a manual select always wins and is never overridden afterwards.
  const tierTouched = useRef(
    url0.tier !== undefined || url0.band !== undefined,
  );
  // The profile's current tier, kept so the dropdown can offer its "around my rank" band option.
  const [profileTier, setProfileTier] = useState<number | null>(null);

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

  // Load assets once, then apply any deep-link selection now that we can resolve slugs/timestamps.
  useEffect(() => {
    Promise.all([getHeroes(), getItems(), getPatches(), getAbilities()])
      .then(([h, i, p, a]) => {
        setHeroes(h);
        setItems(i);
        setPatches(p);
        setAbilities(a);
        if (h.length) {
          const idBySlug = new Map(h.map((x) => [slugify(x.name), x.id]));
          const linked = url0.hero ? idBySlug.get(url0.hero) : undefined;
          if (linked) heroTouched.current = true; // a deep-linked hero is a deliberate choice
          setHeroId(linked || h[0].id);
          if (url0.enemies?.length) {
            const ids = url0.enemies
              .map((s) => idBySlug.get(s))
              .filter((id): id is number => id !== undefined);
            if (ids.length) setEnemies(ids);
          }
        }
        if (url0.patchTs !== undefined) {
          const idx = p.findIndex((pt) => pt.ts === url0.patchTs);
          if (idx >= 0) setPatchIdx(idx);
        }
      })
      .catch((e) => setError(friendlyError(e)));
    // url0 is a stable ref value, read once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hero = useMemo(
    () => heroes.find((h) => h.id === heroId) ?? null,
    [heroes, heroId],
  );
  const { minBadge, maxBadge } = rankSelToBadges(rankSel);
  const rankLabel = rankSelLabel(rankSel);
  // Numeric anchor for rank-scaled heuristics (the new-hero learning tax): the floor tier, or a
  // band's midpoint.
  const tierAnchor =
    typeof rankSel === "number" ? rankSel : (rankSel.lo + rankSel.hi) / 2;
  // The band the Rank dropdown offers: the active one (a shared link's band survives even without
  // a matching profile), else the profile's own. No profile and no band ⇒ the option is hidden.
  const bandChoice =
    typeof rankSel === "object"
      ? rankSel
      : profileTier !== null
        ? bandForTier(profileTier)
        : null;

  // Player profile: top heroes for the quick-pick row, and their current rank to pre-select the
  // floor. Both fetches fail soft (bad/empty account ⇒ no row, no rank) so a typo in the id never
  // trips the main error banner.
  const profileLoading = useAsyncTask(
    async (signal) => {
      if (!accountId || heroes.length === 0) {
        setHeroPool(null);
        setPlayedHeroIds(null);
        return;
      }
      const [stats, rankTier] = await Promise.all([
        getPlayerHeroStats(accountId).catch(() => []),
        getPlayerRankTier(accountId).catch(() => null),
      ]);
      if (signal.aborted) return;
      // Most-played pool, gated to the last 90 days when possible — meta and rust make all-time
      // mains a worse default; fall back to all-time when the account's been away.
      const RECENT_S = 90 * 86400;
      const nowS = Date.now() / 1000;
      const withHero = stats
        .map((s) => ({ s, hero: heroes.find((h) => h.id === s.hero_id) }))
        .filter(
          (x): x is { s: PlayerHeroStat; hero: Hero } => x.hero !== undefined,
        );
      const recent = withHero.filter((x) => nowS - x.s.last_played < RECENT_S);
      const pool = (recent.length >= 3 ? recent : withHero)
        .sort((a, b) => b.s.matches_played - a.s.matches_played)
        .slice(0, 6)
        .map((x) => ({
          hero: x.hero,
          matches: x.s.matches_played,
          wins: x.s.wins,
        }));
      setHeroPool(pool);
      // Until the player picks a hero deliberately, their most-played hero is the honest default —
      // nobody wants to realize mid-match they've been reading Abrams numbers on another hero.
      if (!heroTouched.current && pool[0]) setHeroId(pool[0].hero.id);
      setPlayedHeroIds(
        new Set(
          stats.filter((s) => s.matches_played >= 10).map((s) => s.hero_id),
        ),
      );
      setProfileTier(rankTier);
      // Pre-select the profile's band, not a floor: match volume piles up at high-mid ranks, so a
      // below-the-mode floor is dominated by games well above the player — the capped band is
      // their actual neighborhood, tilted one rank into the climb.
      if (!tierTouched.current && rankTier !== null)
        setRankSel(bandForTier(rankTier));
    },
    [accountId, heroes],
    setError,
  );

  // Ladder-wide hero win rates for the selected rank/patch, backfilled on a young patch exactly
  // like items are — hero rows quack enough like ItemStat that the same power-prior blend applies.
  const heroMetaLoading = useAsyncTask(
    async (signal) => {
      if (!accountId || !items) {
        // `items` is just the assets-resolved marker here — by then the patch feed has loaded or
        // degraded to [], so the query below runs windowed or patch-less, never twice.
        setHeroMeta(null);
        return;
      }
      const canBackfill = backfillOn && patches.length > 0;
      const window = windowFor(patches, patchIdx);
      const [f, q] = await Promise.all([
        getHeroLadderStats({ minBadge, maxBadge, ...window }),
        canBackfill
          ? getHeroLadderStats({
              minBadge,
              maxBadge,
              ...priorWindowFor(patches, patchIdx),
            })
          : Promise.resolve([]),
      ]);
      if (signal.aborted) return;
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
      setHeroMeta(
        new Map(
          rows.map((r) => {
            const n = r.wins + r.losses;
            return [
              r.item_id,
              { winRate: n > 0 ? r.wins / n : 0.5, decided: n },
            ];
          }),
        ),
      );
    },
    [accountId, items, minBadge, maxBadge, patchIdx, patches, backfillOn],
    setError,
  );

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
  const fundamentalsLoading = useAsyncTask(
    async (signal) => {
      if (!accountId || !hero) {
        setFundamentals(null);
        return;
      }
      const window = windowFor(patches, patchIdx);
      const ladderWindow =
        backfillOn && patches.length > 0
          ? {
              minUnixTimestamp: priorWindowFor(patches, patchIdx)
                .minUnixTimestamp,
              maxUnixTimestamp: window.maxUnixTimestamp,
            }
          : window;
      const [me, ladder] = await Promise.all([
        getPlayerMetrics({ accountIds: [accountId], heroId: hero.id }).catch(
          () => ({}),
        ),
        getPlayerMetrics({
          heroId: hero.id,
          minBadge,
          maxBadge,
          ...ladderWindow,
        }).catch(() => ({})),
      ]);
      if (signal.aborted) return;
      let rows = fundamentalsRows(me, ladder);
      let heroScoped = true;
      if (rows.length === 0) {
        // No games on this hero — benchmark the account's overall fundamentals instead.
        const meAll = await getPlayerMetrics({
          accountIds: [accountId],
        }).catch(() => ({}));
        if (signal.aborted) return;
        rows = fundamentalsRows(meAll, ladder);
        heroScoped = false;
      }
      setFundamentals(rows.length ? { rows, heroScoped } : null);
    },
    [accountId, hero, minBadge, maxBadge, patchIdx, patches, backfillOn],
    setError,
  );

  // Generate builds, split by archetype for flex heroes.
  const loading = useAsyncTask(
    async (signal) => {
      if (!hero || !items) return;
      setError(null);
      const window = windowFor(patches, patchIdx);
      const priorWindow = priorWindowFor(patches, patchIdx);
      // Backfill needs a patch boundary to blend across; when the patch feed is down (empty list,
      // see getPatches) we degrade to the plain window instead of dead-ending the whole build.
      const canBackfill = backfillOn && patches.length > 0;
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
                heroId: hero.id,
                minBadge,
                maxBadge,
                ...window,
                minMatches: 10,
                includeItemIds,
              }),
              getItemFlowStats({
                heroId: hero.id,
                minBadge,
                maxBadge,
                ...priorWindow,
                includeItemIds,
              }),
            ]).then(([f, q]) => blendFlow(f, q))
          : getItemFlowStats({
              heroId: hero.id,
              minBadge,
              maxBadge,
              ...window,
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
          heroId: hero.id,
          minBadge,
          maxBadge,
          ...window,
          ...(canBackfill ? { minMatches: 5 } : {}),
        }),
        canBackfill
          ? getItemStats({
              heroId: hero.id,
              minBadge,
              maxBadge,
              ...priorWindow,
            })
          : Promise.resolve([]),
        getItemPermutationStats({
          heroId: hero.id,
          minBadge,
          maxBadge,
          ...(canBackfill
            ? {
                minUnixTimestamp: priorWindow.minUnixTimestamp,
                maxUnixTimestamp: window.maxUnixTimestamp,
              }
            : window),
        }).catch(() => null),
      ]);
      const base = baseBlend.flow;
      // Movers compare the RAW windows (blending them first would test the prior against itself).
      setMovers(
        canBackfill ? findPatchMovers(statsFresh, statsPrior, items) : null,
      );
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
      // Adoption movers reuse the same raw windows + the honest per-window game totals from the blend.
      setAdoption(
        canBackfill
          ? findAdoptionMovers(
              statsFresh,
              statsPrior,
              baseBlend.freshGames,
              baseBlend.priorGames,
              baseline,
              items,
            )
          : null,
      );
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
      const sig = pickSignatures(base, items);
      const [gunBlend, spiritBlend] = await Promise.all([
        sig.gun ? flowFor([sig.gun]) : Promise.resolve(undefined),
        sig.spirit ? flowFor([sig.spirit]) : Promise.resolve(undefined),
      ]);
      if (signal.aborted) return;
      const gun = gunBlend?.flow;
      const spirit = spiritBlend?.flow;
      setBackfill(canBackfill ? baseBlend.borrowedShare : null);

      const set = assembleArchetypes(
        hero,
        rankLabel,
        items,
        buyTimes,
        sellTimes,
        { all: base, gun, spirit },
        sig,
        { synergyOf, jointGamesOf, lineAware },
      );
      setArchetypeSet(set);
      // Honor a deep-linked archetype on the first build only; otherwise default to best win rate.
      const linked = url0.build;
      if (
        !urlArchApplied.current &&
        linked &&
        set.archetypes.some((x) => x.key === linked)
      ) {
        setArchKey(linked as ArchetypeKey);
      } else {
        setArchKey(set.archetypes[0].key); // best win rate (or "all")
      }
      urlArchApplied.current = true;
    },
    [
      hero,
      items,
      minBadge,
      maxBadge,
      rankLabel,
      patchIdx,
      patches,
      backfillOn,
      lineAware,
      url0.build,
    ],
    setError,
  );

  const activeArchetype =
    archetypeSet?.archetypes.find((a) => a.key === archKey) ??
    archetypeSet?.archetypes[0] ??
    null;
  const build = activeArchetype?.build ?? null;

  // Mirror the live selection into the URL (replaceState, so links stay shareable without spamming
  // history). Gated on a resolved hero so it can't overwrite the deep-link params before the
  // asset-load effect above has consumed them.
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
  const countersLoading = useAsyncTask(
    async (signal) => {
      if (!hero || !items || enemies.length === 0) {
        setCounters(null);
        setCompEdges(null);
        return;
      }
      const canBackfill = backfillOn && patches.length > 0;
      const window = windowFor(patches, patchIdx);
      const priorWindow = priorWindowFor(patches, patchIdx);
      const base = { heroId: hero.id, minBadge, maxBadge };

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
              getItemStats({ ...base, ...window, minMatches: 5, enemyHeroIds }),
              getItemStats({ ...base, ...priorWindow, enemyHeroIds }),
            ])
          : Promise.all([
              getItemStats({ ...base, ...window, enemyHeroIds }),
              Promise.resolve([]),
            ]);
      const [basePair, ...enemyPairs] = await Promise.all([
        slice(),
        ...enemies.map((id) => slice([id])),
      ]);
      if (signal.aborted) return;

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
      const { counters: cs, edgeByItem } = computeItemCounters(
        baseStats,
        perEnemy,
        items,
      );
      setCounters(cs);
      setCompEdges(edgeByItem);
    },
    [hero, items, enemies, minBadge, maxBadge, patchIdx, patches, backfillOn],
    setError,
  );

  // The counter matrix is hero-independent, so fetch once per rank/patch and filter by hero.
  const matrixLoading = useAsyncTask(
    async (signal) => {
      if (!items) return;
      const m = await getHeroCounters({
        minBadge,
        maxBadge,
        ...windowFor(patches, patchIdx),
      });
      if (!signal.aborted) setCounterMatrix(m);
    },
    [items, minBadge, maxBadge, patchIdx, patches],
    setError,
  );

  // Bradley-Terry de-noising for the matchup chips (see lib/matchups): off = raw deltas vs the
  // hero's own baseline (today's behavior), on = strength-adjusted residuals, so "Tough" means
  // "counters you" rather than "is currently meta".
  const [denoiseMatchups, setDenoiseMatchups] = useState(false);
  const matchups = useMemo(
    () =>
      counterMatrix && hero
        ? heroMatchups(counterMatrix, hero.id, denoiseMatchups)
        : null,
    [counterMatrix, hero, denoiseMatchups],
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
  const skillLoading = useAsyncTask(
    async (signal) => {
      if (!hero) return;
      const base = {
        heroId: hero.id,
        minBadge,
        maxBadge,
        ...windowFor(patches, patchIdx),
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
      let build = bestSkillBuild(conditioned);
      if (!build && activeSignatureId) {
        build = bestSkillBuild(await getAbilityOrder(base));
      }
      if (!build && backfillOn && patches.length > 0) {
        build = bestSkillBuild(
          await getAbilityOrder({
            heroId: hero.id,
            minBadge,
            maxBadge,
            ...priorWindowFor(patches, patchIdx),
          }),
        );
      }
      if (!signal.aborted) setSkillBuild(build);
    },
    [
      hero,
      minBadge,
      maxBadge,
      patchIdx,
      patches,
      backfillOn,
      activeSignatureId,
    ],
    setError,
  );

  // Community builds + their win rate at this rank/patch. Joined and scored against the
  // generated build in a memo below, so changing the active archetype re-scores without
  // refetching.
  const communityLoading = useAsyncTask(
    async (signal) => {
      if (!hero) return;
      const [builds, stats] = await Promise.all([
        getCommunityBuilds(hero.id),
        getHeroBuildStats({
          heroId: hero.id,
          minBadge,
          maxBadge,
          ...windowFor(patches, patchIdx),
        }),
      ]);
      if (!signal.aborted) setCommunity({ builds, stats });
    },
    [hero, minBadge, maxBadge, patchIdx, patches],
    setError,
  );

  // Items the generated build recommends (core picks across phases) — the set we match
  // community builds against.
  // Compare like-for-like: our core ranks against their core, our situational against
  // theirs (secondary). The full set still drives preview highlighting.
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
  const ourIdSet = useMemo(
    () => new Set([...ourCoreIds, ...ourSituationalIds]),
    [ourCoreIds, ourSituationalIds],
  );
  const ourSplit = useMemo(
    () => ({
      coreCount: ourCoreIds.length,
      situCount: ourSituationalIds.length,
    }),
    [ourCoreIds, ourSituationalIds],
  );

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

  // Empty patch list = the feed failed and getPatches degraded (see api/deadlock) — windowless
  // queries fall back to the API's default last-30-days, so label it that way.
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
  // Any data in flight — drives the single loading strip under the header. `!items`
  // covers the very first paint, before the assets effect has resolved.
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

  // Per-piece "developing" veils — each tracks its own query so panels settle as their
  // data actually lands, independently of the single strip in the header. The build wears
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
          <label>
            Rank
            <select
              value={typeof rankSel === "number" ? String(rankSel) : "band"}
              onChange={(e) => {
                tierTouched.current = true; // a deliberate choice — profile stops pre-selecting
                setRankSel(
                  e.target.value === "band" && bandChoice
                    ? bandChoice
                    : Number(e.target.value),
                );
              }}
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
            title="Experimental: line-aware generation. Shrinks an upgrade's win rate toward its component's (weighted by how many buyers actually reach it), so a survivorship-inflated upgrade few players reach is kept out of core. Off = current build."
          >
            Line-aware
            <input
              type="checkbox"
              checked={lineAware}
              onChange={(e) => setLineAware(e.target.checked)}
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
            className="guidebtn"
            onClick={() => setShowGuide(true)}
            title="How these numbers are calculated"
          >
            How it works
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
                  : "")
              }
            >
              <img src={h.image} alt="" loading="lazy" />
              {h.name}
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
                  title={`${(metaWinRate * 100).toFixed(1)}% at this rank/patch − ~${(NEW_HERO_TAX * 100).toFixed(1)}pt learning tax ≈ ${(taxed * 100).toFixed(1)}% while you pick them up`}
                >
                  <img src={h.image} alt="" loading="lazy" />
                  {h.name}
                  <i>{Math.round(taxed * 100)}%</i>
                </button>
              ))}
            </>
          )}
        </div>
      )}

      <div className="topflow">
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

        {build && (
          <div className="meta">
            {build.hero.image && (
              // The unmissable "you are looking at THIS hero" anchor — a friend read Abrams
              // numbers mid-match while playing someone else; a name alone is too quiet.
              <img className="metaface" src={build.hero.image} alt="" />
            )}
            <div className="metabody">
              <div className="metatitle">
                {build.hero.name}
                {archetypeSet?.flex && activeArchetype && (
                  <span className="metaarch">{activeArchetype.label}</span>
                )}
              </div>
              {build.rankLabel} · {patchLabel}
              {backfillLabel} · {build.population.matches.toLocaleString()}{" "}
              matches · avg game{" "}
              {Math.round(build.population.avgDurationS / 60)} min ·{" "}
              {(build.population.baselineWinRate * 100).toFixed(0)}% avg WR
              (rows show ± vs this) ·{" "}
              <span
                className={
                  (displayBuild ?? build).standingSlots > SLOT_CAP
                    ? "warn"
                    : undefined
                }
              >
                {(displayBuild ?? build).standingSlots}/{SLOT_CAP} standing
                slots
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

        {fundamentals && hero && (
          <section
            className="fundamentals"
            ref={fundamentalsRef}
            title="Your average per game, placed on the distribution of games at this rank floor (percentile, higher = better; deaths inverted). Souls/min and deaths are the two stats that most separate rank tiers — the climb levers."
          >
            <h2>
              Your fundamentals{" "}
              <span className="sub">
                {fundamentals.heroScoped ? hero.name : "all heroes"} vs{" "}
                {rankLabel}
              </span>
            </h2>
            <div className="fundrows">
              {fundamentals.rows.map((r) => (
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
                  our={ourSplit}
                  ourIds={ourIdSet}
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
                      our={ourSplit}
                      ourIds={ourIdSet}
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
                      our={ourSplit}
                      ourIds={ourIdSet}
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
              {CAN_HOVER ? "Hover" : "Tap"} a build to preview its items;{" "}
              {CAN_HOVER ? "click" : "tap"} <code>#id</code> to copy it for the
              in-game search.{" "}
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
      </div>

      {matchups &&
        (matchups.tough.length > 0 ||
          matchups.favorable.length > 0 ||
          denoiseMatchups) && (
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
            {denoiseMatchups &&
              matchups.tough.length === 0 &&
              matchups.favorable.length === 0 && (
                <p className="hint">
                  No matchup moves this hero's win rate beyond what hero
                  strengths already explain — the raw list was meta, not
                  counters.
                </p>
              )}
            <p className="hint">
              Click a hero to add it below and see what to build against it.{" "}
              <label
                className="denoise"
                title="Separate 'counters you' from 'is simply strong right now': fit one strength number per hero from the whole matrix (Bradley-Terry, the Elo family), predict every pairing from strengths alone, and flag only what's left over. A meta hero stops showing as everyone's counter; genuine rock-paper-scissors stays."
              >
                <input
                  type="checkbox"
                  checked={denoiseMatchups}
                  onChange={(e) => setDenoiseMatchups(e.target.checked)}
                />
                De-noise (strength-adjusted)
              </label>{" "}
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
        onAdd={(id) => setEnemies((e) => (e.includes(id) ? e : [...e, id]))}
        onRemove={(id) => setEnemies((e) => e.filter((x) => x !== id))}
      />

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
          {shownBuild.phases.map((phase) => {
            // Strong counter picks that file under this phase but aren't already in the build
            // get mixed into the situational list (capped); ones already shown get a portrait
            // tag in place instead, so nothing is duplicated and the page doesn't sprout
            // separate counter sections.
            const counterAdds = (countersByPhase.get(phase.label) ?? [])
              .filter((c) => !buildItemIds.has(c.item.id))
              .slice(0, COUNTER_ADDS_PER_PHASE);
            return (
              <section className="phase" key={phase.column}>
                <h2>
                  {phase.label} <span className="time">{phase.timeLabel}</span>
                </h2>
                <div className="budget">
                  {phase.itemsBought}/{phase.targetItems} items ·{" "}
                  {Math.round(phase.coreSouls).toLocaleString()} /{" "}
                  {Math.round(phase.soulBudget).toLocaleString()} souls
                </div>
                <CategoryBar split={phase.categorySouls} />

                <PhaseTempoLines
                  tempo={phaseTempo(
                    phase,
                    shownBuild.population.baselineWinRate,
                  )}
                />

                <h3 className="grouphdr core">Build</h3>
                {phase.core.length ? (
                  phase.core.map((b) => (
                    <ItemRow
                      key={b.item.id}
                      b={b}
                      items={items}
                      baseline={shownBuild.population.baselineWinRate}
                      counter={counterByItem.get(b.item.id)}
                      enemiesById={enemiesById}
                      imbue={imbueByItem.get(b.item.id)}
                      trending={trendingByItem.get(b.item.id)}
                    />
                  ))
                ) : (
                  <p className="empty">No clear staple here.</p>
                )}

                <h3 className="grouphdr situational">Situational swaps</h3>
                {phase.situational.map((b) => (
                  <ItemRow
                    key={b.item.id}
                    b={b}
                    items={items}
                    baseline={shownBuild.population.baselineWinRate}
                    counter={counterByItem.get(b.item.id)}
                    enemiesById={enemiesById}
                    imbue={imbueByItem.get(b.item.id)}
                    trending={trendingByItem.get(b.item.id)}
                    muted
                  />
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

      {showGuide && <GuideModal onClose={() => setShowGuide(false)} />}

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
