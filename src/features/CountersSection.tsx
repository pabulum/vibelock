// The counters area: the hero-vs-hero matchup chips (Tough / Favored vs) above the manual enemy
// picker, plus the one-line note explaining the comp re-rank once enemies are selected.
import "./CountersSection.css";
import type { Ref } from "react";
import { CounterPicker, MatchupChip } from "../components/panels";
import { laneInsight, laneStrengthNote } from "../lib/laneMatchups";
import type { LaneMatchups } from "../lib/laneMatchups";
import type { Hero, HeroMatchups } from "../types";

export function CountersSection(props: {
  matchups: HeroMatchups | null;
  /** Lane-phase matchups from the harvested shards (lib/laneMatchups); null until a bake emits them. */
  lane: LaneMatchups | null;
  heroName: string | undefined;
  heroes: Hero[];
  enemies: number[];
  enemyNames: string;
  toggleEnemy: (id: number) => void;
  /** Prefetch the counter slices for an enemy the pointer is resting on (lib/prefetch). */
  onIntentEnemy: (id: number) => void;
  onRemoveEnemy: (id: number) => void;
  onOpenPicker: () => void;
  onOpenGuide: () => void;
  matrixRef: Ref<HTMLDivElement>;
}) {
  const {
    matchups,
    lane,
    heroName,
    heroes,
    enemies,
    enemyNames,
    toggleEnemy,
    onIntentEnemy,
    onRemoveEnemy,
    onOpenPicker,
    onOpenGuide,
    matrixRef,
  } = props;

  return (
    <>
      <div className="counters">
        {((matchups &&
          (matchups.tough.length > 0 || matchups.favorable.length > 0)) ||
          (lane && lane.hard.length > 0)) && (
          <div className="matchups" ref={matrixRef}>
            {matchups && matchups.tough.length > 0 && (
              <div className="mrow">
                <span className="lbl tough">Tough vs</span>
                {matchups.tough.map((m) => (
                  <MatchupChip
                    key={m.enemyHeroId}
                    m={m}
                    tough
                    hero={heroes.find((h) => h.id === m.enemyHeroId)}
                    active={enemies.includes(m.enemyHeroId)}
                    onClick={() => toggleEnemy(m.enemyHeroId)}
                    onIntent={() => onIntentEnemy(m.enemyHeroId)}
                  />
                ))}
              </div>
            )}
            {matchups && matchups.favorable.length > 0 && (
              <div className="mrow">
                <span className="lbl fav">Favored vs</span>
                {matchups.favorable.map((m) => (
                  <MatchupChip
                    key={m.enemyHeroId}
                    m={m}
                    hero={heroes.find((h) => h.id === m.enemyHeroId)}
                    active={enemies.includes(m.enemyHeroId)}
                    onClick={() => toggleEnemy(m.enemyHeroId)}
                    onIntent={() => onIntentEnemy(m.enemyHeroId)}
                  />
                ))}
              </div>
            )}
            {/* Lane is a different question from the rows above, which are whole-game presence.
                  A lane bully and a late-game problem want opposite responses — one changes how you
                  play the first ten minutes, the other changes what you build for the last ten —
                  so these get their own row rather than being blended into "Tough vs". */}
            {lane && lane.hard.length > 0 && (
              <div className="mrow">
                <span
                  className="lbl lane"
                  title={`Souls behind at ${Math.round(lane.tickS / 60)} min in the 2v2 lane, after removing how well each hero farms generally. ${laneStrengthNote(lane.strength, heroName ?? "This hero")}`}
                >
                  Loses lane to
                </span>
                {lane.hard.map((m) => {
                  const h = heroes.find((x) => x.id === m.enemyHeroId);
                  return (
                    <button
                      key={m.enemyHeroId}
                      type="button"
                      className={`lanechip${enemies.includes(m.enemyHeroId) ? " active" : ""}`}
                      onClick={() => toggleEnemy(m.enemyHeroId)}
                      onPointerEnter={() => onIntentEnemy(m.enemyHeroId)}
                      title={laneInsight(m, h?.name ?? "This hero")}
                    >
                      {h?.image && <img src={h.image} alt="" />}
                      <span className="lname">{h?.name ?? "?"}</span>
                      <span className="ldiff">{m.resid}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <p className="hint">
              Click a hero to add it below and see what to build against it.{" "}
              <button type="button" className="guidelink" onClick={onOpenGuide}>
                How matchup rates work →
              </button>
            </p>
          </div>
        )}

        <CounterPicker
          heroes={heroes}
          enemies={enemies}
          onRemove={onRemoveEnemy}
          onOpen={onOpenPicker}
        />
      </div>

      {enemies.length > 0 && (
        <p className="counters-note">
          The build below is re-ranked for {enemyNames}: picks that answer the
          comp rise and carry the enemy portrait (hover any row for the per-hero
          gain); picks that are weak into it are flagged{" "}
          <span className="weakcomp">▼</span>.{" "}
          <button type="button" className="guidelink" onClick={onOpenGuide}>
            How comp re-ranking works →
          </button>
        </p>
      )}
    </>
  );
}
