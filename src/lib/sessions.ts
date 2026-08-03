// Sessions, loss streaks, and whether stopping actually helps — measured, not assumed.
//
// "Stop playing after two losses" is the most repeated piece of climbing advice there is, and the
// evidence for it is weaker than its confidence. The raw correlation is real — win rate after a
// loss streak IS lower — but at least three things produce that pattern and only one of them is
// tilt:
//
//   1. TILT. You play worse because you're rattled. Stopping helps.
//   2. RATING REGRESSION. You were above your true skill, and the streak is the ladder correcting.
//      Stopping does nothing; you are simply at your rank.
//   3. BASE RATES. At a ~50% win rate a three-loss streak happens ~12.5% of the time by chance.
//      Most streaks mean nothing at all.
//
// A "win rate after N losses" table cannot separate these, so this file does not stop there. The
// separator is TIME: rating regression is persistent — a break does not fix an inflated rating —
// whereas tilt decays. So among games that all began under the same streak condition, we contrast
// the ones queued straight back into with the ones played after a real break. Same streak state,
// different rest. If the deficit shrinks with rest, that's tilt and stopping helps; if it doesn't,
// it's regression and the honest advice is "this is your rank", not "stop playing".
//
// A per-account history is small, so the contrast is usually underpowered. It reports a confidence
// interval and refuses to name a direction unless that interval excludes zero — the expected
// outcome is "can't tell yet", and saying so is the point.
//
// No population baseline: it can't be built from the harvested shards. Those are a ~12k/day sample
// of matches, so consecutive games by the same account are almost never both in it, and a player's
// streak history simply isn't reconstructable. The within-player contrast needs no baseline anyway,
// which is a further reason to lead with it.

import type { MatchHistoryRow } from "../types";

/** Idle time that ends a session. Two hours is long enough to survive a queue, a lobby and a
 * bathroom break, and short enough that a genuine "came back later" lands in a new one. Used only
 * for describing sessions — the streak state below deliberately ignores it. */
export const SESSION_GAP_S = 2 * 3600;

/** Queued straight back in: under half an hour between the last game ending and this one starting.
 * This is the "one more" arm. */
export const QUICK_REQUEUE_S = 30 * 60;

/** Came back later: four hours or more. Deliberately a wide gulf away from QUICK_REQUEUE_S rather
 * than adjacent to it, so the two arms are genuinely different conditions and not two halves of one
 * continuum split down the middle. */
export const RESTED_S = 4 * 3600;

/** Losses in a row before a game counts as "on a streak" — the condition both arms share. */
export const STREAK_THRESHOLD = 2;

/** Below this an arm is not reported at all. A proportion from six games carries a ±40pt interval;
 * showing it invites reading noise as a finding even with the interval printed beside it. */
const MIN_ARM = 12;

export interface StreakRow {
  /** Consecutive losses immediately before the game. The last row is a "or more" bucket. */
  losses: number;
  atLeast: boolean;
  games: number;
  wins: number;
  winRate: number;
}

export interface TiltTest {
  /** Games begun on a streak, requeued within {@link QUICK_REQUEUE_S}. */
  quick: { games: number; winRate: number };
  /** Games begun on the same streak condition, after {@link RESTED_S} or more. */
  rested: { games: number; winRate: number };
  /** quick − rested, in win-rate points (negative = requeueing looks worse). */
  delta: number;
  /** 95% half-width on `delta`, same units. */
  ci: number;
  /** True only when the interval excludes zero. Everything else is "can't tell". */
  significant: boolean;
}

export interface SessionStats {
  games: number;
  sessions: number;
  /** Longest run of games without a {@link SESSION_GAP_S} break. */
  longestSession: number;
  overallWinRate: number;
  byStreak: StreakRow[];
  /** The tilt-vs-regression contrast, or null when either arm is too thin to report. */
  tilt: TiltTest | null;
}

const won = (m: MatchHistoryRow) => m.match_result === m.player_team;

/**
 * Session and streak statistics for one account's match history.
 *
 * `history` may arrive in any order; it is sorted ascending here because every quantity below is
 * defined by what came *before* a game.
 */
export function sessionStats(history: MatchHistoryRow[]): SessionStats | null {
  if (history.length < MIN_ARM) return null;
  const games = [...history].sort((a, b) => a.start_time - b.start_time);

  let sessions = 1;
  let longestSession = 1;
  let run = 1;
  let wins = 0;
  // Streak state is carried across session boundaries ON PURPOSE. Resetting it at a break would
  // make every rested game a streak-0 game by construction and delete the contrast this file
  // exists to measure.
  let streak = 0;
  const streakBuckets = new Map<number, { games: number; wins: number }>();
  const quick = { games: 0, wins: 0 };
  const rested = { games: 0, wins: 0 };

  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    const w = won(g);
    if (w) wins++;

    const bucket = Math.min(streak, STREAK_THRESHOLD + 1);
    const b = streakBuckets.get(bucket) ?? { games: 0, wins: 0 };
    b.games++;
    if (w) b.wins++;
    streakBuckets.set(bucket, b);

    if (i > 0) {
      const prev = games[i - 1];
      const gap = g.start_time - (prev.start_time + prev.match_duration_s);
      if (gap > SESSION_GAP_S) {
        sessions++;
        run = 1;
      } else {
        run++;
        longestSession = Math.max(longestSession, run);
      }
      // The experiment: same streak condition, different rest.
      if (streak >= STREAK_THRESHOLD) {
        if (gap < QUICK_REQUEUE_S) {
          quick.games++;
          if (w) quick.wins++;
        } else if (gap >= RESTED_S) {
          rested.games++;
          if (w) rested.wins++;
        }
      }
    }

    streak = w ? 0 : streak + 1;
  }

  const byStreak: StreakRow[] = [];
  for (let k = 0; k <= STREAK_THRESHOLD + 1; k++) {
    const b = streakBuckets.get(k);
    if (!b || b.games === 0) continue;
    byStreak.push({
      losses: k,
      atLeast: k === STREAK_THRESHOLD + 1,
      games: b.games,
      wins: b.wins,
      winRate: b.wins / b.games,
    });
  }

  return {
    games: games.length,
    sessions,
    longestSession,
    overallWinRate: wins / games.length,
    byStreak,
    tilt: tiltTest(quick, rested),
  };
}

/** Two-proportion contrast with a normal-approximation 95% interval. Null unless both arms clear
 * {@link MIN_ARM} — an interval wider than the effect is not a result, it's an invitation to
 * misread one. */
function tiltTest(
  quick: { games: number; wins: number },
  rested: { games: number; wins: number },
): TiltTest | null {
  if (quick.games < MIN_ARM || rested.games < MIN_ARM) return null;
  const p1 = quick.wins / quick.games;
  const p2 = rested.wins / rested.games;
  const se = Math.sqrt(
    (p1 * (1 - p1)) / quick.games + (p2 * (1 - p2)) / rested.games,
  );
  const ci = 1.96 * se;
  const delta = p1 - p2;
  return {
    quick: { games: quick.games, winRate: p1 },
    rested: { games: rested.games, winRate: p2 },
    delta,
    ci,
    significant: Math.abs(delta) > ci,
  };
}

/**
 * What the contrast actually licenses saying. Three outcomes, and two of them are "don't change
 * anything" — which is the correct output most of the time and the reason this returns prose rather
 * than a verdict chip.
 */
export function tiltVerdict(t: TiltTest | null): string {
  if (!t)
    return (
      `Not enough games on a losing streak yet to separate tilt from the ladder simply ` +
      `correcting your rating. Both look identical in a win-rate table; only the contrast ` +
      `between requeueing and resting can tell them apart.`
    );
  const pts = (v: number) => `${Math.abs(Math.round(v * 1000) / 10)}pt`;
  if (!t.significant)
    return (
      `On a streak you win ${pct(t.quick.winRate)} requeueing (${t.quick.games} games) vs ` +
      `${pct(t.rested.winRate)} after a break (${t.rested.games}) — a ${pts(t.delta)} gap with a ` +
      `±${pts(t.ci)} margin, so it's indistinguishable from noise. No evidence stopping helps you ` +
      `specifically; the streaks are more likely the ladder finding your rank than tilt.`
    );
  return t.delta < 0
    ? `On a streak you win ${pct(t.quick.winRate)} requeueing within half an hour vs ` +
        `${pct(t.rested.winRate)} coming back later — ${pts(t.delta)} worse, outside the ` +
        `±${pts(t.ci)} margin. That gap survives a break, which is what tilt looks like and what ` +
        `rating regression doesn't. Stopping after two is worth it for you.`
    : `On a streak you actually win MORE requeueing (${pct(t.quick.winRate)} vs ` +
        `${pct(t.rested.winRate)}), outside the ±${pts(t.ci)} margin — whatever the streaks are, ` +
        `they aren't tilt, and stopping isn't your lever.`;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
