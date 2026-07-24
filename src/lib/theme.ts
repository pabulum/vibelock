// Colour scheme. Two states, light and dark — there's no visible "auto", but until the reader
// actually presses the toggle nothing is stored and the page keeps tracking the OS, so the common
// case still needs no interaction.
//
// Two things get written to <html>, and they are not redundant:
//   • `color-scheme` re-resolves every `light-dark()` pair in tokens.css at once, and gets the UA
//     to retint scrollbars and form controls to match.
//   • `data-theme` is what the *non-colour* rules key off — grain opacity, shadow recipe, the
//     monochrome-icon inversion. Those can't use `light-dark()` (it resolves to a <color> and
//     nothing else), and a `prefers-color-scheme` media query would be wrong: it reports the OS,
//     so a reader who forces light on a dark OS would get light colours with dark-mode grain.

export type Theme = "light" | "dark";

const KEY = "vibelock:theme";

const prefersDark = () => matchMedia("(prefers-color-scheme: dark)");

/** The reader's explicit choice, or null while we're still following the OS. */
function override(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    // storage unavailable (private mode) — follow the OS for this session
  }
  return null;
}

/** What the page should be rendering right now. */
export function resolvedTheme(): Theme {
  return override() ?? (prefersDark().matches ? "dark" : "light");
}

/** Push the resolved theme onto <html>. Safe to call as often as you like. */
export function applyTheme(): void {
  const t = resolvedTheme();
  const root = document.documentElement;
  // Only pin color-scheme once there's a choice to honour; left as "light dark" the UA can still
  // do the right thing for anything we haven't tokenised.
  root.style.colorScheme = override() ? t : "light dark";
  root.dataset.theme = t;
}

const listeners = new Set<() => void>();

function notify() {
  applyTheme();
  for (const l of listeners) l();
}

/** Store a choice and apply it. From here on the OS no longer gets a vote. */
export function setTheme(t: Theme): void {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // best-effort: the theme still applies for this session
  }
  notify();
}

/** useSyncExternalStore plumbing for the toggle — so the button re-renders both when it's pressed
 * and when the OS flips underneath a reader who has never pressed it. */
export function subscribeTheme(cb: () => void): () => void {
  listeners.add(cb);
  const mq = prefersDark();
  mq.addEventListener("change", notify);
  return () => {
    listeners.delete(cb);
    mq.removeEventListener("change", notify);
  };
}
