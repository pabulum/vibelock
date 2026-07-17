// The Lab: experimental roster-wide statistics from the harvested match window — stats that
// need per-match soul trajectories, which the live analytics API can't provide. Two exhibits:
// hero closing power and state-adjusted item value. Both are explained in plain language
// inline; the methodology lives in scripts/bake-wp-stats.mjs.

import { useEffect, useState } from "react";
import { getWpStats, type WpStats } from "../api/wpStats";
import { ModalShell } from "./ModalShell";

/** Signed percentage points, one decimal: "+3.7" / "−2.9". */
function pts(x: number): string {
  const v = x * 100;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
}

/** Green/red centered on zero — same idea as the build rows' delta colors, tighter scale
 * because excess lives within ±6pt. */
function excessColor(e: number): string {
  if (e >= 0.02) return "#54c66b";
  if (e >= 0.005) return "#a6cf57";
  if (e > -0.005) return "#d8c14a";
  if (e > -0.02) return "#d89a5a";
  return "#d87a7a";
}

export function LabModal({
  heroId,
  onClose,
}: {
  /** Currently selected hero — its row gets highlighted in the closing-power list. */
  heroId: number | null;
  onClose: () => void;
}) {
  const [stats, setStats] = useState<WpStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getWpStats().then(
      (s) => live && setStats(s),
      (e) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  const maxAbs = stats
    ? Math.max(...stats.heroes.map((h) => Math.abs(h.closing)))
    : 1;

  return (
    <ModalShell
      className="lab"
      label="The Lab — experimental statistics"
      title={
        <>
          The Lab <span className="labtag">experimental</span>
        </>
      }
      onClose={onClose}
    >
      <p className="labintro">
        The rest of Vibelock works from the live analytics API. This page works
        from a nightly snapshot of <strong>whole matches</strong> — every
        purchase in every game, with the souls scoreboard as it stood at that
        moment. That lets us ask a question the win-rate columns can&rsquo;t:{" "}
        <em>
          given how the game was going, did this win more than it should have?
        </em>
      </p>

      {error && (
        <div className="banner error">
          ⚠ Couldn&rsquo;t load the Lab data — {error}
        </div>
      )}
      {!stats && !error && <p className="labintro">Loading…</p>}

      {stats && (
        <>
          <section>
            <h3>Closing power — who wins more than their souls say?</h3>
            <p>
              Take every game a hero played and compare two numbers: how often
              their team <strong>actually won</strong>, and how often the{" "}
              <strong>souls scoreboard said they should win</strong> at each
              point in the game. The gap is closing power, in percentage points.
              One honest caveat: this tracks the hero&rsquo;s plain win rate
              closely (r≈0.93) — good heroes close. The genuinely new
              information is the part win rate does <em>not</em> explain, shown
              as the <span className="labstyle up">converter</span> /{" "}
              <span className="labstyle down">snowballer</span> chips: a
              converter wins even games beyond what its win rate predicts (a
              rough lane isn&rsquo;t fatal); a snowballer&rsquo;s wins ride on
              soul leads (force advantages early, don&rsquo;t coast at even
              souls). Both readings are highly stable across independent halves
              of the data (r≈0.97).
            </p>
            <div className="labheroes">
              {stats.heroes.map((h) => (
                <div
                  key={h.id}
                  className={`labhero ${h.id === heroId ? "current" : ""}`}
                >
                  <span className="labname">
                    {h.name}
                    {h.wr !== undefined && (
                      <i className="labwr">{(h.wr * 100).toFixed(1)}%</i>
                    )}
                  </span>
                  <span
                    className="labval"
                    style={{ color: excessColor(h.closing) }}
                  >
                    {pts(h.closing)}
                    {h.resid !== undefined && Math.abs(h.resid) >= 0.015 && (
                      <span
                        className={`labstyle ${h.resid > 0 ? "up" : "down"}`}
                        title={`${pts(h.resid)}pt beyond what the hero's win rate predicts`}
                      >
                        {h.resid > 0 ? "converter" : "snowballer"}
                      </span>
                    )}
                  </span>
                  <span className="labbar">
                    <i
                      style={{
                        width: `${(Math.abs(h.closing) / maxAbs) * 50}%`,
                        [h.closing >= 0 ? "left" : "right"]: "50%",
                        background: excessColor(h.closing),
                      }}
                    />
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3>Item value with the game state stripped out</h3>
            <p>
              An item&rsquo;s raw win rate mixes two things: what the item does,
              and <strong>who was already winning when it got bought</strong>.
              For every purchase we log the win probability implied by the souls
              scoreboard at that exact moment (&ldquo;bought at&rdquo; below);{" "}
              <strong>vs expectation</strong> is how the buyers&rsquo; games
              actually ended, minus that. It reads like the build page&rsquo;s
              win-rate deltas: positive beats the situations it was bought in,
              negative is flattered by them. Note <strong>Metal Skin</strong>:
              bought at{" "}
              {Math.round(
                (stats.items.find((i) => i.name === "Metal Skin")?.wpBuy ??
                  0.43) * 100,
              )}
              % — the most &ldquo;we&rsquo;re in trouble&rdquo; purchase in the
              game — which is exactly why its raw win rate always looks
              terrible.
            </p>
            <p>
              These numbers are <strong>roster-wide</strong>. Hero-specific
              versions aren&rsquo;t shown because they don&rsquo;t survive the
              sample sizes yet — for per-hero item advice, the build
              page&rsquo;s adjusted win rates remain the number to trust.
            </p>
            <div className="labtablewrap">
              <table className="labtable">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Tier</th>
                    <th title="Mean win probability at the moment of purchase">
                      Bought at
                    </th>
                    <th>Win rate</th>
                    <th title="Win rate minus bought-at win probability">
                      Vs expectation
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {stats.items.map((i) => (
                    <tr key={i.id}>
                      <td>{i.name}</td>
                      <td className="labtier">T{i.tier}</td>
                      <td>{Math.round(i.wpBuy * 100)}%</td>
                      <td>{Math.round(i.wr * 100)}%</td>
                      <td style={{ color: excessColor(i.excess) }}>
                        {pts(i.excess)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <p className="labmeta">
            {stats.window.matches.toLocaleString()} matches (
            {stats.window.fromDay} → {stats.window.toDay}),{" "}
            {(stats.window.purchases / 1e6).toFixed(1)}M purchases; refit
            nightly. Items shown need 2,000+ purchases; a value under about ±1
            point is within noise.
            {stats.readiness && (
              <>
                {" "}
                Hero-specific readiness:{" "}
                {stats.readiness.cellsPastK.toLocaleString()} of{" "}
                {stats.readiness.cellsTracked.toLocaleString()} hero-item pairs
                have enough data to stand on their own (median{" "}
                {stats.readiness.medianCellN.toLocaleString()} of the ~
                {stats.readiness.k.toLocaleString()} purchases needed) —
                per-hero versions of this table unlock as that count grows.
              </>
            )}
          </p>
        </>
      )}
    </ModalShell>
  );
}
