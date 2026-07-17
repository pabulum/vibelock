// Match analysis: paste a match id (or pick a recent game) and get the post-game read — the
// win-probability trajectory, this game's fundamentals against the ladder, the soul economy by
// source, and deaths by phase. All computation is in lib/matchAnalysis; this file is fetch + render.
//
// Fetch discipline (see api/deadlock.getMatchMetadata): the match endpoints are a far tighter rate
// family than the analytics ones, so the lookup asks cached-first — free, and nearly every played
// match is ingested within the hour (the API crawls, and uploader users submit their own salts).
// Only on a miss does the UI offer the explicit Steam fallback, behind a 20-minute cooldown.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  getItems,
  getItemStats,
  getMatchMetadata,
  getPlayerMatchHistory,
  getPlayerMetrics,
  MatchNotIngestedError,
  steamFetchAvailableAt,
} from "../api/deadlock";
import { computeItemCounters } from "../lib/counters";
import { getWpStats, type WpStats } from "../api/wpStats";
import {
  analyzeMatch,
  deathInsights,
  type MatchAnalysis,
} from "../lib/matchAnalysis";
import { climbBand, tierToMaxBadge, tierToMinBadge } from "../lib/ranks";
import { friendlyError } from "../lib/errors";
import { ModalShell } from "./ModalShell";
import type { Hero, ItemCounters, MatchHistoryRow, MatchInfo } from "../types";

const mmss = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const ago = (unix: number) => {
  const h = (Date.now() / 1000 - unix) / 3600;
  if (h < 1.5) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 36) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} d ago`;
};

/** The WP trajectory as a small line chart: one series (no legend — the title names it), a dashed
 * 50% midline, death ticks under the baseline, and a tap/hover readout instead of a floating
 * tooltip (touch-safe, no overlay to collide with labels). */
function WpChart({ a }: { a: MatchAnalysis }) {
  const [pick, setPick] = useState<number | null>(null);
  const points = a.wp.points;
  if (points.length < 2) return null;
  const W = 560;
  const H = 96;
  const PAD = 6;
  const tMax = points[points.length - 1].t || 1;
  const x = (t: number) => PAD + (t / tMax) * (W - 2 * PAD);
  const y = (wp: number) => PAD + (1 - wp) * (H - 2 * PAD);
  const path = points
    .map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.wp).toFixed(1)}`)
    .join(" ");
  const area = `${path} L${x(tMax).toFixed(1)},${H - PAD} L${PAD},${H - PAD} Z`;
  const deaths = (a.focus.death_details ?? []).map((d) => d.game_time_s);
  const last = points[points.length - 1];
  const picked = pick !== null ? points[pick] : null;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * tMax;
    let best = 0;
    for (let i = 1; i < points.length; i++)
      if (Math.abs(points[i].t - t) < Math.abs(points[best].t - t)) best = i;
    setPick(best);
  };

  return (
    <div className="wpchart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Win probability over the match"
        onPointerMove={onMove}
        onPointerLeave={() => setPick(null)}
      >
        <line x1={PAD} x2={W - PAD} y1={y(0.5)} y2={y(0.5)} className="wpmid" />
        <path d={area} className="wparea" />
        <path d={path} className="wpline" />
        {deaths.map((t, i) => (
          <line
            key={i}
            x1={x(t)}
            x2={x(t)}
            y1={H - PAD}
            y2={H - PAD - 5}
            className="wpdeath"
          />
        ))}
        {picked && (
          <circle
            cx={x(picked.t)}
            cy={y(picked.wp)}
            r={3.5}
            className="wpdot"
          />
        )}
      </svg>
      <div className="wpread">
        {picked ? (
          <>
            {mmss(picked.t)} — {picked.lead >= 0 ? "up" : "down"}{" "}
            {Math.abs(Math.round(picked.lead / 100) / 10)}k souls →{" "}
            {Math.round(picked.wp * 100)}% win
          </>
        ) : (
          <>
            ends at {Math.round(last.wp * 100)}% · ▎ death
            {a.deaths.total === 1 ? "" : "s"} marked on the baseline
          </>
        )}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  steady: "steady farm",
  swingy: "fights & obj",
  passive: "passive",
};

export function MatchModal({
  accountId,
  heroes,
  autoLoadLatest = false,
  autoLoadMatchId = null,
  onClose,
}: {
  /** The stored profile's account id; enables the recent-games list and picks the seat. */
  accountId: number | null;
  heroes: Hero[];
  /** Open straight onto a game (the build page's "analyze last game" link). */
  autoLoadLatest?: boolean;
  /** Which game to open when {@link autoLoadLatest} is set — the build page passes the player's last
   * game on the *selected hero*, since that's the hero whose build they're reading. Null (never
   * played it) falls back to their most recent game on any hero. */
  autoLoadMatchId?: number | null;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const [recent, setRecent] = useState<MatchHistoryRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notIngested, setNotIngested] = useState<number | null>(null);
  const [steamWaitMin, setSteamWaitMin] = useState(0);
  const [match, setMatch] = useState<MatchInfo | null>(null);
  const [seat, setSeat] = useState<number | null>(null);
  const [wpStats, setWpStats] = useState<WpStats | null>(null);
  const [analysis, setAnalysis] = useState<MatchAnalysis | null>(null);
  // Items that answer the repeat killer, if this game had one — the death read with a build answer.
  const [nemesisItems, setNemesisItems] = useState<ItemCounters[]>([]);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    getWpStats().then(
      (s) => live.current && setWpStats(s),
      () => {},
    );
    return () => {
      live.current = false;
    };
  }, []);

  const heroName = (id: number) =>
    heroes.find((h) => h.id === id)?.name ?? `Hero ${id}`;

  async function load(matchId: number, allowSteam = false) {
    setBusy(true);
    setError(null);
    setNotIngested(null);
    setMatch(null);
    setAnalysis(null);
    setSeat(null);
    try {
      const m = await getMatchMetadata(matchId, { allowSteam });
      if (!live.current) return;
      setMatch(m);
      const focusId =
        accountId && m.players.some((p) => p.account_id === accountId)
          ? accountId
          : null;
      if (focusId) await analyze(m, focusId);
    } catch (e) {
      if (!live.current) return;
      if (e instanceof MatchNotIngestedError) {
        setNotIngested(matchId);
        setSteamWaitMin(
          Math.max(
            0,
            Math.ceil((steamFetchAvailableAt() - Date.now()) / 60000),
          ),
        );
      } else setError(friendlyError(e));
    } finally {
      if (live.current) setBusy(false);
    }
  }

  async function analyze(m: MatchInfo, focusId: number) {
    setSeat(focusId);
    const focus = m.players.find((p) => p.account_id === focusId);
    // Benchmark this game against the rank you're CLIMBING TO — one tier above the match's own
    // average badge — so "this game vs the ladder" reads as "vs where I'm trying to get", matching
    // the build page's fundamentals card.
    const badge =
      (focus?.team === "Team0"
        ? m.average_badge_team0
        : m.average_badge_team1) ?? 80;
    const climb = climbBand(Math.floor(badge / 10));
    const minBadge = tierToMinBadge(climb.lo);
    const maxBadge = tierToMaxBadge(climb.hi);
    const ladder = await getPlayerMetrics({
      heroId: focus?.hero_id,
      minBadge,
      maxBadge,
      minUnixTimestamp: Math.floor(Date.now() / 1000) - 30 * 86400,
    }).catch(() => null);
    if (!live.current) return;
    const a = analyzeMatch(m, focusId, wpStats, ladder);
    setAnalysis(a);
    setNemesisItems([]);

    // A repeat killer is the one death read with a *build* answer, so price it with the same
    // counters engine the build page uses: items on this hero that measurably over-perform against
    // that specific enemy, above the matchup's own lean. Two analytics calls (the fast rate family),
    // fired only when a nemesis actually exists.
    const nem = a?.deaths.nemesis;
    if (!nem || !focus) return;
    try {
      const itemMap = await getItems();
      // "What item beats this hero" is fairly rank-stable, so use a rank FLOOR (no ceiling) rather
      // than the match's narrow band — a wider population gives confident samples instead of the
      // ⚠ thin ones a single sub-tier yields, and the counter engine already de-leans the matchup.
      const base = {
        heroId: focus.hero_id,
        minBadge,
        minUnixTimestamp: Math.floor(Date.now() / 1000) - 30 * 86400,
      };
      const [baseline, vsNemesis] = await Promise.all([
        getItemStats(base),
        getItemStats({ ...base, enemyHeroIds: [nem.heroId] }),
      ]);
      if (!live.current) return;
      const { counters } = computeItemCounters(
        baseline,
        [{ enemyHeroId: nem.heroId, stats: vsNemesis }],
        itemMap,
      );
      setNemesisItems(counters.slice(0, 3));
    } catch {
      /* counters are a bonus — a failure here must not blank the analysis */
    }
  }

  // Return to the recent-games list, dropping the current match.
  const back = () => {
    setMatch(null);
    setAnalysis(null);
    setSeat(null);
    setNemesisItems([]);
    setNotIngested(null);
    setError(null);
    setInput("");
  };

  const submit = () => {
    const id = Number(input.replace(/\D/g, ""));
    if (id > 0) void load(id);
  };

  // Recent games for the stored profile (one fetch per open). When opened via the build page's
  // "analyze last game" link, jump straight to the newest game. Declared after `load` so it can call
  // it; the fetch continuation keeps the state updates off the synchronous effect body.
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (!accountId) return;
    getPlayerMatchHistory(accountId).then(
      (rows) => {
        if (!live.current) return;
        const recentRows = rows.filter(
          (r) => r.start_time > Date.now() / 1000 - 21 * 86400,
        );
        setRecent(recentRows.slice(0, 8));
        if (autoLoadLatest && !autoLoaded.current && recentRows.length > 0) {
          autoLoaded.current = true;
          // Prefer the caller's target (the selected hero's last game); fall back to the newest.
          const target = autoLoadMatchId ?? recentRows[0].match_id;
          setInput(String(target));
          void load(target);
        }
      },
      () => live.current && setRecent([]),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, autoLoadLatest, autoLoadMatchId]);

  const a = analysis;
  const maxShare = useMemo(
    () => (a ? Math.max(...a.economy.map((r) => r.share), 0.01) : 1),
    [a],
  );

  return (
    <ModalShell
      className="lab"
      label="Match analysis"
      title={
        <>
          Match analysis <span className="labtag">beta</span>
        </>
      }
      onClose={onClose}
    >
      {/* Back to the recent-games list once a match is open (or was requested). */}
      {(match || notIngested) && recent && recent.length > 0 && (
        <button type="button" className="matchback" onClick={back}>
          ← Recent games
        </button>
      )}

      <div className="matchinput">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="match id (post-game screen / history)"
          inputMode="numeric"
          aria-label="Match id"
        />
        <button type="button" onClick={submit} disabled={busy}>
          {busy ? "Loading…" : "Analyze"}
        </button>
      </div>

      {recent && recent.length > 0 && !match && (
        <div className="matchrecent">
          <h3>Recent games</h3>
          {recent.map((r) => (
            <button
              type="button"
              key={r.match_id}
              className="matchrow"
              onClick={() => {
                setInput(String(r.match_id));
                void load(r.match_id);
              }}
            >
              <span
                className={r.match_result === r.player_team ? "mwin" : "mloss"}
              >
                {r.match_result === r.player_team ? "WIN" : "LOSS"}
              </span>
              <span className="mhero">{heroName(r.hero_id)}</span>
              <span className="mkda">
                {r.player_kills}/{r.player_deaths}/{r.player_assists}
              </span>
              <span className="mwhen">{ago(r.start_time)}</span>
            </button>
          ))}
          <p className="matchnote">
            Just played and it&rsquo;s missing? The list comes from Steam and
            can lag ~an hour behind; paste the match id from the post-game
            screen instead. To get your games in reliably and fast, run
            deadlock-api&rsquo;s{" "}
            <a
              href="https://deadlock-api.com/ingest-cache"
              target="_blank"
              rel="noreferrer noopener"
            >
              game uploader
            </a>
            .
          </p>
        </div>
      )}

      {error && <div className="banner error">⚠ {error}</div>}

      {notIngested && (
        <div className="banner">
          This match isn&rsquo;t in the stats database yet — most games arrive
          within the hour.{" "}
          {steamWaitMin > 0 ? (
            <>Steam lookup available in ~{steamWaitMin} min.</>
          ) : (
            <button
              type="button"
              className="linkbtn"
              onClick={() => void load(notIngested, true)}
            >
              Try a direct Steam lookup (slow; a few per hour)
            </button>
          )}{" "}
          Running deadlock-api&rsquo;s{" "}
          <a
            href="https://deadlock-api.com/ingest-cache"
            target="_blank"
            rel="noreferrer noopener"
          >
            game uploader
          </a>{" "}
          gets your future games in automatically.
        </div>
      )}

      {match && !a && !busy && (
        <div className="matchrecent">
          <h3>Whose game is it?</h3>
          {match.players.map((p) => (
            <button
              type="button"
              key={p.player_slot}
              className="matchrow"
              onClick={() => void analyze(match, p.account_id)}
            >
              <span className="mhero">{heroName(p.hero_id)}</span>
              <span className="mkda">
                {p.kills}/{p.deaths}/{p.assists}
              </span>
              <span className="mwhen">
                {p.team === match.winning_team ? "won" : "lost"}
              </span>
            </button>
          ))}
        </div>
      )}

      {a && (
        <>
          <div className="matchhead">
            <span className={a.won ? "mwin" : "mloss"}>
              {a.won ? "WIN" : "LOSS"}
            </span>
            <strong>{heroName(a.focus.hero_id)}</strong>
            <span className="mkda">
              {a.focus.kills}/{a.focus.deaths}/{a.focus.assists}
            </span>
            <span className="mmuted">
              {Math.round(a.focus.net_worth / 100) / 10}k souls ·{" "}
              {Math.round(a.durationS / 60)} min
            </span>
            {seat !== accountId && (
              <button
                type="button"
                className="linkbtn"
                onClick={() => {
                  setAnalysis(null);
                  setSeat(null);
                }}
              >
                switch player
              </button>
            )}
          </div>

          {a.wp.points.length >= 2 && (
            <section>
              <h3>Win probability</h3>
              <WpChart a={a} />
              {a.wp.swings[0] && (
                <p className="matchnote">
                  Biggest swing: {mmss(a.wp.swings[0].fromT)}–
                  {mmss(a.wp.swings[0].toT)} (
                  {a.wp.swings[0].delta > 0 ? "+" : ""}
                  {Math.round(a.wp.swings[0].delta * 100)} pts
                  {a.wp.swings[0].delta > 0 === a.won ? "" : " the wrong way"}
                  ).
                </p>
              )}
            </section>
          )}

          {a.fundamentals.length > 0 && (
            <section>
              <h3>
                This game vs your climb{" "}
                <span className="mmuted">
                  (same hero, one rank up; one game is noisy)
                </span>
              </h3>
              <div className="fundrows">
                {a.fundamentals.map((r) => (
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

          <section>
            <h3>Where the souls came from</h3>
            <div className="econrows">
              {a.economy.map((r) => (
                <div className="econrow" key={r.key}>
                  <span className="flabel">{r.label}</span>
                  <span className={`econkind k-${r.kind}`}>
                    {KIND_LABEL[r.kind]}
                  </span>
                  <span className="fbar">
                    <span
                      className={`k-${r.kind}`}
                      style={{ width: `${(r.share / maxShare) * 100}%` }}
                    />
                  </span>
                  <span className="fval">{(r.gold / 1000).toFixed(1)}k</span>
                  <span className="fpct">{Math.round(r.perMin)}/min</span>
                  <span
                    className={
                      "epct" +
                      (r.percentile === undefined
                        ? ""
                        : r.percentile >= 60
                          ? " hi"
                          : r.percentile < 35
                            ? " lo"
                            : "")
                    }
                    title={
                      r.percentile !== undefined
                        ? "vs players on this hero one rank up"
                        : undefined
                    }
                  >
                    {r.percentile !== undefined ? `p${r.percentile}` : ""}
                  </span>
                </div>
              ))}
            </div>
            <p className="matchnote">
              <em>steady farm</em> — lane, camps, breakables, denies — arrives
              whether or not fights go your way (lane is the least win-tied
              source of all). <em>Fights &amp; objectives</em> are contested and
              ride on the game going your way. Neither is a grade. Percentiles
              are vs players on this hero one rank up, where available.
            </p>
          </section>

          <section>
            <h3>Deaths</h3>
            <p className="matchdeaths">
              {a.deaths.total} total —{" "}
              {a.deaths.byPhase
                .filter((b) => b.count > 0)
                .map((b) => `${b.count} in ${b.label}`)
                .join(", ") || "clean game"}
              {a.deaths.goldLost
                ? ` · ${(a.deaths.goldLost / 1000).toFixed(1)}k souls lost to deaths`
                : ""}
            </p>

            {(() => {
              const lines = deathInsights(
                a.deaths,
                a.deaths.nemesis
                  ? heroName(a.deaths.nemesis.heroId)
                  : undefined,
              );
              if (!lines.length) return null;
              return (
                <div className="climbtips">
                  <span className="climbhdr">What the deaths say</span>
                  {lines.map((l) => (
                    <div className="deathread" key={l}>
                      {l}
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* The nemesis is the one death read with a build answer — same counters engine as
                    the build page, conditioned on that single enemy. */}
            {a.deaths.nemesis && nemesisItems.length > 0 && (
              <div className="nemesis">
                <span className="climbhdr">
                  Build against {heroName(a.deaths.nemesis.heroId)}
                </span>
                {nemesisItems.map((c) => (
                  <div className="nemrow" key={c.item.id}>
                    <span className="nemitem">{c.item.name}</span>
                    <span className="nemedge">
                      +{(c.topDelta * 100).toFixed(1)} pt
                    </span>
                    <span className="nemn">
                      n={c.marks[0]?.sample.toLocaleString()}
                      {c.marks[0]?.lowSample ? " ⚠" : ""}
                    </span>
                  </div>
                ))}
                <p className="matchnote">
                  Win-rate gain for {heroName(a.focus.hero_id)} players who
                  bought these <em>against that hero</em>, above the
                  matchup&rsquo;s own lean. Raw rates — lean on the bigger
                  samples.
                </p>
              </div>
            )}
          </section>
        </>
      )}
    </ModalShell>
  );
}
