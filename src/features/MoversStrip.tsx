// "Patch movers" + "Trending" strip: items whose win rate verifiably moved across the patch
// boundary, and items the player base is adopting this patch (breakouts vs hype).
import "./MoversStrip.css";
import type { Ref } from "react";
import type { AdoptionMover, PatchMover } from "../lib/patchMovers";
import type { Hero } from "../types";

/** A win-rate gap in points, always signed — these are differences, never levels. */
const signed = (x: number) =>
  `${x >= 0 ? "+" : "−"}${(Math.abs(x) * 100).toFixed(1)}pt`;

export function MoversStrip(props: {
  movers: PatchMover[];
  adoption: AdoptionMover[] | null;
  hero: Hero | null;
  moversRef: Ref<HTMLDivElement>;
}) {
  const { movers, adoption, hero, moversRef } = props;
  return (
    <div className="movers" ref={moversRef}>
      <span
        className="lbl"
        title="Items whose win rate for this hero verifiably moved across the patch, measured against the hero's own win rate so that a hero buff or nerf doesn't read as its whole item pool moving. Every sufficiently-sampled item is tested between the post-patch window and the equal-length window before it, false discoveries are rate-controlled, and only ≥2pt moves make the list. New items appear once they have a real sample."
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
          className={`mover${m.isNew ? " newitem" : m.delta > 0 ? " up" : " down"}${m.changed ? " changed" : ""}`}
          title={
            (m.changed
              ? "Named in this patch's notes — this move is caused by the patch, not a meta shift. "
              : "") +
            (m.isNew
              ? `New this patch — ${(m.newWinRate * 100).toFixed(1)}% over ${Math.round(m.nNew)} decided games`
              : // Both framings, because they can disagree and the gap is the point: the raw rates
                // are what you'd see on the item, the edges are what the patch actually did to it.
                `${(m.prevWinRate * 100).toFixed(1)}% → ${(m.newWinRate * 100).toFixed(1)}% raw (${Math.round(m.nPrev).toLocaleString()} → ${Math.round(m.nNew).toLocaleString()} decided games). Against this hero's own win rate: ${signed(m.prevEdge)} → ${signed(m.newEdge)}, a ${signed(m.delta)} move.`)
          }
        >
          {m.changed && <span className="patchtag">✎ </span>}
          {m.item.name}{" "}
          <b>
            {m.isNew
              ? "new"
              : `${m.delta > 0 ? "▲" : "▼"}${(Math.abs(m.delta) * 100).toFixed(1)}`}
          </b>
        </span>
      ))}

      {adoption && adoption.length > 0 && (
        <>
          <span
            className="lbl trending"
            title="Emerging meta: items the player base is moving toward this patch — pick rate now vs the equal-length window right before the patch, so a trend that was already under way doesn't read as a patch jump. A ↑ breakout is rising AND winning above this hero's average — get ahead of it; a hype pick is rising but not (yet) paying off, so it's a caution, not a recommendation."
          >
            Trending
          </span>
          {adoption.map((a) => (
            <span
              key={a.item.id}
              className={`mover ${a.breakout ? "breakout" : "hype"}${a.changed ? " changed" : ""}`}
              title={`Pick rate ${(a.pickPrev * 100).toFixed(0)}% → ${(a.pickNew * 100).toFixed(0)}% (+${(a.pickDelta * 100).toFixed(0)}pt). Win rate ${(a.winRate * 100).toFixed(1)}% (${a.winEdge >= 0 ? "+" : ""}${(a.winEdge * 100).toFixed(1)} vs hero avg) over ${a.nNew.toLocaleString()} games. ${a.breakout ? "Rising and winning — a breakout." : "Rising but not beating the hero's average — being tried, not proven."}${a.changed ? " Named in this patch's notes — the patch is likely why." : ""}`}
            >
              {a.changed && <span className="patchtag">✎ </span>}
              {a.item.name}{" "}
              <b>
                {a.breakout ? "↑" : "•"}
                {(a.pickDelta * 100).toFixed(0)}pt
              </b>
            </span>
          ))}
        </>
      )}
    </div>
  );
}
