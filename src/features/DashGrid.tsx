// The pre-build dashboard: the Economy panel, the Combat & survival benchmark, the skill-order
// card, the community-build check, and the "To climb" tips — a plain two-column masonry, paired
// by subject (see DashGrid.css .dash).
import "./DashGrid.css";
import type { Ref } from "react";
import { EconomyPanel } from "../components/EconomyPanel";
import type { LastGameFarm } from "../components/EconomyPanel";
import { CommunityRow } from "../components/CommunityRow";
import { SkillEmpty, SkillOrder } from "../components/panels";
import { CAN_HOVER } from "../components/usePinnablePopover";
import { climbAdvice, type FundamentalRow } from "../lib/fundamentals";
import { rankFloorLabel } from "../lib/ranks";
import type { HeroFarmProfile } from "../lib/matchAnalysis";
import type { FundamentalsData } from "./useProfile";
import type {
  Ability,
  CommunityMatch,
  Hero,
  Item,
  SkillBuild,
} from "../types";

export function DashGrid(props: {
  hero: Hero | null;
  rankLabel: string;
  items: Map<number, Item> | null;
  abilities: Map<number, Ability> | null;
  farmProfile: HeroFarmProfile | null;
  soulsPerMinRow: FundamentalRow | null;
  lastGameFarm: LastGameFarm | null;
  fundamentals: FundamentalsData | null;
  combatRows: FundamentalRow[];
  recentGames: number;
  setRecentGames: (n: number) => void;
  fundamentalsRef: Ref<HTMLElement>;
  skillBuild: SkillBuild | null;
  slotOrder: number[];
  skillRef: Ref<HTMLElement>;
  skillLoading: boolean;
  communityMatch: CommunityMatch | null;
  buildRankLabel: string | undefined;
  ourCoreIds: number[];
  ourSituationalIds: number[];
  ourMaxOrder: number[] | undefined;
  communityRef: Ref<HTMLElement>;
  lastHeroMatchId: number | null;
  onOpenGuide: () => void;
  onAnalyzeLastGame: () => void;
}) {
  const {
    hero,
    rankLabel,
    items,
    abilities,
    farmProfile,
    soulsPerMinRow,
    lastGameFarm,
    fundamentals,
    combatRows,
    recentGames,
    setRecentGames,
    fundamentalsRef,
    skillBuild,
    slotOrder,
    skillRef,
    skillLoading,
    communityMatch,
    buildRankLabel,
    ourCoreIds,
    ourSituationalIds,
    ourMaxOrder,
    communityRef,
    lastHeroMatchId,
    onOpenGuide,
    onAnalyzeLastGame,
  } = props;

  return (
    <div className="dash">
      {/* The flagship: your souls/min, where this hero's souls come from, and your last game on
          top of it. Shows whenever EITHER layer has data — the farm breakdown is baked per
          (hero, rank) and is still filling in, so souls/min must not vanish with it. */}
      {hero && (farmProfile || soulsPerMinRow) && (
        <EconomyPanel
          profile={farmProfile}
          heroName={hero.name}
          rankLabel={rankLabel}
          dataRankLabel={
            farmProfile ? rankFloorLabel(farmProfile.tier) : undefined
          }
          soulsPerMin={soulsPerMinRow}
          lastGame={lastGameFarm}
        />
      )}

      {fundamentals && hero && (
        <section
          className="fundamentals"
          ref={fundamentalsRef}
          title="Your average per game, placed on the distribution of games at this rank floor (percentile, higher = better; deaths inverted). Farm lives in the Economy panel; this is what's left — staying alive and what you do in fights."
        >
          <h2>
            Combat &amp; survival{" "}
            <span className="sub">
              {fundamentals.heroScoped ? hero.name : "all heroes"}
              {fundamentals.window && (
                <>
                  ,{" "}
                  {fundamentals.window.games === 1
                    ? "last game"
                    : `last ${fundamentals.window.games} games`}{" "}
                  ({fundamentals.window.spanDays}d)
                </>
              )}{" "}
              vs {fundamentals.benchmarkLabel}{" "}
              <span className="climbmark">climbing</span>
            </span>
            <select
              className="fundwin"
              value={recentGames}
              onChange={(e) => setRecentGames(Number(e.target.value))}
              onClick={(e) => e.stopPropagation()}
              aria-label="How many recent games to benchmark"
              title="How many of your recent games to read. Scoping by games (not days) keeps a long break — or an old, worse version of you — out of the average."
            >
              {[1, 5, 10, 20].map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? "last game" : `last ${n}`}
                </option>
              ))}
            </select>
          </h2>
          <div className="fundrows">
            {combatRows.map((r) => (
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
                      r.percentile >= 75 ? "hi" : r.percentile < 25 ? "lo" : ""
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

      {abilities && skillBuild ? (
        <SkillOrder
          skill={skillBuild}
          abilities={abilities}
          slotOrder={slotOrder}
          settleRef={skillRef}
        />
      ) : (
        hero && !skillLoading && <SkillEmpty />
      )}

      {communityMatch && (communityMatch.best || communityMatch.aligned) && (
        <section className="community" ref={communityRef}>
          <h2>
            Community check{" "}
            <span className="sub">player builds at {buildRankLabel}</span>
          </h2>
          <div className="crows">
            {communityMatch.agree && communityMatch.best ? (
              <CommunityRow
                tag="Top build = closest to ours ✓"
                rb={communityMatch.best}
                ourCoreIds={ourCoreIds}
                ourSituIds={ourSituationalIds}
                items={items}
                abilities={abilities}
                ourMaxOrder={ourMaxOrder}
                slotOrder={slotOrder}
                agree
              />
            ) : (
              <>
                {communityMatch.best && (
                  <CommunityRow
                    tag="Best win rate"
                    rb={communityMatch.best}
                    ourCoreIds={ourCoreIds}
                    ourSituIds={ourSituationalIds}
                    items={items}
                    abilities={abilities}
                    ourMaxOrder={ourMaxOrder}
                    slotOrder={slotOrder}
                  />
                )}
                {communityMatch.aligned && (
                  <CommunityRow
                    tag="Most like ours"
                    rb={communityMatch.aligned}
                    ourCoreIds={ourCoreIds}
                    ourSituIds={ourSituationalIds}
                    items={items}
                    abilities={abilities}
                    ourMaxOrder={ourMaxOrder}
                    slotOrder={slotOrder}
                  />
                )}
              </>
            )}
          </div>
          <p className="hint">
            {CAN_HOVER ? "Hover" : "Tap"} a build to see where it agrees with
            ours and where it differs; {CAN_HOVER ? "click" : "tap"}{" "}
            <code>#id</code> to copy it for the in-game search.{" "}
            <button type="button" className="guidelink" onClick={onOpenGuide}>
              What “% match”, core &amp; flex mean →
            </button>
          </p>
        </section>
      )}

      {/* "To climb" spans farm AND survival, so it's its own card rather than a corner of either
          panel. Last in the flow: the column packer drops it into whichever column has room,
          which keeps it compact instead of a page-wide band. */}
      {fundamentals && hero && (
        <section className="climbcard">
          <h2>To climb</h2>
          {(() => {
            // Reads the FULL row set — including the farm rows the Economy panel displays — so
            // farm advice survives those rows having moved out of the combat card.
            const tips = climbAdvice(
              fundamentals.rows,
              fundamentals.heroScoped ? hero.name : "these",
            );
            return tips.length === 0 ? (
              <p className="climbnote">
                Your controllables are at or above the ladder here — play your
                game.
              </p>
            ) : (
              tips.map((t) => (
                <div className="climbtip" key={t.key}>
                  <span className="climbaction">{t.action}</span>
                  <span className="climbdetail">{t.detail}</span>
                </div>
              ))
            );
          })()}
          <button
            type="button"
            className="lastgamelink"
            onClick={onAnalyzeLastGame}
          >
            {lastHeroMatchId
              ? `Analyze your last ${hero.name} game →`
              : "Analyze your last game →"}
          </button>
        </section>
      )}
    </div>
  );
}
