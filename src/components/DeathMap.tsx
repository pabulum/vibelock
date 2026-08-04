// The post-game death map: where the population dies, with your own deaths on top.
//
// Form: a density field (sequential, one hue, recessive) under a point overlay (your deaths), on a
// skeleton of the map's real structures. The underlay is context — deaths concentrate where the
// game is played, so landing in a hot cell is the most ordinary thing there is. The finding, when
// there is one, is a cluster of YOUR points, or a depth that the result doesn't support.
//
// ALWAYS DRAWN FROM THE PLAYER'S SIDE: their base at the bottom, the enemy's at the top, for either
// team (lib/deathMap.teamSign). That is what makes "up" mean "forward" and lets one set of baked
// landmarks serve both teams.
//
// Place names here are DERIVED, not invented — the structures come from the API's own objective
// enum with positions measured in the bake, and left/mid/right is a property of the oriented
// display. Community geography ("the jungle") stays out: nothing in the data locates it.
//
// The deaths-by-phase rows already in the Match view are this chart's table-view twin: every death
// is counted there in text, so nothing is reachable only by looking at a picture.

import "./DeathMap.css";
import { useState } from "react";
import {
  cellRect,
  clusterInsight,
  deathCluster,
  decodeDensity,
  depthInsight,
  depthRead,
  landmarks,
  worldToUnit,
  type DeathMark,
} from "../lib/deathMap";
import type { DeathMapData } from "../api/deathMap";

const SIZE = 260; // drawing box, px in viewBox units

const mmss = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function DeathMap({
  marks,
  data,
  heroName,
  won,
}: {
  marks: DeathMark[];
  /** The baked population layer, or null — the map still draws your deaths without it. */
  data: DeathMapData | null;
  heroName: string;
  /** Whether the focus player won. Only used to pick which population to compare depth against. */
  won: boolean;
}) {
  // null = every phase. A filter, not a toggle per series: it re-slices both layers at once so the
  // underlay always describes the same span as the points drawn over it.
  const [phase, setPhase] = useState<number | null>(null);

  const shown = phase === null ? marks : marks.filter((m) => m.phase === phase);
  const lms =
    data?.frame && data.frame.tier1.length > 0
      ? landmarks(data.frame, data.halfExtent)
      : [];
  const cluster = deathCluster(shown);
  const insight = clusterInsight(cluster, shown.length, lms);

  // Depth reads the WHOLE game even when the map is filtered: it is a claim about how the player
  // played, and slicing it by phase would shrink an already noisy sample to two or three deaths.
  const depth = depthInsight(
    depthRead(
      marks,
      (data?.phases ?? []).map((p) =>
        won ? (p.depth?.won ?? null) : (p.depth?.lost ?? null),
      ),
    ),
  );

  // Population layer for the selected span. Pooling phases means summing their normalized bytes,
  // which is an approximation (each was normalized to its own peak) — acceptable for an underlay
  // whose only job is to show where the map is busy, and re-normalized below so it can't blow out.
  const density = (() => {
    if (!data) return null;
    const grids = (phase === null ? data.phases : [data.phases[phase]])
      .filter(Boolean)
      .map((p) => decodeDensity(p.grid, data.size, data.halfExtent))
      .filter((g) => g !== null);
    if (grids.length === 0) return null;
    if (grids.length === 1) return grids[0];
    const cells = new Uint8Array(grids[0]!.cells.length);
    for (let i = 0; i < cells.length; i++) {
      let sum = 0;
      for (const g of grids) sum += g!.cells[i];
      cells[i] = Math.min(255, sum / grids.length);
    }
    return { size: grids[0]!.size, halfExtent: grids[0]!.halfExtent, cells };
  })();

  return (
    <div className="deathmap">
      <div
        className="dmfilter"
        role="group"
        aria-label="Filter deaths by phase"
      >
        <button
          type="button"
          className={phase === null ? "active" : ""}
          onClick={() => setPhase(null)}
        >
          All
        </button>
        {(data?.phases ?? []).map((p, i) => {
          const n = marks.filter((m) => m.phase === i).length;
          return (
            <button
              key={p.label}
              type="button"
              className={phase === i ? "active" : ""}
              onClick={() => setPhase(i)}
              disabled={n === 0}
              title={`${n} death${n === 1 ? "" : "s"} in ${p.label.toLowerCase()}`}
            >
              {p.label}
              <span className="dmn">{n}</span>
            </button>
          );
        })}
      </div>

      <figure className="dmfig">
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="img"
          className={lms.length > 0 ? "hasframe" : undefined}
          aria-label={
            `Map of where ${heroName} died, drawn with your base at the bottom. ` +
            `${shown.length} death${shown.length === 1 ? "" : "s"} plotted` +
            (density
              ? `, over a shaded field showing where deaths are most common at this rank.`
              : `.`) +
            (insight ? ` ${insight}` : "") +
            (depth ? ` ${depth}` : "")
          }
        >
          {/* The map's silhouette: the three zipline routes, in world coordinates from the assets
              API and drawn in our own ink. This is what makes the picture recognizable as the map —
              a density field shows where the game is played but not what the place looks like.
              Under the density so it never competes with the data. No rotation: the set of three
              routes maps onto itself under the same 180° rotation the rest of the frame uses. */}
          {(data?.ziplines?.length ?? 0) > 0 && (
            <g className="dmzip">
              {data!.ziplines!.map((path, i) => (
                <path
                  key={i}
                  d={path
                    .map(([wx, wy], j) => {
                      const p = worldToUnit(wx, wy, data!.halfExtent);
                      return `${j ? "L" : "M"}${(p.u * SIZE).toFixed(1)} ${(p.v * SIZE).toFixed(1)}`;
                    })
                    .join(" ")}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>
          )}

          {/* Population density. Drawn as plain rects rather than an image so it inherits theme
              colour and needs no external asset. */}
          {density && (
            <g className="dmdensity">
              {Array.from(density.cells).map((n, i) => {
                // Below this a cell is noise and only muddies the field.
                if (n < 12) return null;
                const r = cellRect(i, density.size, SIZE);
                return (
                  <rect
                    key={i}
                    x={r.x}
                    y={r.y}
                    width={r.w}
                    height={r.w}
                    opacity={(n / 255) * 0.55}
                  />
                );
              })}
            </g>
          )}

          {/* The midline, and the structures either side of it: the reference that turns a cloud of
              dots into a place. Solid hairline — a dashed rule would read as a projection. */}
          {lms.length > 0 && (
            <g className="dmframe-marks">
              <line
                className="dmmid"
                x1="0"
                y1={SIZE / 2}
                x2={SIZE}
                y2={SIZE / 2}
                vectorEffect="non-scaling-stroke"
              />
              {lms.map((l) => {
                const cx = l.u * SIZE;
                const cy = l.v * SIZE;
                const key = `${l.kind}-${l.own}-${Math.round(l.x)}`;
                if (l.kind === "core")
                  // A diamond for the base: the one structure that ends the game.
                  return (
                    <path
                      key={key}
                      className="dmlm core"
                      d={`M${cx} ${cy - 5}L${cx + 5} ${cy}L${cx} ${cy + 5}L${cx - 5} ${cy}Z`}
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                if (l.kind === "tier1")
                  return (
                    <circle
                      key={key}
                      className="dmlm t1"
                      cx={cx}
                      cy={cy}
                      r={3}
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                return (
                  <rect
                    key={key}
                    className="dmlm t2"
                    x={cx - 2.6}
                    y={cy - 2.6}
                    width={5.2}
                    height={5.2}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
              {/* Which end is which, in text — orientation must not depend on reading the shapes. */}
              <text className="dmhalf" x={SIZE - 3} y={11} textAnchor="end">
                THEIR HALF
              </text>
              <text
                className="dmhalf"
                x={SIZE - 3}
                y={SIZE - 4}
                textAnchor="end"
              >
                YOUR HALF
              </text>
            </g>
          )}

          {/* A hairline frame, so the map's extent is legible even where density is sparse. */}
          <rect
            className="dmframe"
            x="0.5"
            y="0.5"
            width={SIZE - 1}
            height={SIZE - 1}
            vectorEffect="non-scaling-stroke"
          />

          {/* The repeat spot, marked before the points so the points sit on top of it. */}
          {cluster && (
            <circle
              className="dmcluster"
              cx={cluster.u * SIZE}
              cy={cluster.v * SIZE}
              r={0.12 * SIZE}
              vectorEffect="non-scaling-stroke"
            />
          )}

          {shown.map((m) => (
            <g key={m.i}>
              {/* Where it came from — a short leader, not a full line: the killer's position is
                  where they stood at the kill, not a path, and a long line would imply travel. */}
              {m.from && (
                <line
                  className="dmfrom"
                  x1={m.u * SIZE}
                  y1={m.v * SIZE}
                  x2={m.u * SIZE + (m.from.u - m.u) * SIZE * 0.45}
                  y2={m.v * SIZE + (m.from.v - m.v) * SIZE * 0.45}
                  vectorEffect="non-scaling-stroke"
                />
              )}
              <circle
                className="dmdot"
                cx={m.u * SIZE}
                cy={m.v * SIZE}
                r={4}
                vectorEffect="non-scaling-stroke"
              >
                <title>
                  {`Death ${m.i + 1} at ${mmss(m.gameTimeS)}` +
                    (m.deadS ? ` · ${m.deadS}s dead` : "")}
                </title>
              </circle>
            </g>
          ))}
        </svg>

        <figcaption className="dmlegend">
          <span className="lg dens">where deaths happen at this rank</span>
          <span className="lg you">your deaths</span>
          {shown.some((m) => m.from) && (
            <span className="lg from">killer's position</span>
          )}
          {cluster && <span className="lg cl">repeat spot</span>}
          {lms.length > 0 && (
            <span className="lg lm">tier-1 / tier-2 / base</span>
          )}
          {(data?.ziplines?.length ?? 0) > 0 && (
            <span className="lg zip">zip-line loop</span>
          )}
        </figcaption>
      </figure>

      {insight && <p className="dminsight">{insight}</p>}
      {depth && <p className="dminsight">{depth}</p>}

      {/* Everything the key and the map's own labels already carry has been cut from here. What is
          left is the one thing neither can say — that agreeing with the shading is the ordinary
          case, not a finding — plus the provenance every panel carries. */}
      <p className="matchnote">
        {data && (
          <>
            Population from {data.days} day{data.days === 1 ? "" : "s"} of
            ranked play ·{" "}
          </>
        )}
        the shading is where deaths are common.
      </p>
    </div>
  );
}
