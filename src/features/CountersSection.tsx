// The counters area: the hero-vs-hero matchup chips (Tough / Favored vs) above the manual enemy
// picker, plus the one-line note explaining the comp re-rank once enemies are selected.
import "./CountersSection.css";
import type { Ref } from "react";
import { CounterPicker, MatchupChip } from "../components/panels";
import type { Hero, HeroMatchups } from "../types";

export function CountersSection(props: {
  matchups: HeroMatchups | null;
  heroes: Hero[];
  enemies: number[];
  enemyNames: string;
  toggleEnemy: (id: number) => void;
  onRemoveEnemy: (id: number) => void;
  onOpenPicker: () => void;
  onOpenGuide: () => void;
  matrixRef: Ref<HTMLDivElement>;
}) {
  const {
    matchups,
    heroes,
    enemies,
    enemyNames,
    toggleEnemy,
    onRemoveEnemy,
    onOpenPicker,
    onOpenGuide,
    matrixRef,
  } = props;

  return (
    <>
      <div className="counters">
        {matchups &&
          (matchups.tough.length > 0 || matchups.favorable.length > 0) && (
            <div className="matchups" ref={matrixRef}>
              {matchups.tough.length > 0 && (
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
                    />
                  ))}
                </div>
              )}
              {matchups.favorable.length > 0 && (
                <div className="mrow">
                  <span className="lbl fav">Favored vs</span>
                  {matchups.favorable.map((m) => (
                    <MatchupChip
                      key={m.enemyHeroId}
                      m={m}
                      hero={heroes.find((h) => h.id === m.enemyHeroId)}
                      active={enemies.includes(m.enemyHeroId)}
                      onClick={() => toggleEnemy(m.enemyHeroId)}
                    />
                  ))}
                </div>
              )}
              <p className="hint">
                Click a hero to add it below and see what to build against it.{" "}
                <button
                  type="button"
                  className="guidelink"
                  onClick={onOpenGuide}
                >
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
