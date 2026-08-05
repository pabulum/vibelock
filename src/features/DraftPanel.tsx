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
import type { BanAdvice } from "../lib/bans";
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
        ` Read the order, not the percentage: whole-comp effects this sum doesn't model shift every candidate here by about the same amount.` +
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

/**
 * The ban row. Sits above the pick table because that's the order the game asks in, and unlike the
 * pick table it needs no enemy comp — bans happen before anyone has picked.
 *
 * The copy carries two caveats that the number alone would paper over: a ban lowers how often you
 * meet a hero rather than removing it, and banning one you play costs you a pick. Both are real
 * reasons not to ban, and a panel that only ever argued *for* banning would be selling something.
 */
function BanRow({
  advice,
  heroes,
  onIntent,
}: {
  advice: BanAdvice;
  heroes: Hero[];
  onIntent: (id: number) => void;
}) {
  const { candidates, poolSize } = advice;
  if (candidates.length === 0) return null;
  const best = candidates[0];
  return (
    <div className="bans">
      <h3 className="dsub">
        Worth banning
        <span className="dnote">
          cost to your {poolSize} heroes × how often you meet it
        </span>
      </h3>
      <div className="banrow">
        {candidates.map((c) => (
          <span
            key={c.hero.id}
            className={`banchip${c.inYourPool ? " own" : ""}`}
            onPointerEnter={() => onIntent(c.hero.id)}
            title={
              `${c.hero.name} takes ${(c.meanCost * 100).toFixed(1)}pt off your pool on average, and lands on the ` +
              `enemy team in about ${Math.round(c.presence * 100)}% of games — ${(c.expectedCost * 100).toFixed(2)}pt ` +
              `per game queued. Worst into ${c.hits
                .slice(0, 2)
                .map(
                  (h) =>
                    `${heroes.find((x) => x.id === h.heroId)?.name ?? "?"} (${signedPt(h.resid)})`,
                )
                .join(", ")}.` +
              (c.banShare !== undefined
                ? ` The community spends ${Math.round(c.banShare * 100)}% of its bans here.`
                : "") +
              (c.inYourPool
                ? " You play this hero — banning it takes one of your own options off the board."
                : "")
            }
          >
            {c.hero.image && <img src={c.hero.image} alt="" loading="lazy" />}
            <span className="bname">{c.hero.name}</span>
            {/* Both factors, not their product. The product is what the list is ordered by (the
                subhead says so), but "0.8pt when you meet it, and you meet it about a fifth of the
                time" is the sentence a reader can act on — −0.16 alone is unreadably small. */}
            <span className="bcost">−{(c.meanCost * 100).toFixed(1)}</span>
            <span className="bfreq">{Math.round(c.presence * 100)}%</span>
            {c.inYourPool && <span className="bown">yours</span>}
          </span>
        ))}
      </div>
      <p className="bannote">
        <strong>{best.hero.name}</strong> costs your pool the most per game
        queued — {(best.meanCost * 100).toFixed(1)}pt when you meet it, and you
        meet it in about {Math.round(best.presence * 100)}% of games. A ban
        lowers that frequency rather than removing the hero, so treat these as
        the size of the problem, not the size of the win — and you&rsquo;ll
        still face them often enough that learning the matchup pays.
      </p>
    </div>
  );
}

export function DraftPanel(props: {
  ranking: DraftRanking | null;
  bans: BanAdvice | null;
  heroes: Hero[];
  enemyNames: string;
  heroId: number | null;
  hasProfile: boolean;
  pickHero: (id: number) => void;
  onIntent: (id: number) => void;
}) {
  const {
    ranking,
    bans,
    heroes,
    enemyNames,
    heroId,
    hasProfile,
    pickHero,
    onIntent,
  } = props;
  const candidates = ranking?.candidates ?? [];
  const offPool = ranking?.offPool ?? [];
  const reorders = ranking?.reorders ?? false;
  // The two halves are independent: bans need a pool but no comp, picks need a comp but no pool.
  // Either alone is a section worth showing; neither means there is nothing to draft with.
  if (candidates.length === 0 && !bans) return null;

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
        Draft{" "}
        <span className="sub">
          {candidates.length > 0 ? `vs ${enemyNames}` : "before the picks land"}
        </span>
      </h2>

      {bans && <BanRow advice={bans} heroes={heroes} onIntent={onIntent} />}

      {candidates.length === 0 ? null : (
        <>
          <h3 className="dsub">
            {hasProfile ? "Best pick" : "Strongest into this comp"}
            <span className="dnote">your record + the matchup</span>
          </h3>
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
        </>
      )}
    </section>
  );
}
