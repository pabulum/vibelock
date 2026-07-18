// The Ctrl+K command palette: a native <dialog> holding one fuzzy query field over every header
// control (commands assembled in lib/palette). Follows ModalShell's dialog conventions — native
// top layer, focus trap, Escape via the `close` event, deferred unmount so the exit transition
// plays — but is its own shell: the input IS the header, and a commit can keep the dialog open
// (enemy toggles chain: "haz⏎ vind⏎ …"). Fully mouse-driven too: click to commit, hover to
// highlight, and the browse view (empty query) lists every command under group headers.

import { Fragment, useEffect, useRef, useState } from "react";
import {
  searchPalette,
  type PaletteAction,
  type PaletteCommand,
} from "../lib/palette";
import { useScrollLock } from "./useScrollLock";

// Keep in sync with dialog.palette's transition duration in features/AppModals.css (see ModalShell
// for why unmount is deferred).
const EXIT_MS = 120;

export function CommandPalette({
  commands,
  placeholder,
  onRun,
  onClose,
}: {
  commands: PaletteCommand[];
  placeholder: string;
  /** Maps a committed command's action onto the app's handlers (only ever called from
   * commit events, so the handlers may touch refs/state freely). */
  onRun: (action: PaletteAction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  // Freeze the page behind the palette (shared counter — see useScrollLock; the palette opens
  // modals whose overlapping close would strand a per-overlay lock in the "hidden" state).
  useScrollLock();
  useEffect(() => {
    ref.current?.showModal();
    // Focus the query field explicitly: React's autoFocus fires while the closed dialog is
    // still display:none, and showModal's own focus pick lands on the dialog itself.
    inputRef.current?.focus();
  }, []);

  // React Compiler memoizes this on [commands, query] — no useMemo needed (see CLAUDE.md).
  const results = searchPalette(commands, query);
  // Clamp rather than store-and-sync: an enemy toggle rebuilds `commands` under a live
  // highlight, and the ranked list can shrink past it.
  const hi = Math.min(highlight, Math.max(0, results.length - 1));

  // Keep the highlighted row in view while arrowing through a scrolled list.
  useEffect(() => {
    listRef.current
      ?.querySelector(".pal-opt.on")
      ?.scrollIntoView({ block: "nearest" });
  }, [hi, results]);

  const commit = (c: PaletteCommand | undefined) => {
    if (!c) return;
    onRun(c.action);
    if (c.keepOpen) {
      setQuery(""); // clear for the next name; focus never left the input
      setHighlight(0);
    } else {
      ref.current?.close();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight(Math.min(hi + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight(Math.max(hi - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(results[hi]);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      // The global listener only opens (see features/useModals); the toggle-close lives here so
      // the exit transition plays instead of an abrupt unmount.
      e.preventDefault();
      ref.current?.close();
    }
    // Escape needs no wiring: the native dialog cancels and fires `close`.
  };

  return (
    <dialog
      ref={ref}
      className="palette"
      aria-label="Command palette"
      onClose={() => {
        if (closing.current) return;
        closing.current = true;
        window.setTimeout(onClose, EXIT_MS);
      }}
      onClick={(e) => {
        // Backdrop click closes — same coordinate check as ModalShell (the dialog IS the card).
        const el = ref.current;
        if (!el || e.target !== el) return;
        const r = el.getBoundingClientRect();
        if (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        )
          el.close();
      }}
    >
      <input
        className="pal-in"
        role="combobox"
        aria-label="Search commands"
        aria-expanded="true"
        aria-controls="pal-list"
        aria-activedescendant={results[hi] ? `pal-${results[hi].id}` : undefined}
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
        ref={inputRef}
        autoComplete="off"
        spellCheck={false}
      />
      <div className="pal-list" id="pal-list" role="listbox" ref={listRef}>
        {results.length === 0 && <div className="pal-empty">no matches</div>}
        {results.map((c, i) => (
          <Fragment key={c.id}>
            {/* Group headers only in the browse view — a ranked search interleaves groups. */}
            {!query.trim() && c.group !== results[i - 1]?.group && (
              <div className="pal-hdr">{c.group}</div>
            )}
            <button
              id={`pal-${c.id}`}
              type="button"
              role="option"
              aria-selected={i === hi}
              className={`pal-opt${i === hi ? " on" : ""}${c.active ? " active" : ""}`}
              // mousedown, not click: the input keeps focus (no blur race), so a mouse
              // pick during enemy chaining flows straight back into typing.
              onMouseDown={(e) => {
                e.preventDefault();
                commit(c);
              }}
              onMouseEnter={() => setHighlight(i)}
            >
              {c.image ? (
                <img src={c.image} alt="" loading="lazy" />
              ) : (
                <span className="pal-ico" aria-hidden="true">
                  ◆
                </span>
              )}
              <span className="pal-lbl">{c.label}</span>
              {c.active && (
                <span className="pal-check" aria-label="current">
                  ✓
                </span>
              )}
              <span className="pal-hint">{c.hint}</span>
            </button>
          </Fragment>
        ))}
      </div>
      <div className="pal-foot" aria-hidden="true">
        ↑↓ navigate · Enter select · Esc close
      </div>
    </dialog>
  );
}
