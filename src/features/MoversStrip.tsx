// "Patch movers" + "Trending" strip: items whose win rate verifiably moved across the patch
// boundary, and items the player base is adopting this patch (breakouts vs hype).
import "./MoversStrip.css";
import type { Ref } from "react";
import type { AdoptionMover, PatchMover } from "../lib/patchMovers";
import type { Hero } from "../types";

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
        title="Items whose win rate for this hero verifiably moved across the patch — every sufficiently-sampled item is tested between the pre- and post-patch windows, false discoveries are rate-controlled, and only ≥2pt moves make the list. New items appear once they have a real sample."
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
          className={`mover${m.isNew ? " newitem" : m.delta > 0 ? " up" : " down"}`}
          title={
            m.isNew
              ? `New this patch — ${(m.newWinRate * 100).toFixed(1)}% over ${Math.round(m.nNew)} decided games`
              : `${(m.prevWinRate * 100).toFixed(1)}% → ${(m.newWinRate * 100).toFixed(1)}% (${Math.round(m.nPrev).toLocaleString()} → ${Math.round(m.nNew).toLocaleString()} decided games)`
          }
        >
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
            title="Emerging meta: items the player base is moving toward this patch (pick rate rising vs the pre-patch window). A ↑ breakout is rising AND winning above this hero's average — get ahead of it; a hype pick is rising but not (yet) paying off, so it's a caution, not a recommendation."
          >
            Trending
          </span>
          {adoption.map((a) => (
            <span
              key={a.item.id}
              className={`mover ${a.breakout ? "breakout" : "hype"}`}
              title={`Pick rate ${(a.pickPrev * 100).toFixed(0)}% → ${(a.pickNew * 100).toFixed(0)}% (+${(a.pickDelta * 100).toFixed(0)}pt). Win rate ${(a.winRate * 100).toFixed(1)}% (${a.winEdge >= 0 ? "+" : ""}${(a.winEdge * 100).toFixed(1)} vs hero avg) over ${a.nNew.toLocaleString()} games. ${a.breakout ? "Rising and winning — a breakout." : "Rising but not beating the hero's average — being tried, not proven."}`}
            >
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
