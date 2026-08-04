// The Soul pace panel — "where does the game leave you?"
//
// The flagship diagnostic. Two layers, and the ORDER matters: the phase rows come first because
// they are the finding, and the curve second because it is the context.
//
//   1. Phase rows: your souls/min in each of the build's four columns, placed on the ladder at this
//      hero and rank. This is the whole point — a single whole-game souls/min percentile averages a
//      p60 lane and a p18 mid into "p38, farm better", which names no span and suggests no action.
//   2. The curve: your net worth against the ladder's p25–p75 band over time, with the winning mean.
//      Secondary, and only when a game is loaded.
//
// The rows are also the chart's table-view twin: every value the curve encodes in position is also
// present as a number in a row, so nothing is reachable by colour or hover alone.
//
// Framing rule inherited from lib/pace: nothing here attaches a win rate to a phase. Farming more
// in a window does not cause wins at fixed total net worth (the measured gradient is ~0), so a weak
// phase is a place to LOOK, not a lever with a payout.

import "./PacePanel.css";
import type { PaceDiagnosis, PaceProfile, PaceWindowRead } from "../lib/pace";
import { paceInsight } from "../lib/pace";
import { useMeasuredWidth } from "./useMeasuredWidth";

/** Your net worth at the profile's own tick grid — index-aligned with `profile.ticks`. */
export interface PaceCurve {
  /** Net worth at each tick, or null past the end of the game. */
  nw: Array<number | null>;
  won: boolean;
}

const mmss = (s: number) => `${Math.round(s / 60)}′`;
const souls = (n: number) =>
  n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

// Plot geometry. The viewBox includes the x-label band so the card can never grow a nested
// scrollbar around a plot that fits while its axis doesn't.
//
// Width is MEASURED rather than fixed (useMeasuredWidth): the column this card sits in is as wide
// as the screen allows, and a fixed viewBox stretched to fill it distorts every glyph, flattens the
// curve, and turns the endpoint marker into an ellipse. At 1:1 the user units below are CSS pixels.
const W_FALLBACK = 420;
const W_MIN = 240;
const PLOT_H = 96;
const AXIS_H = 13;
const PAD_T = 7;

export function PacePanel({
  profile,
  heroName,
  rankLabel,
  dataRankLabel,
  reads,
  diagnosis,
  curve,
}: {
  profile: PaceProfile;
  heroName: string;
  rankLabel: string;
  dataRankLabel?: string;
  reads: PaceWindowRead[];
  diagnosis: PaceDiagnosis | null;
  curve?: PaceCurve | null;
}) {
  const [chartRef, measured] = useMeasuredWidth<HTMLElement>(W_FALLBACK);
  const W = Math.max(W_MIN, measured);

  const ticks = profile.ticks.filter((t) => t.lv);
  const mid = profile.levelPcts.indexOf(50);
  const lo = 0;
  const hi = profile.levelPcts.length - 1;

  const t0 = ticks[0]?.t ?? 0;
  const tN = ticks[ticks.length - 1]?.t ?? 1;
  const span = tN - t0 || 1;
  const peak =
    1.06 *
    Math.max(
      ...ticks.map((t) => Math.max(t.lv![hi], t.won ?? 0)),
      ...(curve?.nw.map((v) => v ?? 0) ?? [0]),
      1,
    );
  const x = (t: number) => ((t - t0) / span) * W;
  const y = (v: number) => PAD_T + (1 - v / peak) * (PLOT_H - PAD_T);
  const line = (pts: Array<[number, number]>) =>
    pts
      .map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`)
      .join(" ");

  // p25–p75 as one closed band: up the low edge, back down the high one.
  const band =
    ticks.length > 1
      ? `${line(ticks.map((t) => [x(t.t), y(t.lv![lo])]))} ` +
        `${[...ticks]
          .reverse()
          .map((t) => `L${x(t.t).toFixed(1)} ${y(t.lv![hi]).toFixed(1)}`)
          .join(" ")} Z`
      : "";
  const medianPts = ticks.map(
    (t) => [x(t.t), y(t.lv![mid >= 0 ? mid : 0])] as [number, number],
  );
  const wonTicks = ticks.filter((t) => t.won !== null);
  const wonPts = wonTicks.map((t) => [x(t.t), y(t.won!)] as [number, number]);
  const youTicks = curve
    ? ticks.filter(
        (t, i) => curve.nw[profile.ticks.indexOf(t)] != null && i >= 0,
      )
    : [];
  const youPts = curve
    ? youTicks.map(
        (t) =>
          [x(t.t), y(curve.nw[profile.ticks.indexOf(t)]!)] as [number, number],
      )
    : [];

  const lastYou = youPts.length ? youPts[youPts.length - 1] : null;
  const lastYouVal = youTicks.length
    ? curve!.nw[profile.ticks.indexOf(youTicks[youTicks.length - 1])]!
    : null;
  const lastMedian = ticks.length
    ? ticks[ticks.length - 1].lv![mid >= 0 ? mid : 0]
    : null;

  const hasCurve = youPts.length > 1;
  const chartLabel = hasCurve
    ? `Your net worth over time against the ${dataRankLabel ?? rankLabel} band for ${heroName}. ` +
      `At ${mmss(youTicks[youTicks.length - 1].t)} you had ${Math.round(lastYouVal!)} souls; ` +
      `the median was ${lastMedian}.`
    : `Net worth over time for ${heroName} at ${dataRankLabel ?? rankLabel}: the middle half of ` +
      `games, the median, and the mean among games won.`;

  return (
    <section className="pace">
      <h2>
        Soul pace{" "}
        <span className="sub">
          where the game leaves {heroName} at {rankLabel}
        </span>
      </h2>

      {diagnosis ? (
        <p className={`paceverdict${diagnosis.falloff ? " falloff" : ""}`}>
          {paceInsight(diagnosis)}
        </p>
      ) : reads.length > 0 ? (
        <p className="paceverdict ok">
          Your income holds up across every phase at this rank — no single span
          is where the game gets away.
        </p>
      ) : null}

      {reads.length > 0 && (
        <div className="pacerows">
          <div className="pacerow pacehdr">
            <span />
            <span />
            <span className="ppop">median</span>
            <span className="ppct" />
          </div>
          {reads.map((r) => {
            const weak = diagnosis?.weakest.label === r.label;
            return (
              <div
                className={`pacerow${weak ? " weak" : ""}`}
                key={r.label}
                title={`${r.label} (${Math.round(r.fromS / 60)}–${Math.round(r.toS / 60)} min): you ${Math.round(r.rate)} souls/min vs a ladder median of ${Math.round(r.median)}, from ${r.n.toLocaleString()} games.`}
              >
                <span className="plabel">{r.label}</span>
                <span className="pbar">
                  <span
                    className={
                      r.percentile >= 75 ? "hi" : r.percentile < 25 ? "lo" : ""
                    }
                    style={{ width: `${r.percentile}%` }}
                  />
                </span>
                <span className="ppop">{Math.round(r.median)}/min</span>
                <span className="ppct">
                  <span className="pyou">{Math.round(r.rate)}</span>
                  <span className="pp">p{r.percentile}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {ticks.length > 1 && (
        <>
          <figure className="pacechart" ref={chartRef}>
            <svg
              viewBox={`0 0 ${W} ${PLOT_H + AXIS_H}`}
              role="img"
              aria-label={chartLabel}
            >
              {/* Recessive hairline baseline — solid, never dashed. */}
              <line
                x1="0"
                y1={PLOT_H}
                x2={W}
                y2={PLOT_H}
                className="paxis"
                vectorEffect="non-scaling-stroke"
              />
              {band && <path d={band} className="pband" />}
              <path
                d={line(medianPts)}
                className="pmedian"
                vectorEffect="non-scaling-stroke"
              />
              {wonPts.length > 1 && (
                <path
                  d={line(wonPts)}
                  className="pwon"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {hasCurve && (
                <path
                  d={line(youPts)}
                  className="pyouline"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {hasCurve && lastYou && (
                // A 2px surface ring, not a border, so the marker reads over whichever line it
                // happens to land on.
                <circle
                  cx={lastYou[0]}
                  cy={lastYou[1]}
                  r="3.5"
                  className="pdot"
                />
              )}
              {ticks.map((t, i) =>
                // Label the ends only — a number on every point is chaos, and the rows carry
                // the values anyway.
                i === 0 || i === ticks.length - 1 ? (
                  <text
                    key={t.t}
                    x={i === 0 ? 1 : W - 1}
                    y={PLOT_H + AXIS_H - 3}
                    className="ptick"
                    textAnchor={i === 0 ? "start" : "end"}
                  >
                    {mmss(t.t)}
                  </text>
                ) : null,
              )}
            </svg>
            <figcaption className="pacelegend">
              <span className="lg band">middle half</span>
              <span className="lg median">median</span>
              {wonPts.length > 1 && <span className="lg won">won games</span>}
              {hasCurve && (
                <span className="lg you">
                  your last game{curve!.won ? " (won)" : " (lost)"}
                </span>
              )}
            </figcaption>
          </figure>
          {hasCurve && lastYouVal !== null && lastMedian !== null && (
            <p className="pacegap">
              At {mmss(youTicks[youTicks.length - 1].t)} you had{" "}
              <strong>{souls(lastYouVal)}</strong> souls; the median game had{" "}
              <strong>{souls(lastMedian)}</strong>.
            </p>
          )}
        </>
      )}

      <p className="matchnote">
        {profile.ticks.find((t) => t.n)?.n.toLocaleString() ?? "—"} games at{" "}
        {dataRankLabel ?? rankLabel}
        {profile.substituted && dataRankLabel
          ? " (nearest rank with data)"
          : ""}{" "}
        · later points describe games that <em>lasted</em> that long, which are
        the closer ones · more souls in a phase doesn't by itself win games, so
        read this as where to look, not a lever.
      </p>
    </section>
  );
}
