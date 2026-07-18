// The build header: the hero portrait + name as a title, the stat line (rank, patch, matches, slot
// economy, export/share links) tucked under it, then the flex "Build style" tabs and the one-line
// build-identity note.
import "./BuildMeta.css";
import type { Ref } from "react";
import { SLOT_CAP } from "../lib/buildGenerator";
import type {
  Archetype,
  ArchetypeKey,
  ArchetypeSet,
  GeneratedBuild,
  Hero,
} from "../types";

export function BuildMeta(props: {
  build: GeneratedBuild | null;
  hero: Hero | null;
  archetypeSet: ArchetypeSet | null;
  activeArchetype: Archetype | null;
  archKey: ArchetypeKey;
  setArchKey: (k: ArchetypeKey) => void;
  displayBuild: GeneratedBuild | null;
  patchLabel: string;
  backfillLabel: string;
  lowPopulation: boolean;
  metaRef: Ref<HTMLDivElement>;
  onOpenExport: () => void;
  onOpenShare: () => void;
}) {
  const {
    build,
    hero,
    archetypeSet,
    activeArchetype,
    archKey,
    setArchKey,
    displayBuild,
    patchLabel,
    backfillLabel,
    lowPopulation,
    metaRef,
    onOpenExport,
    onOpenShare,
  } = props;

  return (
    <>
      {build && (
        // Identity (face + name) comes from the live selection, NOT build.hero, so it swaps the
        // instant you pick a hero instead of lagging until the build query returns. The numbers
        // below are still the old hero's until then, so the block wears the settle scrim.
        <div className="meta" ref={metaRef}>
          {(hero ?? build.hero).image && (
            // The unmissable "you are looking at THIS hero" anchor — a friend read Abrams
            // numbers mid-match while playing someone else; a name alone is too quiet.
            // Named for the switch view transition: the portrait cross-fades in place.
            <img
              className="metaface"
              style={{ viewTransitionName: "hero-face" }}
              src={(hero ?? build.hero).image}
              alt=""
            />
          )}
          <div className="metabody">
            <div className="metatitle">
              {(hero ?? build.hero).name}
              {archetypeSet?.flex && activeArchetype && (
                <span className="metaarch">{activeArchetype.label}</span>
              )}
            </div>
            {build.rankLabel} · {patchLabel}
            {backfillLabel} · {build.population.matches.toLocaleString()}{" "}
            matches · avg game {Math.round(build.population.avgDurationS / 60)}{" "}
            min · {(build.population.baselineWinRate * 100).toFixed(0)}% avg WR
            (rows show ± vs this) ·{" "}
            <span
              className={
                (displayBuild ?? build).standingSlots > SLOT_CAP
                  ? "warn"
                  : undefined
              }
            >
              {(displayBuild ?? build).standingSlots}/{SLOT_CAP} standing slots
            </span>
            {lowPopulation && (
              <span className="warn"> · ⚠ low sample, treat as noisy</span>
            )}{" "}
            ·{" "}
            <button
              type="button"
              className="guidelink"
              onClick={onOpenExport}
              title="Add this build to your in-game build list so the shop guides you through it"
            >
              ⬇ Export to in-game build
            </button>{" "}
            ·{" "}
            <button
              type="button"
              className="guidelink"
              onClick={onOpenShare}
              title="Copy a summary-card image for Discord, or a link that unfurls with this hero's card"
            >
              ⤴ Share
            </button>
          </div>
        </div>
      )}

      {archetypeSet?.flex && (
        <div className="archetypes">
          <span className="lbl">Build style</span>
          {archetypeSet.archetypes.map((a) => (
            <button
              key={a.key}
              className={`archtab ${a.key === archKey ? "active" : ""}`}
              onClick={() => setArchKey(a.key)}
              title={
                a.signature
                  ? `players who built ${a.signature.name}`
                  : "every build, blended"
              }
            >
              <span className="atlabel">{a.label}</span>
              <span className="atmeta">
                {(a.winRate * 100).toFixed(0)}% WR ·{" "}
                {(a.share * 100).toFixed(0)}% of games
              </span>
            </button>
          ))}
        </div>
      )}

      {archetypeSet && <div className="identity">{archetypeSet.note}</div>}
    </>
  );
}
