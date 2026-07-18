// The "Your heroes" quick-pick strip: the player's most-played heroes ordered by expected win
// rate tonight, plus a short "Worth picking up" tail of strong off-pool heroes.
import "./MyHeroes.css";
import type { Hero } from "../types";

// Style hint (Lab): the WR-residual of closing power — what's left after "good heroes win" is
// accounted for (raw closing tracks hero WR at r≈0.93, which the chip already shows). Positive
// ⇒ converts even games; negative ⇒ wins ride on soul leads (snowballer). Only a clear signal
// (1.5pt+, well past the split-half noise) gets a hint — most heroes stay quiet.
const STYLE_NOTE = 0.015;

function closingHint(resid: number | undefined): string {
  if (resid === undefined || Math.abs(resid) < STYLE_NOTE) return "";
  const pt = `${resid > 0 ? "+" : "−"}${Math.abs(resid * 100).toFixed(1)}pt`;
  return resid > 0
    ? ` · style: converts even games (${pt} beyond its win rate) — a rough lane isn't fatal, grind it out`
    : ` · style: snowball hero (${pt} vs its win rate) — wins ride on soul leads, force your advantage early`;
}

function closingGlyph(resid: number | undefined) {
  if (resid === undefined || Math.abs(resid) < STYLE_NOTE) return null;
  return (
    <span className={`closer ${resid > 0 ? "up" : "down"}`} aria-hidden="true">
      {resid > 0 ? "⏱" : "⚡"}
    </span>
  );
}

interface TopHeroRow {
  hero: Hero;
  matches: number;
  winRate: number;
  meta: { winRate: number; decided: number } | undefined;
  expected: number | undefined;
}
interface TryHeroRow {
  hero: Hero;
  metaWinRate: number;
  taxed: number;
}

export function MyHeroes(props: {
  topHeroes: TopHeroRow[];
  tryHeroes: TryHeroRow[] | null;
  heroId: number | null;
  pickHero: (id: number) => void;
  newHeroTax: number;
  labHeroes: Map<number, number> | null;
}) {
  const { topHeroes, tryHeroes, heroId, pickHero, newHeroTax, labHeroes } =
    props;
  return (
    <div className="myheroes">
      <span
        className="lbl"
        title="Your most-played heroes (last 90 days when possible), ordered by expected win rate tonight: your own record on the hero, shrunk toward the hero's current ladder win rate at this rank and patch. You queue 3–4 and the game assigns one — take your picks from the left."
      >
        Your heroes
      </span>
      {topHeroes.map(({ hero: h, matches, winRate, meta, expected }) => (
        <button
          key={h.id}
          className={`chip${h.id === heroId ? " active" : ""}`}
          onClick={() => pickHero(h.id)}
          title={
            `you: ${Math.round(winRate * 100)}% over ${matches} matches` +
            (meta
              ? ` · hero now: ${(meta.winRate * 100).toFixed(1)}% at this rank/patch · expected tonight ≈ ${Math.round((expected ?? 0) * 100)}%`
              : "") +
            closingHint(labHeroes?.get(h.id))
          }
        >
          <img src={h.image} alt="" loading="lazy" />
          {h.name}
          {closingGlyph(labHeroes?.get(h.id))}
          {expected !== undefined && <i>{Math.round(expected * 100)}%</i>}
        </button>
      ))}
      {tryHeroes && tryHeroes.length > 0 && (
        <>
          <span
            className="lbl"
            title={`Strong at this rank/patch and not in your pool — a queue-slot candidate. The number is the hero's current ladder win rate minus a ~${(newHeroTax * 100).toFixed(1)}pt new-hero tax (your first games on a hero run below your eventual rate; the tax grows with rank, so picking someone up is cheapest at lower tiers).`}
          >
            Worth picking up
          </span>
          {tryHeroes.map(({ hero: h, metaWinRate, taxed }) => (
            <button
              key={h.id}
              className={`chip try${h.id === heroId ? " active" : ""}`}
              onClick={() => pickHero(h.id)}
              title={`${(metaWinRate * 100).toFixed(1)}% at this rank/patch − ~${(newHeroTax * 100).toFixed(1)}pt learning tax ≈ ${(taxed * 100).toFixed(1)}% while you pick them up${closingHint(labHeroes?.get(h.id))}`}
            >
              <img src={h.image} alt="" loading="lazy" />
              {h.name}
              {closingGlyph(labHeroes?.get(h.id))}
              <i>{Math.round(taxed * 100)}%</i>
            </button>
          ))}
        </>
      )}
    </div>
  );
}
