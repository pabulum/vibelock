// The Economy panel — the merged farm/soul story that replaces the old FarmProfile + the economy
// half of the fundamentals card. Three layers, top to bottom:
//   1. Souls/min headline: your recent average vs the climb ladder (the #1 measured climb lever).
//   2. Steady vs swingy breakdown: how THIS hero's souls split across sources at this rank
//      (population median), grouped by reliability — steady farm (lane/camps/breakables/denies) that
//      arrives regardless of fights, vs swingy combat/objective souls that ride on the game going
//      your way. Framing is descriptive, never a grade (see lib/matchAnalysis.EconomyKind).
//   3. Your last game overlaid on that breakdown, in the SAME souls/min units as the population plus
//      a muted percentile — so "480 · p47" reads immediately without a hover.
// Each layer degrades independently: no account ⇒ no headline/overlay; no baked cell for the hero ⇒
// a "gathering data" note instead of the breakdown; the whole panel hides only when it'd be empty.

import type { FundamentalRow } from "../lib/fundamentals";
import type { EconomyKind, HeroFarmProfile } from "../lib/matchAnalysis";

/** One game's per-source read, keyed by the SOURCE_GROUPS row key (lane, camps, boxes, …). */
export interface LastGameFarm {
  won: boolean;
  /** Per row key: the player's souls/min and, for single-source rows, their percentile vs the same
   * population the breakdown shows. Grouped rows (kills+assists) have no percentile. */
  bySrc: Map<string, { perMin: number; percentile?: number }>;
}

const GROUPS: Array<{ kind: EconomyKind; label: string }> = [
  { kind: "steady", label: "Steady farm" },
  { kind: "swingy", label: "Fights & objectives" },
];

/** How far your rate has to sit off the median before it's marked as above/below it, as a fraction.
 * A deadband: without it, rounding alone paints rows as differences they aren't. */
const CMP_DEADBAND = 0.05;

/** Class suffix marking your rate above/below the hero's median — a direction, not a verdict: more
 * of a source isn't automatically better (a roaming game legitimately reads low on lane). */
function cmp(you: number, median: number): string {
  if (median <= 0) return "";
  const delta = (you - median) / median;
  if (delta > CMP_DEADBAND) return " hi";
  if (delta < -CMP_DEADBAND) return " lo";
  return "";
}

export function EconomyPanel({
  profile,
  heroName,
  rankLabel,
  dataRankLabel,
  soulsPerMin,
  lastGame,
}: {
  profile: HeroFarmProfile | null;
  heroName: string;
  rankLabel: string;
  /** Label of the rank the breakdown's norms actually came from (may differ from rankLabel when a
   * nearby tier was substituted). */
  dataRankLabel?: string;
  soulsPerMin?: FundamentalRow | null;
  lastGame?: LastGameFarm | null;
}) {
  const hasYou = !!lastGame && !!profile;
  // One souls/min scale across every row so bar lengths are comparable, sized to whichever is
  // bigger — the median or your game — so neither can overflow the track. The 8% headroom keeps
  // the largest value off the track's edge: without it that row's tick lands at exactly 100%,
  // fusing with the border where it reads as decoration rather than a median marker.
  const scaleMax = profile
    ? 1.08 *
      Math.max(
        ...profile.rows.map((r) =>
          Math.max(r.perMin, lastGame?.bySrc.get(r.key)?.perMin ?? 0),
        ),
        1,
      )
    : 1;
  return (
    <section className={`economy${hasYou ? " has-you" : ""}`}>
      <h2>
        Economy{" "}
        <span className="sub">
          how {heroName} farms at {rankLabel}
        </span>
      </h2>

      {soulsPerMin && (
        <div
          className="ecohead"
          title={`Your souls/min over recent games, vs the rank you're climbing to. Ladder median: ${soulsPerMin.ladderMedian}.`}
        >
          <span className="flabel">Souls/min</span>
          <span className="fval">{soulsPerMin.value}</span>
          <span className="fbar">
            <span
              className={
                soulsPerMin.percentile >= 75
                  ? "hi"
                  : soulsPerMin.percentile < 25
                    ? "lo"
                    : ""
              }
              style={{ width: `${soulsPerMin.percentile}%` }}
            />
          </span>
          <span className="fpct">p{soulsPerMin.percentile}</span>
          <span className="ecovs">vs climb</span>
        </div>
      )}

      {profile ? (
        <>
          <p className="econlead">
            <strong>{Math.round(profile.steadyShare * 100)}%</strong> of{" "}
            {heroName}'s souls are <em>steady farm</em> — lane, camps and
            breakables that come in whether or not fights go your way. The rest
            rides on combat and objectives.
          </p>
          {/* Column headers: without them "486/min  512" gives no clue which number is the hero's
              median and which is yours. Same grid as the rows, so the labels sit over their columns. */}
          <div className="ecorow ecohdr">
            <span />
            <span />
            <span className="fpop">median</span>
            {lastGame && <span className="fyou">you</span>}
          </div>
          {GROUPS.map((g) => {
            const rows = profile.rows.filter((r) => r.kind === g.kind);
            if (rows.length === 0) return null;
            return (
              <div className="ecogroup" key={g.kind}>
                <div className={`ecogrouphdr k-${g.kind}`}>{g.label}</div>
                {rows.map((r) => {
                  const you = lastGame?.bySrc.get(r.key);
                  // The bar always encodes YOU when we know you — matching the souls/min bar above,
                  // which is also yours. The median becomes a tick you can read the bar against
                  // (bar past tick = above median). Without your game there's nothing to confuse it
                  // with, so the bar simply shows the hero's median shape.
                  const fill = you ? you.perMin : r.perMin;
                  return (
                    <div className="ecorow" key={r.key}>
                      <span className="flabel">{r.label}</span>
                      <span className="fbar">
                        <span
                          className={`k-${r.kind}`}
                          style={{ width: `${(fill / scaleMax) * 100}%` }}
                        />
                        {you && (
                          <span
                            className="ftick"
                            style={{ left: `${(r.perMin / scaleMax) * 100}%` }}
                            title={`${r.label} median: ${Math.round(r.perMin)}/min`}
                          />
                        )}
                      </span>
                      <span className="fpop">{Math.round(r.perMin)}/min</span>
                      {lastGame && (
                        <span className="fyou">
                          {you ? (
                            <>
                              <span
                                className={`fyoun${cmp(you.perMin, r.perMin)}`}
                              >
                                {Math.round(you.perMin)}
                              </span>
                              {you.percentile !== undefined && (
                                <span className="fyoup">p{you.percentile}</span>
                              )}
                            </>
                          ) : (
                            ""
                          )}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
          <p className="matchnote">
            Population median at {dataRankLabel ?? rankLabel}
            {profile.substituted && dataRankLabel
              ? " (nearest rank with data)"
              : ""}
            {hasYou ? (
              <>
                {" "}
                · bars and the <em>you</em> column are{" "}
                <em>your last game{lastGame!.won ? " (won)" : " (lost)"}</em>,
                with a tick marking the median — one game, so it's noisy. More
                of a source isn't automatically better.
              </>
            ) : (
              <>
                {" "}
                · per-source souls aren't in career stats, so this is the hero's
                shape, not your average.
              </>
            )}
          </p>
        </>
      ) : (
        <p className="econgather">
          Gathering per-source farm data for {heroName} at this rank — the
          steady-vs-swingy breakdown lights up as games accumulate.
        </p>
      )}
    </section>
  );
}
