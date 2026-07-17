// Game-clock scrubber (prototype, off by default — the "Clock" toggle in the controls). A
// horizontal time axis rendered above the phase columns: scrub to a minute and the build
// highlights what you should own by then (App.tsx wraps rows via ScrubWrap), while this bar
// shows the expected soul spend at that instant (phase budgets, linearly ramped) and what a
// typical lead is worth then (the baked wp-stats win-probability surface). To remove the
// feature entirely: delete this file, lib/timeline.ts, the `scrub*` lines in App.tsx, and the
// scrubber block in App.css.

import type { ReactElement, ReactNode } from "react";
import type { GeneratedBuild } from "../types";
import type { WpStats } from "../api/wpStats";
import {
  PHASE_START_S,
  fmtClock,
  leadAtS,
  timelineAt,
  timelineEndS,
  type TimelineSnapshot,
} from "../lib/timeline";

/** Compact souls figure: 1199 → "1.2k", 12304 → "12k". */
function fmtSoulsShort(s: number): string {
  return s >= 10000 ? `${Math.round(s / 1000)}k` : `${(s / 1000).toFixed(1)}k`;
}

export function TimeScrubber({
  build,
  wpStats,
  t,
  onScrub,
}: {
  build: GeneratedBuild;
  wpStats: WpStats | null;
  /** The scrubbed game clock, in seconds. */
  t: number;
  onScrub: (t: number) => void;
}) {
  const endS = timelineEndS(build);
  const clamped = Math.min(t, endS);
  const snap = timelineAt(build, clamped);
  const lead = wpStats ? leadAtS(wpStats, clamped) : null;
  const pct = (s: number) => `${((s / endS) * 100).toFixed(2)}%`;

  return (
    <div className="scrubber">
      <div className="scrubline">
        <span className="scrubclock" aria-hidden="true">
          {fmtClock(clamped)}
        </span>
        <div className="scrubtrack">
          <input
            type="range"
            min={0}
            max={endS}
            step={30}
            value={clamped}
            onChange={(e) => onScrub(Number(e.target.value))}
            aria-label={`Game clock: ${fmtClock(clamped)}`}
          />
          <div className="scrubticks" aria-hidden="true">
            {build.phases.map((p) => (
              <span
                key={p.column}
                className="scrubtick"
                style={{ left: pct(PHASE_START_S[p.column]) }}
              >
                {p.label}
              </span>
            ))}
          </div>
        </div>
      </div>
      <p className="scrubread">
        By <b>{fmtClock(clamped)}</b> — own {snap.ownedCount}/{snap.coreCount}{" "}
        core picks
        {snap.nextName && (
          <>
            {" "}
            · next buy: <b>{snap.nextName}</b>
          </>
        )}{" "}
        · ~<b>{fmtSoulsShort(snap.spentSouls)}</b> souls spent
        {lead && (
          <span
            className="wpnote"
            title={`From the Lab's win-probability model: at this minute, a team up ${lead.sigmaSouls.toLocaleString()} souls — a typical lead for the moment — wins ~${lead.pctAtSigma}% of its games.`}
          >
            {" "}
            · {fmtSoulsShort(lead.sigmaSouls)} lead ≈ {lead.pctAtSigma}% win
          </span>
        )}
      </p>
    </div>
  );
}

/**
 * Row wrapper the phase columns use while the scrubber is active: picks the plan already expects
 * you to own render normally, the next buy gets an accent ring, and everything later recedes.
 * Inert (returns the row unwrapped, byte-identical DOM) when the scrubber is off.
 */
export function ScrubWrap({
  scrub,
  id,
  children,
}: {
  scrub: TimelineSnapshot | null;
  id: number;
  children: ReactElement;
}): ReactNode {
  if (!scrub) return children;
  const cls = scrub.ownedIds.has(id)
    ? "own"
    : scrub.nextId === id
      ? "next"
      : "later";
  return <div className={`scrubwrap ${cls}`}>{children}</div>;
}
