// One page-scroll lock shared by every overlay (ModalShell modals + the command palette).
//
// Each overlay used to capture `document.body.style.overflow` on open and restore it on close.
// That breaks when overlays overlap: the palette opens a modal (Lab, or a "why isn't X here"
// verdict) whose own close is deferred a frame behind the palette's, so the second overlay
// captures the *locked* "hidden" as its "previous" value and restores the page to hidden when it
// finally closes — scroll stuck with nothing open. A shared counter can't get this wrong: the
// body is frozen while any overlay holds the lock and released exactly once the last one lets go.

import { useEffect } from "react";

let locks = 0;
let restore = "";

/** Freeze `document.body` scroll for as long as the calling component is mounted. Nestable:
 * N overlays hold N locks; the page unfreezes only when the count returns to zero. */
export function useScrollLock(): void {
  useEffect(() => {
    if (locks === 0) {
      restore = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    locks++;
    return () => {
      locks--;
      if (locks === 0) document.body.style.overflow = restore;
    };
  }, []);
}
