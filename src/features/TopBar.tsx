// The sticky header: brand mark, the Hero / Rank / Patch / Backfill / Steam-ID controls, the
// palette + guide + lab + match buttons, and the indeterminate loading strip.
import "./TopBar.css";
import { IS_MAC, type PaletteMode } from "../lib/palette";
import {
  RANK_TIERS,
  rankFloorLabel,
  rankSelLabel,
  type RankSel,
} from "../lib/ranks";
import { parseSteamInput, parseVanityName } from "../lib/steamId";
import { searchSteamPlayers, type SteamPlayerMatch } from "../api/deadlock";
import { ShuffleMark } from "../components/panels";
import type { Hero, Item, Patch } from "../types";

export function TopBar(props: {
  items: Map<number, Item> | null;
  shuffleSeed: string;
  hero: Hero | null;
  heroes: Hero[];
  heroId: number | null;
  pickHero: (id: number) => void;
  rankSel: RankSel;
  pickRank: (sel: RankSel) => void;
  bandChoice: RankSel | null;
  patchIdx: number;
  setPatchIdx: (idx: number) => void;
  patches: Patch[];
  backfillOn: boolean;
  setBackfillOn: (v: boolean) => void;
  steamId: string;
  setSteamId: (v: string) => void;
  steamMatches: SteamPlayerMatch[] | null;
  setSteamMatches: (m: SteamPlayerMatch[] | null) => void;
  rankAutoSet: string | null;
  setPalette: (m: PaletteMode) => void;
  onOpenGuide: () => void;
  onOpenLab: () => void;
  onOpenMatch: () => void;
  busy: boolean;
}) {
  const {
    items,
    shuffleSeed,
    hero,
    heroes,
    heroId,
    pickHero,
    rankSel,
    pickRank,
    bandChoice,
    patchIdx,
    setPatchIdx,
    patches,
    backfillOn,
    setBackfillOn,
    steamId,
    setSteamId,
    steamMatches,
    setSteamMatches,
    rankAutoSet,
    setPalette,
    onOpenGuide,
    onOpenLab,
    onOpenMatch,
    busy,
  } = props;

  return (
    <header className="topbar">
      <div className="brand">
        <ShuffleMark items={items} seed={shuffleSeed} />
        <span className="brandname">Vibelock</span>
        {hero?.tagline && <span className="tagline">{hero.tagline}</span>}
      </div>
      <div className="controls">
        <label>
          Hero
          <select
            value={heroId ?? ""}
            onChange={(e) => pickHero(Number(e.target.value))}
          >
            {heroes.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
        <label className="rankctl">
          Rank
          <select
            value={typeof rankSel === "number" ? String(rankSel) : "band"}
            onChange={(e) =>
              pickRank(
                e.target.value === "band" && bandChoice
                  ? bandChoice
                  : Number(e.target.value),
              )
            }
          >
            {bandChoice && (
              <option value="band">
                Around my rank ({rankSelLabel(bandChoice)})
              </option>
            )}
            {[...RANK_TIERS].reverse().map((t) => (
              <option key={t.tier} value={t.tier}>
                {rankFloorLabel(t.tier)}
              </option>
            ))}
          </select>
          {rankAutoSet && (
            <span className="autoset" key={rankAutoSet} aria-live="polite">
              set to {rankAutoSet} from your profile
            </span>
          )}
        </label>
        <label>
          Patch
          <select
            value={patchIdx}
            onChange={(e) => setPatchIdx(Number(e.target.value))}
          >
            {patches.length === 0 && (
              <option value={0}>Last 30 days (patch list unavailable)</option>
            )}
            {patches.map((p, i) => (
              <option key={p.ts} value={i}>
                {p.title}
                {i === 0 ? " (latest)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label
          className="checkctl"
          title="Pad a young patch's thin data with the 30 days before it, as a capped prior that fades out as the patch accumulates games (see How it works). Off = the selected window only."
        >
          Backfill
          <input
            type="checkbox"
            checked={backfillOn}
            onChange={(e) => setBackfillOn(e.target.checked)}
          />
        </label>
        <label
          className="idctl"
          title="Paste your Steam profile URL, steamID64, or the userdata/<id> number — or type a display name and press Enter to search. Unlocks the your-heroes quick-pick, pre-selects your rank, and signs exported builds. Stored only in this browser."
        >
          Steam ID
          <input
            placeholder="id, URL, or name…"
            value={steamId}
            onChange={(e) => {
              setSteamId(e.target.value);
              setSteamMatches(null);
            }}
            onKeyDown={async (e) => {
              // A value that doesn't parse as an id is a name or vanity URL — search on Enter.
              if (e.key !== "Enter") return;
              const q = steamId.trim();
              if (!q || parseSteamInput(q) !== null) return;
              const query = parseVanityName(q) ?? q;
              setSteamMatches(await searchSteamPlayers(query).catch(() => []));
            }}
            onBlur={() => setTimeout(() => setSteamMatches(null), 200)}
          />
          {steamMatches && (
            <div className="idresults">
              {steamMatches.length === 0 && (
                <span className="idempty">no matches</span>
              )}
              {steamMatches.slice(0, 8).map((m) => (
                <button
                  key={m.account_id}
                  type="button"
                  // mousedown, not click: the input's onBlur fires between mousedown and click
                  // and would unmount the list before a click could land.
                  onMouseDown={() => {
                    setSteamId(String(m.account_id));
                    setSteamMatches(null);
                  }}
                >
                  {m.avatar && <img src={m.avatar} alt="" loading="lazy" />}
                  {m.personaname}
                  <i>#{m.account_id}</i>
                </button>
              ))}
            </div>
          )}
        </label>
        <button
          type="button"
          className="guidebtn palbtn"
          onClick={() => setPalette("all")}
          title={`Command palette — switch hero, rank, or patch and add enemies (${IS_MAC ? "⌘K" : "Ctrl+K"})`}
        >
          {IS_MAC ? "⌘K" : "Ctrl+K"}
        </button>
        <button
          type="button"
          className="guidebtn"
          onClick={onOpenGuide}
          title="How these numbers are calculated"
        >
          How it works
        </button>
        <button
          type="button"
          className="guidebtn labbtn"
          onClick={onOpenLab}
          title="Experimental stats from whole-match data: closing power and state-adjusted item value"
        >
          Lab
        </button>
        <button
          type="button"
          className="guidebtn"
          onClick={onOpenMatch}
          title="Post-game read of one match: win-probability trajectory, fundamentals vs the ladder, soul economy, deaths"
        >
          Match
        </button>
      </div>
      {busy && <div className="loadstrip" aria-hidden="true" />}
    </header>
  );
}
