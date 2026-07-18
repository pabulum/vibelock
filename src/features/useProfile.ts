// The player-identity feature: Steam id entry, the linked profile's heroes and rank, the
// your-heroes / worth-picking-up rows, the fundamentals benchmark, and the last-game overlay.
// Everything here fails soft — a typo'd id or a missing profile never trips the main banner.
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  getHeroLadderStats,
  getMatchMetadata,
  getPlayerHeroStats,
  getPlayerMatchHistory,
  getPlayerMetrics,
  getPlayerRankTier,
  searchSteamPlayers,
  type SteamPlayerMatch,
  type TimeWindow,
} from "../api/deadlock";
import type { WpStats } from "../api/wpStats";
import type { LastGameFarm } from "../components/EconomyPanel";
import {
  fundamentalsRows,
  recentWindow,
  RECENT_GAMES_DEFAULT,
  type FundamentalRow,
  type RecentWindow,
} from "../lib/fundamentals";
import { benchmarkEconomy, economyRows } from "../lib/matchAnalysis";
import { blendItemStats } from "../lib/patchBlend";
import {
  climbBand,
  rankBandLabel,
  tierOf,
  tierToMaxBadge,
  tierToMinBadge,
  type RankSel,
} from "../lib/ranks";
import { parseSteamInput, parseVanityName } from "../lib/steamId";
import type {
  Hero,
  HeroLadderStat,
  Item,
  ItemStat,
  MatchHistoryRow,
  PlayerHeroStat,
} from "../types";

/** Fundamentals rows the "Combat & survival" card still shows. Everything soul-shaped moved to the
 * Economy panel (souls/min as its headline; last hits / jungle / denies replaced by the real
 * per-source breakdown), so what's left here is staying alive and what you do in a fight. */
const COMBAT_KEYS = new Set(["deaths", "player_damage_per_min", "accuracy"]);

/** The fundamentals benchmark card's data: your recent games placed on the ladder's distribution. */
export interface FundamentalsData {
  rows: FundamentalRow[];
  heroScoped: boolean;
  window: RecentWindow | null;
  benchmarkLabel: string;
}

export function useProfile(opts: {
  hero: Hero | null;
  heroId: number | null;
  heroes: Hero[];
  items: Map<number, Item> | null;
  patchesReady: boolean;
  rankSel: RankSel;
  minBadge: number;
  maxBadge?: number;
  tierAnchor: number;
  dataWindow: TimeWindow;
  priorWin: TimeWindow;
  canBackfill: boolean;
  priorKey: TimeWindow | null;
  wpStats: WpStats | null;
}) {
  const {
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
  } = opts;

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

  return {
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
  };
}
