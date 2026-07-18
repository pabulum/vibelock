// The overlay UI state: the guide/lab/match/export/share modals, the command palette, and the
// "why isn't this in the build?" verdict card. Also owns the global Ctrl/⌘+K handler that opens
// the palette from anywhere. (The palette's pending item-jump ref stays in App — it's mutated by
// App's palette handlers, and the lint rules forbid mutating a hook-returned ref.)
import { useEffect, useState } from "react";
import type { PaletteMode } from "../lib/palette";
import type { Item } from "../types";

export function useModals() {
  const [showGuide, setShowGuide] = useState(false);
  const [showLab, setShowLab] = useState(false);
  const [showMatch, setShowMatch] = useState(false);
  // Whether the match modal should open onto the player's most recent game (the "analyze last game"
  // link) vs the blank recent-games list (the header "Match" button).
  const [matchAutoLatest, setMatchAutoLatest] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showShare, setShowShare] = useState(false);

  // Command palette (Ctrl/⌘+K, or the header/counter-picker buttons): 'all' = every control,
  // 'enemies' = scoped to enemy toggles as the counter picker's search-and-browse.
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  // The item whose "why isn't this in the build?" verdict card is open (palette's why-not commit).
  const [whyItem, setWhyItem] = useState<Item | null>(null);

  // Ctrl/⌘+K opens the palette from anywhere (hijacked even inside inputs, the convention for
  // apps with palettes). Open-only: the toggle-close lives in the palette itself so its exit
  // transition plays. Ignored while another modal owns the top layer.
  const modalOpen =
    showGuide || showLab || showMatch || showExport || showShare || !!whyItem;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      if (!modalOpen) setPalette((p) => p ?? "all");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen]);

  return {
    showGuide,
    setShowGuide,
    showLab,
    setShowLab,
    showMatch,
    setShowMatch,
    matchAutoLatest,
    setMatchAutoLatest,
    showExport,
    setShowExport,
    showShare,
    setShowShare,
    palette,
    setPalette,
    whyItem,
    setWhyItem,
  };
}
