// "Should I keep queueing?" — the loss-streak read, with the confound named.
//
// The streak table is shown because people want to see it, but it is DELIBERATELY not the verdict:
// a low win rate after two losses is equally consistent with tilt and with the ladder correcting an
// inflated rating, and those have opposite advice. The verdict comes from the requeue-vs-rest
// contrast underneath it (see lib/sessions), which is the part that can actually tell them apart.
//
// Most of the time the honest answer is "not enough games to say", and the card says that rather
// than defaulting to the folk wisdom.

import "./SessionCard.css";
import { tiltVerdict, type SessionStats } from "../lib/sessions";

export function SessionCard({ stats }: { stats: SessionStats }) {
  const worst = stats.byStreak.reduce(
    (a, b) => (b.games >= 8 && b.winRate < a.winRate ? b : a),
    stats.byStreak[0],
  );
  return (
    <section className="sessioncard">
      <h2>
        Sessions{" "}
        <span className="sub">
          {stats.games.toLocaleString()} games over {stats.sessions} sittings
        </span>
      </h2>

      <div className="strows">
        <div className="strow sthdr">
          <span>after</span>
          <span />
          <span className="stn">games</span>
          <span className="stwr">win %</span>
        </div>
        {stats.byStreak.map((r) => (
          <div
            className={`strow${r === worst && r.losses > 0 ? " low" : ""}`}
            key={r.losses}
          >
            <span className="stlabel">
              {r.losses === 0
                ? "a win"
                : `${r.losses}${r.atLeast ? "+" : ""} loss${r.losses > 1 ? "es" : ""}`}
            </span>
            <span className="stbar">
              <span
                className={r.winRate >= 0.5 ? "hi" : "lo"}
                style={{ width: `${Math.min(100, r.winRate * 100)}%` }}
              />
            </span>
            <span className="stn">{r.games.toLocaleString()}</span>
            <span className="stwr">{Math.round(r.winRate * 100)}%</span>
          </div>
        ))}
      </div>

      <p className="stverdict">{tiltVerdict(stats.tilt)}</p>

      <p className="matchnote">
        The table above can't tell tilt from the ladder correcting your rating —
        both produce exactly this shape, and a 3-loss streak happens ~12% of the
        time at a 50% win rate by chance alone. Only the requeue-vs-rest split
        separates them, because a break fixes tilt and doesn't fix a rating.
        {stats.longestSession >= 8 && (
          <> Longest sitting: {stats.longestSession} games.</>
        )}
      </p>
    </section>
  );
}
