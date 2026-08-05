// The draft panel: which hero to pick against the comp on the board.
//
// Sits directly under the enemy picker, because that is the order the decision happens in — the
// enemy picks land, then you choose. It is pure computation over data already in hand (the counter
// matrix is hero-independent and fetched once per rank and patch), so it re-ranks on the LIVE enemy
// list with no request and no settle veil: add a hero, the order moves under your cursor.
//
// The verdict line is the feature, not the table. Most comps do not change which of your heroes is
// the best pick, and saying that plainly is worth more than a ranking that always finds a
// counter-pick — see the note at the top of lib/draft.
import "./DraftPanel.css";
import { signedPt } from "../lib/matchups";
import { laneEdgeIsReal } from "../lib/laneMatchups";
import type { DraftCandidate, DraftRanking } from "../lib/draft";
import type { Hero } from "../types";

/** Marks worth colouring. The item rows' ±2pt no-colour band is a win-rate-delta rule and does not
 * transfer: a matchup residual has already had hero strength removed, its sd across the live matrix
 * is 0.50pt, and 0.5pt is the level that keeps its sign across independent windows 93.6% of the
 * time (lib/matchups). Same principle — colour only where the number means something — measured on
 * the scale this column is actually in. */
const MARK_COLOUR = 0.005;

function markClass(resid: number): string {
  if (Math.abs(resid) < MARK_COLOUR) return "";
  return resid > 0 ? "pos" : "neg";
}

function Row({
  c,
  heroes,
  selected,
  onPick,
  onIntent,
}: {
  c: DraftCandidate;
  heroes: Hero[];
  selected: boolean;
  onPick: () => void;
  onIntent: () => void;
}) {
  const laneWarn =
    c.worstLane && laneEdgeIsReal(c.worstLane.resid) && c.worstLane.resid < 0
      ? c.worstLane
      : null;
  const laneHero = laneWarn
    ? heroes.find((h) => h.id === laneWarn.enemyHeroId)
    : undefined;
  return (
    <button
      type="button"
      className={`drow${selected ? " active" : ""}${c.offPool ? " try" : ""}`}
      onClick={onPick}
      onPointerEnter={onIntent}
      title={
        (c.offPool
          ? `Not in your pool — ${(c.base * 100).toFixed(1)}% is the hero's current ladder rate at this rank and patch, already minus the new-hero learning tax.`
          : c.matches > 0
            ? `${(c.base * 100).toFixed(1)}% before the comp: your ${c.matches} games on ${c.hero.name}, shrunk toward the hero's current ladder rate at this rank and patch.`
            : `${(c.base * 100).toFixed(1)}% before the comp: the hero's current ladder rate at this rank and patch.`) +
        ` Matchups against this comp are worth ${signedPt(c.compEdge)}pt on top of that — hero strength already removed, so this is the matchup itself.` +
        (laneWarn && laneHero
          ? ` Lane caution: ${laneHero.name} beats you by ${Math.abs(laneWarn.resid)} souls at 10 min beyond what farming explains.`
          : "")
      }
    >
      <img src={c.hero.image} alt="" loading="lazy" />
      <span className="dname">{c.hero.name}</span>
      <span className="dexp">{(c.expected * 100).toFixed(1)}%</span>
      <span className={`dedge ${markClass(c.compEdge)}`}>
        {signedPt(c.compEdge)}
      </span>
      <span className="dmarks">
        {c.marks.slice(0, 3).map((m) => {
          const h = heroes.find((x) => x.id === m.enemyHeroId);
          return (
            <span className="dmark" key={m.enemyHeroId}>
              {h?.image && <img src={h.image} alt="" loading="lazy" />}
              <span className={markClass(m.resid)}>{signedPt(m.resid)}</span>
            </span>
          );
        })}
        {laneWarn && laneHero && (
          <span
            className="dlane"
            title={`Lane: ${laneHero.name} is ${Math.abs(laneWarn.resid)} souls ahead of you at 10 min beyond what farming explains. Souls, not win-rate points — it is not in the number on the left.`}
          >
            lane −{Math.abs(laneWarn.resid)}
          </span>
        )}
      </span>
    </button>
  );
}

export function DraftPanel(props: {
  ranking: DraftRanking;
  heroes: Hero[];
  enemyNames: string;
  heroId: number | null;
  hasProfile: boolean;
  pickHero: (id: number) => void;
  onIntent: (id: number) => void;
}) {
  const {
    ranking,
    heroes,
    enemyNames,
    heroId,
    hasProfile,
    pickHero,
    onIntent,
  } = props;
  const { candidates, offPool, reorders } = ranking;
  if (candidates.length === 0) return null;

  const best = candidates[0];
  // Both spreads, so the verdict can state the comparison rather than assert it. The matchup
  // column is usually the smaller of the two and that is the finding, but "usually" is not
  // "always" and a hard-coded claim would be wrong on the comps that matter most.
  const spreadOf = (pick: (c: DraftCandidate) => number) =>
    candidates.length > 1
      ? Math.max(...candidates.map(pick)) - Math.min(...candidates.map(pick))
      : 0;
  const compSpread = spreadOf((c) => c.compEdge);
  const baseSpread = spreadOf((c) => c.base);

  return (
    <section className="draft">
      <h2>
        {hasProfile ? "Best pick" : "Strongest into this comp"}{" "}
        <span className="sub">vs {enemyNames}</span>
      </h2>
      <div className="drows">
        {candidates.map((c) => (
          <Row
            key={c.hero.id}
            c={c}
            heroes={heroes}
            selected={c.hero.id === heroId}
            onPick={() => pickHero(c.hero.id)}
            onIntent={() => onIntent(c.hero.id)}
          />
        ))}
      </div>
      {offPool.length > 0 && (
        <>
          <h3 className="dsub">
            Beats your pool here
            <span className="dnote">
              already minus the new-hero learning tax
            </span>
          </h3>
          <div className="drows">
            {offPool.map((c) => (
              <Row
                key={c.hero.id}
                c={c}
                heroes={heroes}
                selected={c.hero.id === heroId}
                onPick={() => pickHero(c.hero.id)}
                onIntent={() => onIntent(c.hero.id)}
              />
            ))}
          </div>
        </>
      )}
      {/* The honest headline. A matchup is worth about a point; which hero you are actually good at
          is worth several, so "no change" is the common and correct answer and gets said plainly. */}
      <p className="dverdict">
        {reorders ? (
          <>
            <strong>{best.hero.name}</strong> moves ahead for this comp
            {hasProfile ? " — it isn't your best hero on paper" : ""}, worth{" "}
            {signedPt(best.compEdge)}pt of matchup.
          </>
        ) : (
          <>
            This comp doesn&rsquo;t change your order — take{" "}
            <strong>{best.hero.name}</strong>. Matchups spread{" "}
            {(compSpread * 100).toFixed(1)}pt across these heroes
            {hasProfile
              ? `, against ${(baseSpread * 100).toFixed(1)}pt between the heroes themselves`
              : ""}
            .
          </>
        )}{" "}
        Picking a hero here loads its build, already re-ranked for the comp.
      </p>
    </section>
  );
}
