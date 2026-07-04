import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DependencyList,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
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
import {
  classifyWinState,
  phaseTempo,
  rerankBuildForComp,
  SLOT_CAP,
  SLOT_COLORS,
  type PhaseTempo,
} from "./lib/buildGenerator";
import { matchCommunityBuilds } from "./lib/communityBuilds";
import { encodeHeroBuild } from "./lib/heroBuildExport";
import { injectBuildIntoCache } from "./lib/heroBuildCache";
import { computeItemCounters, type CompEdge } from "./lib/counters";
import { friendlyError } from "./lib/errors";
import {
  decodeUrlState,
  encodeUrlState,
  slugify,
  type UrlState,
} from "./lib/urlState";
import { blendFlow, blendItemStats, PRIOR_WINDOW_S } from "./lib/patchBlend";
import { findPatchMovers, type PatchMover } from "./lib/patchMovers";
import { fundamentalsRows, type FundamentalRow } from "./lib/fundamentals";
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
import { bestSkillBuild, maxOrder } from "./lib/skills";
import { parseSteamInput, parseVanityName } from "./lib/steamId";
import type {
  Ability,
  ArchetypeKey,
  ArchetypeSet,
  BuildItem,
  BuildPhase,
  CommunityBuild,
  CounterMark,
  ItemCounters,
  ItemRef,
  GeneratedBuild,
  Hero,
  HeroBuildStatRow,
  HeroCounterRow,
  HeroLadderStat,
  ImbueTarget,
  ItemStat,
  Matchup,
  Patch,
  PlayerHeroStat,
  Item,
  RankedCommunityBuild,
  SkillBuild,
} from "./types";

// Distinct colors for a hero's four abilities.
const ABILITY_COLORS = ["#6fb1ff", "#e0a23c", "#5fc08a", "#cc6db1"];

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

const REDUCED =
  typeof matchMedia !== "undefined" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

// Drives a panel's `--settle` (0 = crisp, ~0.9 = fully veiled). While its query is in
// flight the frosted veil eases in, then *trickles* toward a floor on a curve scaled to
// how long that panel took to load last time — so it reads as honest progress toward
// "present". Crucially it never fully clears on the timer alone: only the real
// completion snaps it to 0, so it can't lie that a piece is ready before its data lands.
// Each panel learns its own timing (an EMA), so a slow cold query and a fast cached one
// settle at the rate they actually arrive. Writes the var imperatively (no re-render).
function useSettle<T extends HTMLElement>(loading: boolean) {
  const ref = useRef<T>(null);
  const estMs = useRef(900); // EMA of this panel's load time
  const startedAt = useRef(0);
  const raf = useRef(0);

  useEffect(() => {
    cancelAnimationFrame(raf.current);
    const setVar = (k: string, v: number) =>
      ref.current?.style.setProperty(k, v.toFixed(3));

    if (loading) {
      startedAt.current = performance.now();
      if (REDUCED) {
        setVar("--settle", 0.85); // a calm, unreadable static veil — no animated trickle
        return;
      }
      const tick = () => {
        const t = performance.now() - startedAt.current;
        const rampIn = Math.min(t / 240, 1); // ease the veil in so instant loads barely flash
        const progress = Math.min(t / estMs.current, 1);
        const decay = (1 - progress) ** 2; // 1 → 0 as we approach the expected finish
        // Stays heavy enough to keep the content unreadable the whole time; the trickle is
        // only a gentle "developing" hint, never a slide back to legible.
        setVar("--settle", 0.95 * rampIn * (0.82 + 0.18 * decay));
        raf.current = requestAnimationFrame(tick);
      };
      tick();
    } else if (startedAt.current) {
      const dur = performance.now() - startedAt.current;
      estMs.current = estMs.current * 0.7 + dur * 0.3; // learn the timing for next time
      startedAt.current = 0;
      if (REDUCED) {
        setVar("--settle", 0);
        return;
      }
      // The reveal: blur resolves into focus while a brief purple glow pulses — the
      // "this piece just landed" punch.
      const from = Number(ref.current?.style.getPropertyValue("--settle")) || 0;
      const t0 = performance.now();
      const DUR = 560;
      const tick = () => {
        const k = Math.min((performance.now() - t0) / DUR, 1);
        setVar("--settle", from * (1 - k) ** 3); // ease-out to crisp
        setVar(
          "--flash",
          k < 0.28 ? k / 0.28 : Math.max(0, 1 - (k - 0.28) / 0.72),
        ); // pulse
        if (k < 1) raf.current = requestAnimationFrame(tick);
        else {
          setVar("--settle", 0);
          setVar("--flash", 0);
        }
      };
      tick();
    }
    return () => cancelAnimationFrame(raf.current);
  }, [loading]);

  return ref;
}

/**
 * Runs an abortable async task whenever `deps` change and reports whether it's in flight — the shared
 * scaffolding behind every data fetch here: abort the previous run on change/unmount, flip a loading
 * flag, and funnel failures to one error sink. Pass `null`/`false` as `run` to stand down (no fetch, not
 * loading) when a precondition isn't met. The task gets the AbortSignal; guard your setState calls with
 * `!signal.aborted` so a superseded fetch can't clobber the current selection.
 *
 * Lifting the fetch bodies out of `useEffect` and into a task argument is also what keeps the
 * set-state-in-effect rule satisfied: their setState calls no longer sit lexically inside an effect. The
 * single remaining in-effect transition is `setLoading(true)` below — and that render is exactly what we
 * want (it shows the panel's veil), so it's deliberately exempted.
 */
function useAsyncTask(
  run: ((signal: AbortSignal) => Promise<void>) | null | false,
  deps: DependencyList,
  onError: (message: string) => void,
): boolean {
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!run) return;
    const ctrl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: render the loading veil
    setLoading(true);
    run(ctrl.signal)
      .catch((e) => !ctrl.signal.aborted && onError(friendlyError(e)))
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
    // deps are forwarded by the caller; exhaustive-deps validates them at the call site (additionalHooks).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return loading && !!run;
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
            }).then((f) => ({ flow: f, borrowedShare: 0, patchK: 0 }));

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
      const synergyOf = permRows
        ? buildSynergyLookup(permRows, singleRecordsFromFlow(base), baseline)
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
        { synergyOf },
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
  // Every item the build already shows anywhere — a counter pick in this set gets a tag
  // in place rather than a duplicate "add" row (its buy-time phase can differ from where
  // the build files it).
  const buildItemIds = useMemo(
    () =>
      new Set(
        (displayBuild?.phases ?? []).flatMap((p) =>
          [...p.core, ...p.situational].map((b) => b.item.id),
        ),
      ),
    [displayBuild],
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
        <div className="movers">
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

      {displayBuild && (
        <main className="phases" ref={buildRef}>
          {displayBuild.phases.map((phase) => {
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
                    displayBuild.population.baselineWinRate,
                  )}
                />

                <h3 className="grouphdr core">Build</h3>
                {phase.core.length ? (
                  phase.core.map((b) => (
                    <ItemRow
                      key={b.item.id}
                      b={b}
                      items={items}
                      baseline={displayBuild.population.baselineWinRate}
                      counter={counterByItem.get(b.item.id)}
                      enemiesById={enemiesById}
                      imbue={imbueByItem.get(b.item.id)}
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
                    baseline={displayBuild.population.baselineWinRate}
                    counter={counterByItem.get(b.item.id)}
                    enemiesById={enemiesById}
                    imbue={imbueByItem.get(b.item.id)}
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
                      displayBuild.population.baselineWinRate,
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
            build={displayBuild}
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

// File System Access API — not in the default TS DOM lib, so we type only what we call. Present on
// Chromium (lets us edit the file in place); absent elsewhere (we fall back to upload + download).
interface FsWritable {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
interface FsFileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<FsWritable>;
}
type FsPicker = (opts?: {
  types?: { description?: string; accept?: Record<string, string[]> }[];
}) => Promise<FsFileHandle[]>;

const CACHE_FILENAME = "cached_hero_builds.kv3";
const CACHE_PATHS: Array<[string, string]> = [
  ["Linux", "~/.steam/steam/userdata/<id>/1422450/remote/cfg/"],
  [
    "Windows",
    "C:\\Program Files (x86)\\Steam\\userdata\\<id>\\1422450\\remote\\cfg\\",
  ],
  [
    "macOS",
    "~/Library/Application Support/Steam/userdata/<id>/1422450/remote/cfg/",
  ],
];

/**
 * "Export to in-game build" — injects the current build into the player's `cached_hero_builds.kv3`
 * so the in-game shop walks them through it top-to-bottom. On Chromium it edits the file in place
 * (pick once → written back); elsewhere it downloads an updated copy to drop into the cfg folder. All
 * client-side: Pyodide reads the binary KV3 in the browser ({@link injectBuildIntoCache}), the build
 * is serialized to a protobuf ({@link encodeHeroBuild}), and the result is written as text KV3.
 */
function ExportPanel({
  build,
  skillOrder,
  imbues,
  name,
  description,
  steamId,
  onSteamIdChange,
  onClose,
}: {
  build: GeneratedBuild;
  /** The recommended skill (ability) upgrade order, exported alongside the items. */
  skillOrder?: number[];
  /** Community-plurality imbue targets, applied to the exported items in-game. */
  imbues?: Map<number, ImbueTarget>;
  name: string;
  description: string;
  /** Steam account id — owned by App (shared with the header profile control, persisted there).
   * Stamped as the build's author so the logged-in owner can edit/delete it in-game. */
  steamId: string;
  onSteamIdChange: (v: string) => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState("");
  const [stage, setStage] = useState<"idle" | "working" | "done" | "error">(
    "idle",
  );
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const authorId = parseSteamInput(steamId) ?? undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(
    () => () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    },
    [downloadUrl],
  );

  const picker = (window as unknown as { showOpenFilePicker?: FsPicker })
    .showOpenFilePicker;
  const canEditInPlace = typeof picker === "function";

  const exportInPlace = async () => {
    setStage("working");
    setDownloadUrl(null);
    try {
      const blob = encodeHeroBuild(build, {
        name,
        description,
        authorId,
        skillOrder,
        imbues,
      });
      setStatus("Pick your cached_hero_builds.kv3…");
      const [handle] = await picker!({
        types: [
          {
            description: "Deadlock build cache",
            accept: { "application/octet-stream": [".kv3"] },
          },
        ],
      });
      const file = await handle.getFile();
      const out = await injectBuildIntoCache(
        new Uint8Array(await file.arrayBuffer()),
        blob,
        setStatus,
      );
      const writable = await handle.createWritable();
      await writable.write(out);
      await writable.close();
      setStage("done");
      setStatus(
        `Added “${name}” to your build file. Launch Deadlock → ${build.hero.name} → My Builds.`,
      );
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") {
        setStage("idle");
        setStatus("");
        return;
      }
      setStage("error");
      setStatus(`Couldn't write the build: ${(e as Error)?.message ?? e}`);
    }
  };

  const exportToDownload = async (file: File) => {
    setStage("working");
    setDownloadUrl(null);
    try {
      const blob = encodeHeroBuild(build, {
        name,
        description,
        authorId,
        skillOrder,
        imbues,
      });
      const out = await injectBuildIntoCache(
        new Uint8Array(await file.arrayBuffer()),
        blob,
        setStatus,
      );
      // Copy into a plain ArrayBuffer so the Blob part is unambiguously typed (the FS read can be
      // backed by a SharedArrayBuffer-like view, which Blob's types reject).
      const buf = new ArrayBuffer(out.byteLength);
      new Uint8Array(buf).set(out);
      setDownloadUrl(
        URL.createObjectURL(
          new Blob([buf], { type: "application/octet-stream" }),
        ),
      );
      setStage("done");
      setStatus(
        "Done — download below and drop it back into your cfg folder (replace the original).",
      );
    } catch (e) {
      setStage("error");
      setStatus(`Couldn't build the file: ${(e as Error)?.message ?? e}`);
    }
  };

  return createPortal(
    <div className="guide-backdrop" onClick={onClose}>
      <div
        className="guide export"
        role="dialog"
        aria-modal="true"
        aria-label="Export to in-game build"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="guide-head">
          <h2>Export to in-game build</h2>
          <button
            type="button"
            className="guide-x"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="guide-body">
          <p>
            Adds <strong>{name}</strong> to your Deadlock build list so the
            in-game shop walks you through it top-to-bottom. Runs entirely in
            your browser — your save file never leaves your machine.
          </p>
          <ol className="export-steps">
            <li>
              <strong>Fully quit Deadlock</strong> first (the game overwrites
              this file on exit).
            </li>
            <li>
              {canEditInPlace
                ? "Pick your cached_hero_builds.kv3 — we add the build and save it back in place."
                : "Pick your cached_hero_builds.kv3, then download the updated file and drop it back into the same folder (back up the original first)."}
            </li>
            <li>
              Launch Deadlock → <strong>{build.hero.name}</strong> →{" "}
              <strong>My Builds</strong>.
            </li>
          </ol>

          <label className="export-steam">
            <span>
              Steam account ID{" "}
              <span className="hint">(optional, recommended)</span>
            </span>
            <input
              type="text"
              inputMode="numeric"
              placeholder="e.g. 22202 (Gaben's)"
              value={steamId}
              onChange={(e) => onSteamIdChange(e.target.value)}
            />
            <span className="hint">
              The number in your Steam <code>userdata/&lt;id&gt;</code> folder
              (or your profile). Lets you edit &amp; delete the build in-game —
              without it, the build can't be removed except by editing the file.
            </span>
          </label>

          {canEditInPlace ? (
            <button
              type="button"
              className="export-go"
              disabled={stage === "working"}
              onClick={exportInPlace}
            >
              {stage === "working" ? "Working…" : "Pick file & add build"}
            </button>
          ) : (
            <label className={`export-go ${stage === "working" ? "busy" : ""}`}>
              {stage === "working"
                ? "Working…"
                : "Choose cached_hero_builds.kv3"}
              <input
                type="file"
                accept=".kv3"
                style={{ display: "none" }}
                disabled={stage === "working"}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) exportToDownload(f);
                }}
              />
            </label>
          )}

          {status && <p className={`export-status ${stage}`}>{status}</p>}
          {downloadUrl && (
            <p>
              <a
                className="export-go"
                href={downloadUrl}
                download={CACHE_FILENAME}
              >
                ⬇ Download {CACHE_FILENAME}
              </a>
            </p>
          )}

          <details className="export-where">
            <summary>Where is that file?</summary>
            <ul>
              {CACHE_PATHS.map(([os, p]) => (
                <li key={os}>
                  <strong>{os}:</strong>{" "}
                  <code>
                    {p}
                    {CACHE_FILENAME}
                  </code>
                </li>
              ))}
            </ul>
            <p className="hint">
              Not showing up after launch? Steam Cloud may have reverted it —
              redo it with Deadlock closed, or turn off Steam Cloud for Deadlock
              while importing.
            </p>
          </details>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Static reference pane: how every number on the page is derived, plus a glossary of the
 * tags that show up on rows. Opened from the header button, the inline "learn more" links,
 * and the footer. Closes on backdrop click or Escape. */
function GuideModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Freeze the page behind the modal so wheel/touch can't scroll it.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div className="guide-backdrop" onClick={onClose}>
      <div
        className="guide"
        role="dialog"
        aria-modal="true"
        aria-label="Methodology and glossary"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="guide-head">
          <h2>How this works</h2>
          <button
            type="button"
            className="guide-x"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="guide-body">
          <section>
            <h3>Where the numbers come from</h3>
            <p>
              Every panel is computed live from public match data on{" "}
              <a
                href="https://deadlock-api.com"
                target="_blank"
                rel="noreferrer"
              >
                deadlock-api.com
              </a>
              , filtered to the <strong>rank floor</strong> and{" "}
              <strong>patch</strong> you select (the newest patch by default).
              Nothing here is hand-curated — change a control and the whole page
              recomputes.
            </p>
            <p>
              A <strong>young patch</strong> has too few games to judge every
              item on its own, so the build is{" "}
              <strong>backfilled from the 30 days before the patch</strong>:
              each item&rsquo;s pre-patch record counts as prior evidence worth
              at most ~a thousand games, and it fades out automatically as the
              new patch accumulates data. Items whose fresh numbers clearly
              disagree with their pre-patch record (the things the patch
              actually changed) borrow far less, and brand-new items are judged
              on fresh data alone. The meta line shows what share of the
              evidence is backfilled, and the <strong>Backfill</strong> toggle
              in the header turns it off — you get the selected window raw, thin
              as it may be.
            </p>
          </section>

          <section>
            <h3>Two kinds of win rate</h3>
            <p>
              <strong>Adjusted win rate</strong> is corrected for{" "}
              <em>net worth at the moment of purchase</em>, so an item doesn’t
              look strong just because the team that was already winning
              happened to buy it. Build and item rows use adjusted rates, and
              show the <strong>± gap versus the hero’s average</strong>.
            </p>
            <p>
              <strong>Raw win rate</strong> is the plain win rate with no
              correction. We fall back to it wherever no adjusted figure exists
              — counter deltas, hero matchups, and whole community builds — so
              in those spots, <strong>lean on the larger samples</strong>.
            </p>
            <p className="fine">
              One honest limit: the correction knows your net worth at purchase,
              not your <em>lead</em> — and players buy expensive items
              disproportionately when already winning. We measured it against a
              win-probability model built from real match timelines: at the
              moment of purchase, a tier-4 buy sits at roughly 56% win
              probability versus ~50% for tier 1. So late, expensive picks stay
              a touch flattered even after adjustment — the{" "}
              <span className="statetag winmore">win more</span> /{" "}
              <span className="statetag comeback">comeback</span> tags are the
              per-pick read on it, and no aggregate correction can fully remove
              it.
            </p>
          </section>

          <section>
            <h3>Reading a pick’s two rates together</h3>
            <p>
              The gap between an item’s raw and adjusted rate tells you when it
              earns its win:
            </p>
            <ul>
              <li>
                <span className="statetag comeback">comeback</span> adjusted ≫
                raw — it holds up even when bought from behind. A safer pick
                when you’re losing.
              </li>
              <li>
                <span className="statetag winmore">win more</span> raw ≫
                adjusted — its win rate leans on already being ahead. Strong
                when snowballing, thin when the game is even.
              </li>
            </ul>
            <p className="fine">
              A pick is only flagged once the gap clears ~3.5 points either way.
            </p>
          </section>

          <section>
            <h3>How the build is chosen</h3>
            <p>
              The build isn’t just the top win rates sorted top to bottom — a
              rarely-built item can show a flashy rate by luck. A few
              corrections keep it honest:
            </p>
            <ul>
              <li>
                <strong>
                  A <span className="role role-universal">CORE</span> seat can
                  be earned by popularity alone.
                </strong>{" "}
                An item ~30%+ of players build every game is seated without a
                win-rate check — at that popularity its own win rate is
                mathematically squeezed toward the average and can’t say much
                either way. It only loses the seat when buyers are demonstrably{" "}
                <em>and</em> meaningfully behind everyone who skipped it — so a
                small red number on a{" "}
                <span className="role role-universal">CORE</span> pick isn’t
                proof it’s bad, just proof the gap isn’t big enough to call.
              </li>
              <li>
                <strong>
                  Small samples are pulled toward the hero’s average.
                </strong>{" "}
                Each win rate is dragged toward the hero average by how little
                data backs it — a pick with thousands of games barely moves, one
                with a few dozen is pulled most of the way. A shiny niche item
                won’t outrank a proven staple on noise.
              </li>
              <li>
                <strong>Picks are ranked cautiously.</strong> Discretionary
                slots are ordered by the win rate we’re fairly sure a pick{" "}
                <em>at least</em> reaches, so something we’re confident about
                beats something that merely <em>might</em> be great.
              </li>
              <li>
                <strong>“Value” means real, not just high.</strong> A pick is
                only labelled a value pick when its edge is big enough to be
                unlikely from chance at that sample size, not just past a fixed
                cutoff. Counters work the same way: an item is tagged as
                answering an enemy by the edge over that matchup we’re{" "}
                <em>confident</em> it has — shrunk toward no-effect by sample —
                so a thin fluke can’t earn a portrait, but a real, moderate
                counter isn’t hidden either.
              </li>
              <li>
                <strong>Items that win together.</strong> Beyond each pick on
                its own, the build leans toward items that win <em>together</em>{" "}
                more than their solo rates predict, and away from redundant
                pairs — so it reads as a coherent kit, not a list of
                individually-good parts.
              </li>
            </ul>
            <p className="fine">
              For the curious: empirical-Bayes shrinkage, lower-confidence-bound
              ranking, significance gates, and a centered pairwise-synergy term.
            </p>
          </section>

          <section>
            <h3>Adjusting for the enemy comp</h3>
            <p>
              Add enemy heroes and the build re-ranks. Picks that answer the
              comp rise and carry the enemy’s portrait — the number is that
              pick’s raw win-rate gain into that hero — while picks that are
              weak into the comp get a <span className="weakcomp">▼</span> flag.
              Staples and per-category soul balance are preserved.
            </p>
            <p>
              A counter is only marked when it beats the matchup&rsquo;s
              expected shift <em>for its own buy timing</em> — some enemies
              spike early and fall off (an item bought at 35 minutes
              doesn&rsquo;t get credit for the enemy&rsquo;s late-game fade),
              and the edge must be large enough to be real at that sample.
              Counter numbers are raw, so they read cleanest one threat at a
              time.
            </p>
          </section>

          <section>
            <h3>Glossary</h3>
            <dl className="glossary">
              <dt>Adjusted WR</dt>
              <dd>
                Win rate corrected for net worth at purchase. Used on every
                build/item row.
              </dd>

              <dt>Raw WR</dt>
              <dd>
                Uncorrected win rate. Used for counters, matchups, and whole
                community builds.
              </dd>

              <dt>Hero avg</dt>
              <dd>
                The population’s baseline win rate for this hero, rank and
                patch. Rows show ± versus it.
              </dd>

              <dt>pulled to average</dt>
              <dd>
                Small-sample win rates are dragged toward the hero average by
                how little data backs them, so a lucky streak on a rarely-built
                item can’t top the list. The fewer the games, the harder the
                pull.
              </dd>

              <dt>confidence ranking</dt>
              <dd>
                Discretionary picks are ordered by the win rate we’re fairly
                sure they <em>at least</em>
                reach — a cautious estimate that builds in sample size — so a
                proven pick beats a shakier high-roller.
              </dd>

              <dt>significant</dt>
              <dd>
                An edge big enough to be unlikely from chance at that sample
                size. It’s the bar a pick clears to be called a value pick or a
                counter — not just beating a fixed number.
              </dd>

              <dt>synergy</dt>
              <dd>
                Two items that win <em>together</em> more (or less) than their
                solo rates predict. The build favours pairs that reinforce each
                other and avoids redundant ones; it’s baked into which picks
                fill the discretionary slots, not shown as its own list.
              </dd>

              <dt>
                <span className="statetag comeback">comeback</span>
              </dt>
              <dd>
                Adjusted ≫ raw — the pick holds up even when you buy it from
                behind.
              </dd>

              <dt>
                <span className="statetag winmore">win more</span>
              </dt>
              <dd>
                Raw ≫ adjusted — the pick’s win rate leans on already being
                ahead.
              </dd>

              <dt>% match</dt>
              <dd>
                How much a community build’s core overlaps ours: shared ÷
                combined core items (Jaccard). Ranks builds “most like ours”, so
                tightly focused builds rank above kitchen-sink ones.
              </dd>

              <dt>
                <span className="role role-universal">CORE</span> tag
              </dt>
              <dd>
                Seated by pick rate (~30%+ of players build it every game), not
                by win rate — at that popularity the win rate can’t move far
                either way, so it isn’t judged on that number unless buyers are
                shown to be significantly and meaningfully behind everyone who
                skipped it. A small red delta here usually isn’t a red flag.
              </dd>

              <dt>core / flex</dt>
              <dd>
                Core = the committed picks (any role, including{" "}
                <span className="role role-universal">CORE</span>,{" "}
                <span className="role role-value">VALUE</span>, and{" "}
                <span className="role role-filler">FILLER</span>); flex =
                situational ones. “core N/M” counts our core picks a community
                build also runs; “flex N/M” counts our situational picks it also
                flags situational (secondary, not ranked).
              </dd>

              <dt>archetype / signature</dt>
              <dd>
                A build style defined by a signature item (e.g. a gun or spirit
                core). “all” blends every build for the hero together.
              </dd>

              <dt>core by X · rush if ahead / buy later</dt>
              <dd>
                A situational pick that becomes core in a later phase.{" "}
                <em>Rush if ahead</em> — buy it early when you’re winning — only
                when it wins about as much bought this early; if it does worse
                early, it’s tagged <em>buy later</em> instead.
              </dd>

              <dt>
                weak into comp <span className="weakcomp">▼</span>
              </dt>
              <dd>
                The pick loses win rate against the enemies you’ve selected, and
                nothing on its row counters them.
              </dd>

              <dt>thin / low sample</dt>
              <dd>Too few matches to trust — treat the number as noisy.</dd>

              <dt>standing slots</dt>
              <dd>
                How many of your active-item slots the build uses, against the
                in-game cap.
              </dd>
            </dl>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// The brand mark: a diamond gem that shows a real item icon (masked to the diamond
// silhouette so any source icon reads as one cohesive logo). The icon is derived from
// `seed`, so it changes only when the user takes an action (new hero/rank/patch/style)
// — no timer ticking away. Falls back to a static ◆ until the items asset loads.
// Doubles as the (static, bobbing) spinner in <LoadingState>.
function ShuffleMark({
  items,
  size = 36,
  seed = "",
}: {
  items: Map<number, Item> | null;
  size?: number;
  seed?: string;
}) {
  const pool = useMemo(
    () => (items ? [...items.values()].filter((i) => i.image) : []),
    [items],
  );
  // A per-mount salt so the same selection doesn't always map to the same icon across
  // reloads, while staying stable within a session.
  const salt = useState(() => Math.random().toString(36).slice(2))[0];

  const item = pool.length ? pool[hashIndex(seed + salt, pool.length)] : null;
  return (
    <span className="shufmark" style={{ width: size, height: size }}>
      {item?.image ? (
        <img key={item.id} src={item.image} alt="" />
      ) : (
        <span className="shufmark-fallback">◆</span>
      )}
    </span>
  );
}

/** Stable FNV-1a hash of a string into [0, mod) — used to pick the brand icon. */
function hashIndex(s: string, mod: number): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % mod;
}

// First-paint / cold-query state: the shuffling mark, gently bobbing, over a label.
// Replaces the old "Loading build…" / "refreshing…" text so loading reads as one thing.
function LoadingState({
  items,
  label,
}: {
  items: Map<number, Item> | null;
  label: string;
}) {
  return (
    <div className="loadstate">
      <ShuffleMark items={items} size={46} />
      <span className="loadlabel">{label}</span>
    </div>
  );
}

// Shown when no skill order clears the sample threshold (high rank + narrow patch). We
// render this instead of nothing so the panel never silently disappears.
function SkillEmpty() {
  return (
    <section className="skills">
      <h2>
        Skill order <span className="sub">not enough games on this filter</span>
      </h2>
      <p className="empty">
        No upgrade order has a confident sample here — even in the pre-patch
        window. Try a lower rank floor.
      </p>
    </section>
  );
}

// A thin stacked bar of the souls this phase's build invests per category — the
// "soul investment" split, so a weapon-leaning build that still buys defense reads
// at a glance and the greens aren't lost among the orange/purple.
/** The per-phase tempo lines: one for when you're ahead of the soul pace — pull a later-core pick
 * forward — and one for when you're behind — favor resilient picks over snowbally ones. Renders only the
 * lines that have picks, and nothing at all when there's no signal. */
function PhaseTempoLines({ tempo }: { tempo: PhaseTempo | null }) {
  if (!tempo) return null;
  const { rush, lean, hold } = tempo;
  const chip = (b: BuildItem) => (
    <span
      key={b.item.id}
      className="tchip"
      style={{ borderColor: SLOT_COLORS[b.item.slot] ?? SLOT_COLORS.unknown }}
    >
      {b.item.name}
    </span>
  );
  return (
    <div className="tempo">
      {rush.length > 0 && (
        <div
          className="tline ahead"
          title="Ahead of the soul pace? Pull these later-core picks forward now instead of adding a situational."
        >
          <span className="tlbl">▲ ahead</span>
          <span className="tact">rush</span>
          {rush.map(chip)}
        </div>
      )}
      {(lean.length > 0 || hold.length > 0) && (
        <div
          className="tline behind"
          title="Behind the soul pace? Favor the picks that hold up from behind; the win-more picks need a lead to pay off."
        >
          <span className="tlbl">▼ behind</span>
          {lean.length > 0 && (
            <>
              <span className="tact">favor</span>
              {lean.map(chip)}
            </>
          )}
          {hold.length > 0 && (
            <>
              <span className="tact risky">risky</span>
              {hold.map(chip)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CategoryBar({
  split,
}: {
  split: Record<"weapon" | "vitality" | "spirit", number>;
}) {
  const total = split.weapon + split.vitality + split.spirit;
  if (total <= 0) return null;
  const segs: Array<["weapon" | "vitality" | "spirit", string]> = [
    ["weapon", "Weapon"],
    ["vitality", "Vitality"],
    ["spirit", "Spirit"],
  ];
  return (
    <div className="catbar" title="Souls this build invests per category">
      {segs.map(([slot, label]) => {
        const souls = split[slot];
        if (souls <= 0) return null;
        const exact = (souls / total) * 100;
        const pct = Math.round(exact);
        return (
          <span
            key={slot}
            className="catseg"
            style={{ width: `${exact}%`, background: SLOT_COLORS[slot] }}
            title={`${label}: ${souls.toLocaleString()} souls (${exact.toFixed(1)}%)`}
          >
            {exact >= 8 ? `${pct}%` : ""}
          </span>
        );
      })}
    </div>
  );
}

// The overtime buy-list column — a prioritized "spend your surplus" list for games that drag past
// 30 min with the build already full. Rendered as the natural continuation of the Lane→Late columns,
// but it's not a time slice: it's the T3+ upgrades (ranked by *late-window* win rate) to replace your
// lowest-tier slots with once souls stop being the constraint. Reuses ItemRow so each buy still
// carries its win-rate delta, counter portraits, and imbue/learn-more tags.
function OvertimeColumn({
  build,
  items,
  counterByItem,
  enemiesById,
  imbueByItem,
}: {
  build: GeneratedBuild;
  items: Map<number, Item> | null;
  counterByItem: Map<number, ItemCounters>;
  enemiesById: Map<number, Hero>;
  imbueByItem: Map<number, ImbueTarget>;
}) {
  const buys = build.overtimeBuys;
  if (!buys.length) return null;
  return (
    <section className="phase overtime">
      <h2>
        Overtime buys <span className="time">build full · 30+ min</span>
      </h2>
      <div className="budget">
        Surplus souls? Replace your lowest-tier slots — best at late, top first.
      </div>
      <h3 className="grouphdr core">Buy in this order</h3>
      {buys.map((b) => (
        <ItemRow
          key={b.item.id}
          b={b}
          items={items}
          baseline={build.population.baselineWinRate}
          counter={counterByItem.get(b.item.id)}
          enemiesById={enemiesById}
          imbue={imbueByItem.get(b.item.id)}
        />
      ))}
    </section>
  );
}

function CounterPicker({
  heroes,
  enemies,
  onAdd,
  onRemove,
}: {
  heroes: Hero[];
  enemies: number[];
  onAdd: (id: number) => void;
  onRemove: (id: number) => void;
}) {
  return (
    <div className="enemies">
      <span className="lbl">Counters vs</span>
      {enemies.map((id) => {
        const h = heroes.find((x) => x.id === id);
        return (
          <button
            className="chip"
            key={id}
            onClick={() => onRemove(id)}
            title="remove"
          >
            {h?.name ?? id} ✕
          </button>
        );
      })}
      <select
        value=""
        onChange={(e) => {
          if (e.target.value) onAdd(Number(e.target.value));
        }}
      >
        <option value="">+ add enemy…</option>
        {heroes
          .filter((h) => !enemies.includes(h.id))
          .map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
      </select>
    </div>
  );
}

function SkillOrder({
  skill,
  abilities,
  slotOrder,
  settleRef,
}: {
  skill: SkillBuild;
  abilities: Map<number, Ability>;
  slotOrder: number[];
  settleRef?: Ref<HTMLElement>;
}) {
  // Rows in in-game slot order; fall back to upgrade order if slots are unknown.
  const present = new Set(skill.order);
  const rows = (slotOrder.length ? slotOrder : skill.maxPriority).filter((id) =>
    present.has(id),
  );
  const colorOf = (id: number) =>
    ABILITY_COLORS[rows.indexOf(id) % ABILITY_COLORS.length];
  const maxLabel = ["max 1st", "max 2nd", "max 3rd", "max 4th"];

  return (
    <section className="skills" ref={settleRef}>
      <h2>
        Skill order{" "}
        <span className="sub">
          the standard order · n={skill.sample.toLocaleString()} players
          {skill.lowSample && <span className="warn"> · ⚠ thin sample</span>}
        </span>
      </h2>
      <div
        className="skill-grid"
        style={{ ["--steps" as string]: skill.order.length }}
      >
        {rows.map((id) => {
          const a = abilities.get(id);
          const color = colorOf(id);
          const ri = skill.maxPriority.indexOf(id);
          return (
            <div className="skill-row" key={id}>
              <div className="srow-label" style={{ borderColor: color }}>
                {a?.image && <img src={a.image} alt="" loading="lazy" />}
                <div className="srow-info">
                  <span className="aname">{a?.name ?? id}</span>
                  <span className="amax">
                    {maxLabel[ri] ?? `max ${ri + 1}`}
                  </span>
                </div>
              </div>
              <div className="srow-cells">
                {skill.order.map((stepId, i) => {
                  const on = stepId === id;
                  return (
                    <span
                      key={i}
                      className={`pip ${on ? "on" : ""}`}
                      style={on ? { background: color } : undefined}
                      title={on ? `point ${i + 1}` : undefined}
                    >
                      {on ? i + 1 : ""}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MatchupChip({
  m,
  hero,
  active,
  onClick,
  tough = false,
}: {
  m: Matchup;
  hero?: Hero;
  active: boolean;
  onClick: () => void;
  tough?: boolean;
}) {
  return (
    <button
      className={`mchip ${tough ? "tough" : "fav"} ${active ? "active" : ""}`}
      onClick={onClick}
      title={`${hero?.name ?? "?"}: ${(m.winRate * 100).toFixed(0)}% win rate (${m.delta >= 0 ? "+" : ""}${(m.delta * 100).toFixed(1)}${m.expectedWinRate !== undefined ? ` vs the ${(m.expectedWinRate * 100).toFixed(0)}% hero strengths predict` : " vs avg"}), n=${m.sample.toLocaleString()}${m.laneCsDelta < -10 ? ` · they out-farm you by ~${Math.abs(Math.round(m.laneCsDelta))} CS in lane` : ""}`}
    >
      {hero?.image && <img src={hero.image} alt="" loading="lazy" />}
      <span className="mname">{hero?.name ?? m.enemyHeroId}</span>
      <span className="mwr">{(m.winRate * 100).toFixed(0)}%</span>
      {active && <span className="madd">✓</span>}
    </button>
  );
}

const COUNTER_ADDS_PER_PHASE = 3; // cap on counter-only picks folded into a phase's swaps
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** One compact bubble: a single enemy's portrait + this item's edge vs that enemy. */
function CounterBubble({ mark, hero }: { mark: CounterMark; hero?: Hero }) {
  return (
    <span
      className={`cbubble ${mark.lowSample ? "low" : ""}`}
      title={`vs ${hero?.name ?? "?"}: +${(mark.delta * 100).toFixed(1)} win rate${mark.lowSample ? " (thin sample)" : ""}`}
    >
      {hero?.image && <img src={hero.image} alt={hero.name} loading="lazy" />}+
      {(mark.delta * 100).toFixed(1)}
    </span>
  );
}

/** The row's third line: counter bubbles (one per enemy), a weak-vs-comp flag, and any
 * transient note — or, when there's nothing comp-related to say, the item's effect text. */
function ItemTags({
  reason,
  counter,
  enemiesById,
  imbue,
  weakEdge,
  swapFor,
  swapLabel = "swap for",
  coreLater,
  coreRush,
  rawWr,
  adjWr,
  baseline,
}: {
  reason?: string | null;
  counter?: ItemCounters;
  enemiesById?: Map<number, Hero>;
  /** For an imbue-type item: the ability most authors imbue it onto (a "→ ability" chip). */
  imbue?: ImbueTarget;
  weakEdge?: number;
  swapFor?: ItemRef;
  /** Wording for the swap tag — "swap for" (situational) vs "in for" (drop this for a counter). */
  swapLabel?: string;
  /** Phase label where this situational pick becomes core — shown as a "core by X" tag. */
  coreLater?: string;
  /** Whether rushing it early is supported by its win rate — gates the "rush if ahead" suffix. */
  coreRush?: boolean;
  /** Raw + adjusted win rate; their gap reveals a "win more" (raw≫adj) or "comeback" (adj≫raw) pick. */
  rawWr?: number;
  adjWr?: number;
  /** Hero baseline WR — a win-more/comeback tag only makes sense on a pick that's at least viable. */
  baseline?: number;
}) {
  const bubbles = counter && enemiesById ? counter.marks : [];
  // raw ≫ adj ⇒ the win rate leans on already being ahead ("win more"); adj ≫ raw ⇒ it holds up even when
  // bought behind ("comeback"). Same classifier the per-phase tempo block uses, so the row tag and the
  // tempo lists never disagree about a pick's character.
  const state =
    rawWr !== undefined && adjWr !== undefined && baseline !== undefined
      ? classifyWinState(rawWr, adjWr, baseline)
      : undefined;
  const hasTags =
    !!reason ||
    bubbles.length > 0 ||
    !!imbue ||
    weakEdge !== undefined ||
    !!swapFor ||
    !!coreLater ||
    !!state;
  if (!hasTags) return null;
  return (
    <div className="tags">
      {reason && <span className="reason">{reason}</span>}
      {imbue && (
        <span
          className="rel imbue"
          style={
            imbue.colorIndex >= 0
              ? { borderColor: ABILITY_COLORS[imbue.colorIndex] }
              : undefined
          }
          title={`${Math.round(imbue.share * 100)}% of the ${imbue.sample} community builds that set a target imbue this onto ${imbue.ability.name}`}
        >
          {imbue.ability.image && (
            <img src={imbue.ability.image} alt="" loading="lazy" />
          )}
          imbue → {imbue.ability.name}
        </span>
      )}
      {bubbles.map((m) => (
        <CounterBubble
          key={m.enemyHeroId}
          mark={m}
          hero={enemiesById!.get(m.enemyHeroId)}
        />
      ))}
      {weakEdge !== undefined && (
        <span className="weakcomp" title="Weak into the selected comp">
          ▼ {fmtDelta(weakEdge)}
        </span>
      )}
      {coreLater && (
        <span
          className="rel rush"
          title={
            coreRush
              ? `Core by ${coreLater} — buy early if you're ahead`
              : `Core by ${coreLater} — but it does worse bought this early, so don't rush it`
          }
        >
          core by {coreLater}
          {coreRush ? " · rush if ahead" : " · buy later"}
        </span>
      )}
      {swapFor && (
        <span className="rel swap" title={`${swapLabel} ${swapFor.name}`}>
          {swapLabel} {swapFor.name}
        </span>
      )}
      {state && (
        <span
          className={`statetag ${state}`}
          title={
            state === "winmore"
              ? `Win-more: raw ${pct(rawWr!)} ≫ adjusted ${pct(adjWr!)} — its win rate leans on already being ahead`
              : `Comeback: adjusted ${pct(adjWr!)} ≫ raw ${pct(rawWr!)} — holds up even when bought behind`
          }
        >
          {state === "winmore" ? "win more" : "comeback"}
        </span>
      )}
    </div>
  );
}

/** A counter pick not already in the build, folded into its phase's swaps list. Headline
 * number is the raw per-enemy delta (item-stats has no adjusted rate). */
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

function CounterAddRow({
  c,
  items,
  enemiesById,
  swapFor,
}: {
  c: ItemCounters;
  items: Map<number, Item> | null;
  enemiesById: Map<number, Hero>;
  /** The core pick to drop to fit this counter in (same slot, weakest for the comp). */
  swapFor?: ItemRef;
}) {
  const color = SLOT_COLORS[c.item.slot] ?? SLOT_COLORS.unknown;
  const top = c.marks[0];
  return (
    <ItemHover
      item={c.item}
      items={items}
      className="item muted counter-add"
      style={{ borderLeftColor: color }}
      counter={c}
      enemiesById={enemiesById}
    >
      <div className="icon" style={{ background: color }}>
        {c.item.image ? <img src={c.item.image} alt="" loading="lazy" /> : null}
      </div>
      <div className="body">
        <div className="line1">
          <span className="name">{c.item.name}</span>
          <span className="cost">{c.item.cost.toLocaleString()}</span>
        </div>
        <div className="line2">
          <span className="wr" style={{ color: deltaColor(top.delta) }}>
            +{(top.delta * 100).toFixed(1)}
            <span className="wrabs">{(top.winRate * 100).toFixed(0)}%</span>
          </span>
          <span className="pick">counters comp</span>
          <span className={`n ${top.lowSample ? "low" : ""}`}>
            n={top.sample.toLocaleString()}
            {top.lowSample ? " ⚠" : ""}
          </span>
        </div>
        <ItemTags
          counter={c}
          enemiesById={enemiesById}
          swapFor={swapFor}
          swapLabel="in for"
        />
      </div>
    </ItemHover>
  );
}

/** The item's cost. A component-chained upgrade is charged *marginally* — net of components already
 * in the build, which Deadlock refunds into the upgrade — so the rows sum to the phase's soul budget.
 * When that discount applies, show the marginal price with the full sticker struck through. */
function CostTag({ b }: { b: BuildItem }) {
  const eff = b.effectiveCost ?? b.item.cost;
  if (eff >= b.item.cost)
    return <span className="cost">{b.item.cost.toLocaleString()}</span>;
  const saved = b.item.cost - eff;
  return (
    <span
      className="cost discounted"
      title={`${eff.toLocaleString()} now — ${saved.toLocaleString()} of components already in your build refund into it (full ${b.item.cost.toLocaleString()})`}
    >
      <span className="cost-full">{b.item.cost.toLocaleString()}</span>
      {eff.toLocaleString()}
    </span>
  );
}

function ItemRow({
  b,
  items,
  baseline,
  counter,
  enemiesById,
  imbue,
  muted = false,
}: {
  b: BuildItem;
  items: Map<number, Item> | null;
  /** Hero+rank baseline win rate; item WR is shown as a delta against it. */
  baseline: number;
  /** If this pick also gains win rate vs the selected comp, its per-enemy counter marks. */
  counter?: ItemCounters;
  /** Selected enemies by id, for resolving the counter chip's portraits. */
  enemiesById?: Map<number, Hero>;
  /** For an imbue-type item: the ability most authors imbue it onto. */
  imbue?: ImbueTarget;
  muted?: boolean;
}) {
  const color = SLOT_COLORS[b.item.slot] ?? SLOT_COLORS.unknown;
  const reason = b.transient && b.transientReason ? b.transientReason : null;
  return (
    <ItemHover
      item={b.item}
      items={items}
      className={`item ${muted ? "muted" : ""} ${b.transient ? "transient" : ""}`}
      style={{ borderLeftColor: color }}
      counter={counter}
      enemiesById={enemiesById}
      buildsToward={b.buildsToward}
    >
      <div className="icon" style={{ background: color }}>
        {b.item.image ? <img src={b.item.image} alt="" loading="lazy" /> : null}
      </div>
      <div className="body">
        <div className="line1">
          <span className="name">
            {!muted && (
              <span className={`role role-${b.transient ? "temp" : b.role}`}>
                {b.transient ? "TEMP" : roleLabel(b.role)}
              </span>
            )}
            {b.item.name}
          </span>
          <CostTag b={b} />
        </div>
        <div className="line2">
          <span
            className="wr"
            style={{ color: deltaColor(b.adjustedWinRate - baseline) }}
            title={`${(b.adjustedWinRate * 100).toFixed(1)}% adjusted WR · hero avg ${(baseline * 100).toFixed(1)}%`}
          >
            {fmtDelta(b.adjustedWinRate - baseline)}
            <span className="wrabs">
              {(b.adjustedWinRate * 100).toFixed(0)}%
            </span>
          </span>
          <span className="pick">{(b.pickRate * 100).toFixed(0)}% pick</span>
          <span className="n">n={b.sample.toLocaleString()}</span>
        </div>
        <ItemTags
          reason={reason}
          counter={counter}
          enemiesById={enemiesById}
          imbue={imbue}
          weakEdge={!counter && b.weakVsComp ? b.compEdge : undefined}
          swapFor={b.swapFor}
          coreLater={b.coreLater}
          coreRush={b.coreRush}
          rawWr={b.rawWinRate}
          adjWr={b.adjustedWinRate}
          baseline={baseline}
        />
      </div>
    </ItemHover>
  );
}

// Touch/coarse-pointer devices can't hover, so the portaled popovers — the shop card and the
// community-build preview, which together are the *learning* layer (what an item does, its stats
// and build paths, how a build overlaps ours) — would be unreachable on a phone. We detect that
// once: hover-capable devices keep the pure-hover tooltip; touch devices open on a *tap* instead.
// matchMedia's comma is an OR, so this is "no hover OR a coarse primary pointer".
const CAN_HOVER =
  typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? true
    : !window.matchMedia("(hover: none), (pointer: coarse)").matches;

// Selectors of the portaled popovers, so the touch dismissal below doesn't treat a tap (or scroll)
// *inside* an open popover as a tap outside it.
const POPOVER_SEL = ".itemcard, .buildprev";

/**
 * Hover-or-tap popover wiring, shared by the item card and the community-build preview. Hover
 * devices open on mouseenter and close on mouseleave — the original pure tooltip, unchanged. Touch
 * devices ({@link CAN_HOVER} false) can't do that, so they open on a *tap* and pin it open until a
 * tap outside the trigger and popover, a page scroll, or Escape. `sticky` (true only on touch) lets
 * the popover become a real tappable/scrollable surface instead of a pass-through tooltip. Spread
 * `handlers` onto the trigger element (which `ref` must point at) and render the popover when
 * `anchor` is set, passing it `sticky`.
 */
function usePinnablePopover<T extends HTMLElement>(ref: { current: T | null }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const open = () =>
    ref.current && setAnchor(ref.current.getBoundingClientRect());
  const close = () => setAnchor(null);

  useEffect(() => {
    if (CAN_HOVER || !anchor) return; // hover devices dismiss via mouseleave; nothing global to wire
    const inPopover = (t: EventTarget | null) =>
      t instanceof Element && !!t.closest(POPOVER_SEL);
    const onDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node) || inPopover(e.target))
        return;
      setAnchor(null);
    };
    const onScroll = (e: Event) => {
      if (!inPopover(e.target)) setAnchor(null); // scrolling within a tall popover keeps it open
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setAnchor(null);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, ref]);

  const handlers = CAN_HOVER
    ? { onMouseEnter: open, onMouseLeave: close }
    : { onClick: () => (anchor ? close() : open()) };
  return { anchor, handlers, sticky: !CAN_HOVER };
}

// A row/cell that reveals the item's full shop card on hover (or tap, on touch). It *is* the styled
// element (className/style passed through), so there's no extra wrapper. The card is rendered in a
// portal (anchored to this element's rect) so the row can't clip it.
function ItemHover({
  item,
  items,
  className,
  style,
  children,
  counter,
  enemiesById,
  buildsToward,
}: {
  item: Item;
  items: Map<number, Item> | null;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  /** When set, the hover card also shows this item's per-enemy counter breakdown. */
  counter?: ItemCounters;
  enemiesById?: Map<number, Hero>;
  /** The item this builds toward (shown as an upgrade-path line in the hover card). */
  buildsToward?: ItemRef;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { anchor, handlers, sticky } = usePinnablePopover(ref);

  return (
    <div ref={ref} className={className} style={style} {...handlers}>
      {children}
      {anchor && (
        <ItemCard
          item={item}
          items={items}
          anchor={anchor}
          counter={counter}
          enemiesById={enemiesById}
          buildsToward={buildsToward}
          sticky={sticky}
        />
      )}
    </div>
  );
}

const CARD_GAP = 10;

function ItemCard({
  item,
  items,
  anchor,
  counter,
  enemiesById,
  buildsToward,
  sticky = false,
}: {
  item: Item;
  items: Map<number, Item> | null;
  anchor: DOMRect;
  counter?: ItemCounters;
  enemiesById?: Map<number, Hero>;
  buildsToward?: ItemRef;
  /** Tap-pinned on touch: becomes tappable/scrollable (not a pass-through tooltip) so a tall
   * card can be read and scrolled on a phone. See {@link ItemHover} and `.itemcard.sticky`. */
  sticky?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Render off-screen first, then measure to flip left/right and clamp vertically.
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const left =
      anchor.right + CARD_GAP + w <= window.innerWidth
        ? anchor.right + CARD_GAP
        : Math.max(8, anchor.left - CARD_GAP - w);
    const top = Math.max(8, Math.min(anchor.top, window.innerHeight - 8 - h));
    setPos({ left, top });
  }, [anchor]);

  const color = SLOT_COLORS[item.slot] ?? SLOT_COLORS.unknown;
  const components = item.componentIds
    .map((id) => items?.get(id)?.name)
    .filter((n): n is string => !!n);

  return createPortal(
    <div
      ref={ref}
      className={`itemcard${sticky ? " sticky" : ""}`}
      style={{ left: pos.left, top: pos.top, borderColor: color }}
    >
      <div className="ic-head" style={{ background: color }}>
        {item.image && <img src={item.image} alt="" />}
        <div className="ic-title">
          <span className="ic-name">{item.name}</span>
          <span className="ic-sub">
            T{item.tier} · {item.cost.toLocaleString()} souls
          </span>
        </div>
      </div>

      {counter && enemiesById && counter.marks.length > 0 && (
        <div className="ic-counter">
          <span className="ic-kind">Edge vs this comp</span>
          <ul>
            {counter.marks.map((m) => {
              const h = enemiesById.get(m.enemyHeroId);
              return (
                <li key={m.enemyHeroId}>
                  {h?.image && <img src={h.image} alt="" />}
                  <span className="cn">{h?.name ?? `#${m.enemyHeroId}`}</span>
                  <span className="cd">+{(m.delta * 100).toFixed(1)}</span>
                  <span className="cw">
                    {(m.winRate * 100).toFixed(0)}% WR
                    {m.lowSample ? " · thin" : ""}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="ic-note">
            Win-rate gain above the general matchup, vs each enemy.
          </p>
        </div>
      )}

      {item.card?.sections.map((s, i) => (
        <div className={`ic-sec ${s.kind}`} key={i}>
          {s.kind !== "innate" && (
            <span className="ic-kind">
              {s.kind === "active" ? "Active" : "Passive"}
            </span>
          )}
          {s.text && s.text.length > 0 && (
            <p className="ic-text">
              {s.text.map((seg, j) =>
                seg.highlight ? (
                  <strong key={j}>{seg.text}</strong>
                ) : (
                  <span key={j}>{seg.text}</span>
                ),
              )}
            </p>
          )}
          {s.stats.length > 0 && (
            <ul className="ic-stats">
              {s.stats.map((st, j) => (
                <li key={j} className={st.strong ? "strong" : undefined}>
                  <span className="v">{st.value}</span> {st.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      {!item.card && item.effect && (
        <p className="ic-text plain">{item.effect}</p>
      )}
      {components.length > 0 && (
        <div className="ic-comp">Builds from: {components.join(", ")}</div>
      )}
      {buildsToward && (
        <div className="ic-comp">Most build toward: {buildsToward.name}</div>
      )}
    </div>,
    document.body,
  );
}

function CommunityRow({
  tag,
  rb,
  our,
  ourIds,
  items,
  abilities,
  ourMaxOrder,
  slotOrder,
  agree = false,
}: {
  tag: string;
  rb: RankedCommunityBuild;
  our: { coreCount: number; situCount: number };
  ourIds: Set<number>;
  items: Map<number, Item> | null;
  abilities?: Map<number, Ability> | null;
  ourMaxOrder?: number[];
  slotOrder: number[];
  agree?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { anchor, handlers, sticky } = usePinnablePopover(ref);
  const [copied, setCopied] = useState(false);

  const coreSize = rb.build.coreItemIds.length;
  const total = rb.build.itemIds.length;

  const copyId = () => {
    navigator.clipboard?.writeText(String(rb.build.id)).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };

  return (
    <div ref={ref} className={`crow ${agree ? "agree" : ""}`} {...handlers}>
      <span className="ctag">{tag}</span>
      <span className="cname" title={rb.build.name}>
        {rb.build.name}
      </span>
      <div className="cstats">
        <span className="cwr" style={{ color: wrColor(rb.winRate) }}>
          {(rb.winRate * 100).toFixed(0)}% WR
        </span>
        <span className="cmeta">n={rb.matches.toLocaleString()}</span>
        <span
          className="cmeta"
          title={`Jaccard overlap of our core picks with their core (shared ÷ combined). Ranks “most like ours”; their core is ${coreSize} of ${total} items.`}
        >
          {(rb.similarity * 100).toFixed(0)}% match
        </span>
        <span
          className="cmeta"
          title={
            `${rb.shared} of your ${our.coreCount} core picks are in their ${coreSize}-item core.` +
            (our.situCount > 0
              ? ` Flex: ${rb.situShared} of your ${our.situCount} situational picks appear in their situational list (${total - coreSize} items) — secondary, not ranked.`
              : "")
          }
        >
          core {rb.shared}/{our.coreCount}
          {our.situCount > 0 && ` · flex ${rb.situShared}/${our.situCount}`}
        </span>
      </div>
      <div className="cfoot">
        <span className="cmeta">updated {fmtDate(rb.build.updatedAt)}</span>
        <button
          className="cid"
          onClick={(e) => {
            e.stopPropagation(); // on touch the row toggles the preview; copying shouldn't also toggle it
            copyId();
          }}
          title="Copy build ID — paste into the in-game build search"
        >
          {copied ? "copied ✓" : `#${rb.build.id}`}
        </button>
      </div>
      {anchor && items && (
        <BuildPreview
          build={rb.build}
          items={items}
          ourIds={ourIds}
          abilities={abilities}
          ourMaxOrder={ourMaxOrder}
          slotOrder={slotOrder}
          anchor={anchor}
          sticky={sticky}
        />
      )}
    </div>
  );
}

// On-hover preview of a community build's items (slot-colored icons, our shared picks
// highlighted). Portaled + anchored like the item card so the row can't clip it, and
// kept off the default view so the page stays glanceable.
function BuildPreview({
  build,
  items,
  ourIds,
  abilities,
  ourMaxOrder,
  slotOrder,
  anchor,
  sticky = false,
}: {
  build: CommunityBuild;
  items: Map<number, Item>;
  ourIds: Set<number>;
  abilities?: Map<number, Ability> | null;
  ourMaxOrder?: number[];
  slotOrder: number[];
  anchor: DOMRect;
  /** Tap-pinned on touch: makes the preview a tappable/scrollable surface (see {@link usePinnablePopover}). */
  sticky?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 8 - w));
    const top =
      anchor.bottom + CARD_GAP + h <= window.innerHeight
        ? anchor.bottom + CARD_GAP
        : Math.max(8, anchor.top - CARD_GAP - h);
    setPos({ left, top });
  }, [anchor]);

  const theirSet = new Set(build.itemIds);
  // Their items, shared-with-ours first so the overlap reads at a glance.
  const resolved = build.itemIds
    .map((id) => items.get(id))
    .filter((i): i is Item => !!i)
    .sort(
      (a, b) =>
        Number(ourIds.has(b.id)) - Number(ourIds.has(a.id)) ||
        a.slot.localeCompare(b.slot) ||
        a.cost - b.cost,
    );
  // Items we recommend that this build doesn't list at all.
  const missing = [...ourIds]
    .filter((id) => !theirSet.has(id))
    .map((id) => items.get(id))
    .filter((i): i is Item => !!i)
    .sort((a, b) => a.slot.localeCompare(b.slot) || a.cost - b.cost);
  const shared = ourIds.size - missing.length;

  // Their skill priority (which ability is maxed 1st→last), shown only in de-biased mode
  // (when ourMaxOrder is provided) so we can mark where their order diverges from ours.
  const theirMaxOrder =
    abilities && ourMaxOrder && build.skillOrder.length
      ? maxOrder(build.skillOrder)
      : [];
  const skillColor = (id: number) => {
    const i = slotOrder.indexOf(id);
    return ABILITY_COLORS[(i >= 0 ? i : 0) % ABILITY_COLORS.length];
  };

  const icon = (i: Item, cls: string) => (
    <span
      key={i.id}
      className={`bp-item ${cls}`}
      title={i.name}
      style={{ borderColor: SLOT_COLORS[i.slot] ?? SLOT_COLORS.unknown }}
    >
      {i.image ? <img src={i.image} alt="" loading="lazy" /> : null}
    </span>
  );

  return createPortal(
    <div
      ref={ref}
      className={`buildprev${sticky ? " sticky" : ""}`}
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="bp-head">
        <span className="bp-name">{build.name}</span>
        <span className="bp-id">#{build.id}</span>
      </div>
      <div className="bp-grid">
        {resolved.map((i) => icon(i, ourIds.has(i.id) ? "shared" : ""))}
      </div>
      {missing.length > 0 && (
        <>
          <div className="bp-sub">Only in our build ({missing.length})</div>
          <div className="bp-grid">
            {missing.map((i) => icon(i, "missing"))}
          </div>
        </>
      )}
      {theirMaxOrder.length > 0 && abilities && (
        <>
          <div className="bp-sub">Skill priority (maxed 1st → last)</div>
          <div className="bp-skills">
            {theirMaxOrder.map((id, rank) => {
              const a = abilities.get(id);
              const moved = ourMaxOrder
                ? ourMaxOrder.indexOf(id) !== rank
                : false;
              const ourRank = ourMaxOrder ? ourMaxOrder.indexOf(id) : -1;
              return (
                <span
                  key={id}
                  className={`bp-skill ${moved ? "moved" : ""}`}
                  style={{ borderColor: skillColor(id) }}
                  title={`${a?.name ?? id} — maxed ${rank + 1}${
                    moved && ourRank >= 0
                      ? ` (you: ${ourRank + 1})`
                      : moved
                        ? " (not in yours)"
                        : " (same as yours)"
                  }`}
                >
                  {a?.image ? (
                    <img src={a.image} alt="" loading="lazy" />
                  ) : (
                    (a?.name ?? id)
                  )}
                  <span className="bp-skrank">{rank + 1}</span>
                </span>
              );
            })}
          </div>
        </>
      )}
      <div className="bp-foot">
        {shared} of your {ourIds.size} picks shared
        {missing.length > 0 ? ` · ${missing.length} only in ours` : ""}
      </div>
    </div>,
    document.body,
  );
}

function fmtDate(unixS: number): string {
  return unixS ? new Date(unixS * 1000).toISOString().slice(0, 10) : "—";
}

function wrColor(wr: number): string {
  if (wr >= 0.56) return "#54c66b";
  if (wr >= 0.52) return "#a6cf57";
  if (wr >= 0.48) return "#d8c14a";
  return "#d87a7a";
}

function roleLabel(role: BuildItem["role"]): string {
  if (role === "universal") return "CORE";
  if (role === "filler") return "FILLER";
  if (role === "need") return "SUSTAIN"; // the only NeedKind we classify
  return "VALUE";
}

/** Win rate as a signed delta vs the hero baseline (e.g. "+7.2", "−0.7"). */
function fmtDelta(d: number): string {
  const v = d * 100;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
}

/** Color a WR delta: centered on the baseline, so 0 reads neutral, not "bad". */
function deltaColor(d: number): string {
  if (d >= 0.04) return "#54c66b";
  if (d >= 0.02) return "#a6cf57";
  if (d >= -0.02) return "#d8c14a";
  return "#d87a7a";
}
