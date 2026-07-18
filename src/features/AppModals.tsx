// The top-layer overlays: the command palette, the "why isn't this in the build?" verdict card,
// and the guide / lab / match / export / share modals. Grouped so App's render tree ends with a
// single <AppModals/> rather than a long tail of conditional dialogs.
import "./AppModals.css";
import { CommandPalette } from "../components/CommandPalette";
import { VerdictCard } from "../components/VerdictCard";
import { GuideModal } from "../components/GuideModal";
import { LabModal } from "../components/LabModal";
import { MatchModal } from "../components/MatchModal";
import { ExportPanel } from "../components/ExportPanel";
import { SharePanel } from "../components/SharePanel";
import { shareCardModel, shareLinks } from "../lib/shareCard";
import type { ItemVerdict } from "../lib/buildGenerator";
import type {
  PaletteAction,
  PaletteCommand,
  PaletteMode,
} from "../lib/palette";
import type { UrlState } from "../lib/urlState";
import type { FundamentalRow } from "../lib/fundamentals";
import type {
  Archetype,
  ArchetypeSet,
  GeneratedBuild,
  Hero,
  ImbueTarget,
  Item,
  SkillBuild,
} from "../types";

export function AppModals(props: {
  // Command palette
  palette: PaletteMode | null;
  paletteCommands: PaletteCommand[];
  onRunPalette: (a: PaletteAction) => void;
  onClosePalette: () => void;
  // Why-not verdict card
  whyItem: Item | null;
  whyVerdict: ItemVerdict | null;
  onCloseWhy: () => void;
  // Modals
  showGuide: boolean;
  onCloseGuide: () => void;
  showLab: boolean;
  heroId: number | null;
  onCloseLab: () => void;
  showMatch: boolean;
  accountId: number | null;
  heroes: Hero[];
  matchAutoLatest: boolean;
  lastHeroMatchId: number | null;
  onCloseMatch: () => void;
  // Export / Share
  build: GeneratedBuild | null;
  displayBuild: GeneratedBuild | null;
  hero: Hero | null;
  archetypeSet: ArchetypeSet | null;
  activeArchetype: Archetype | null;
  patchLabel: string;
  skillBuild: SkillBuild | null;
  imbueByItem: Map<number, ImbueTarget>;
  steamId: string;
  setSteamId: (v: string) => void;
  showExport: boolean;
  onCloseExport: () => void;
  showShare: boolean;
  liveUrlState: UrlState | null;
  enemies: number[];
  fundamentalsRows: FundamentalRow[] | undefined;
  onCloseShare: () => void;
}) {
  const {
    palette,
    paletteCommands,
    onRunPalette,
    onClosePalette,
    whyItem,
    whyVerdict,
    onCloseWhy,
    showGuide,
    onCloseGuide,
    showLab,
    heroId,
    onCloseLab,
    showMatch,
    accountId,
    heroes,
    matchAutoLatest,
    lastHeroMatchId,
    onCloseMatch,
    build,
    displayBuild,
    hero,
    archetypeSet,
    activeArchetype,
    patchLabel,
    skillBuild,
    imbueByItem,
    steamId,
    setSteamId,
    showExport,
    onCloseExport,
    showShare,
    liveUrlState,
    enemies,
    fundamentalsRows,
    onCloseShare,
  } = props;

  return (
    <>
      {palette && (
        <CommandPalette
          commands={paletteCommands}
          placeholder={
            palette === "enemies"
              ? "Add or remove enemies — type, Enter, repeat…"
              : "Hero, rank, patch, or “vs enemy”…"
          }
          onRun={onRunPalette}
          onClose={onClosePalette}
        />
      )}

      {whyItem && whyVerdict && (
        <VerdictCard item={whyItem} verdict={whyVerdict} onClose={onCloseWhy} />
      )}

      {showGuide && <GuideModal onClose={onCloseGuide} />}
      {showLab && <LabModal heroId={heroId} onClose={onCloseLab} />}
      {showMatch && (
        <MatchModal
          accountId={accountId}
          heroes={heroes}
          autoLoadLatest={matchAutoLatest}
          autoLoadMatchId={lastHeroMatchId}
          onClose={onCloseMatch}
        />
      )}

      {showExport && build && (
        <ExportPanel
          build={displayBuild ?? build}
          skillOrder={skillBuild?.order}
          imbues={imbueByItem}
          name={`Vibelock — ${build.hero.name}${
            archetypeSet?.flex && activeArchetype
              ? ` · ${activeArchetype.label}`
              : ""
          } (${build.rankLabel})`}
          description={`Top-to-bottom build from Vibelock · ${build.rankLabel} · ${patchLabel} · ${build.population.matches.toLocaleString()} matches. Core phases + a Situational (optional) row; each item's note says why it's picked. Made with vibelock.`}
          steamId={steamId}
          onSteamIdChange={setSteamId}
          onClose={onCloseExport}
        />
      )}

      {showShare && build && hero && liveUrlState && (
        <SharePanel
          model={shareCardModel(displayBuild ?? build, {
            heroName: hero.name,
            heroImage: hero.image,
            archLabel:
              archetypeSet?.flex && activeArchetype
                ? activeArchetype.label
                : undefined,
            patchLabel,
            enemyNames: enemies
              .map((id) => heroes.find((h) => h.id === id)?.name)
              .filter((n): n is string => !!n),
            siteLabel: `${window.location.host}${import.meta.env.BASE_URL.replace(/\/$/, "")}`,
          })}
          fundamentals={fundamentalsRows}
          heroSlug={liveUrlState.hero}
          links={shareLinks(
            liveUrlState,
            window.location.origin,
            import.meta.env.BASE_URL,
          )}
          onClose={onCloseShare}
        />
      )}
    </>
  );
}
