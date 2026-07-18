// Shared native-<dialog> shell for the app's modals (Guide, Lab, Match, Export): the browser
// owns the top layer, focus trapping, and Escape; @starting-style CSS (see `dialog.guide` in
// features/AppModals.css) animates enter/exit. Replaces the old portal + .guide-backdrop overlay.

import { useEffect, useRef, type ReactNode } from "react";
import { useScrollLock } from "./useScrollLock";

// How long the exit transition runs (keep in sync with the `dialog.guide` transition duration in
// features/AppModals.css). Unmounting the instant `close` fires would cut the @starting-style exit
// short, so the parent's onClose is deferred by this much.
const EXIT_MS = 180;

/** The modal card: a `<dialog>` styled as the `.guide` column (pinned header + scrolling body).
 * Every dismissal — the ✕ button, a click on the backdrop, Escape — funnels through the native
 * `close` event, which notifies the parent after the exit transition has played. */
export function ModalShell({
  className,
  label,
  title,
  onClose,
  children,
}: {
  /** Extra class(es) on the dialog card, e.g. "lab" / "export". */
  className?: string;
  /** Accessible name for the dialog. */
  label: string;
  /** Header content (rendered inside the pinned <h2>). */
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closing = useRef(false);

  // Freeze the page behind the modal so wheel/touch can't scroll it. (showModal makes the rest of
  // the page inert, but the *document* scrollbar still responds to the wheel without this.) Shared
  // counter, not a per-modal capture/restore — see useScrollLock for why overlays must share one.
  useScrollLock();
  useEffect(() => {
    ref.current?.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className={`guide${className ? ` ${className}` : ""}`}
      aria-label={label}
      onClose={() => {
        if (closing.current) return;
        closing.current = true;
        window.setTimeout(onClose, EXIT_MS);
      }}
      onClick={(e) => {
        // The dialog element IS the card, so a ::backdrop click targets the dialog itself with
        // coordinates outside its box — coordinate-check so clicks on the card's own padding
        // (which also target the dialog) don't dismiss it.
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
      <header className="guide-head">
        <h2>{title}</h2>
        <button
          type="button"
          className="guide-x"
          onClick={() => ref.current?.close()}
          aria-label="Close"
        >
          ✕
        </button>
      </header>
      <div className="guide-body">{children}</div>
    </dialog>
  );
}
