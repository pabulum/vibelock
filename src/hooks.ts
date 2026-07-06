// App-level React hooks: the shared async-fetch scaffolding and the "developing" veil.

import { useEffect, useRef, useState, type DependencyList } from "react";
import { friendlyError } from "./lib/errors";

const REDUCED =
  typeof matchMedia !== "undefined" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

// Drives a panel's `--settle` (0 = crisp, ~0.9 = fully veiled). While its query is in
// flight the frosted veil eases in, then *trickles* toward a floor on a curve scaled to
// how long that panel took to load last time — so it reads as honest progress toward
// "present". Crucially it never fully clears on the timer alone: only the real
// completion snaps it to 0, so it can't lie that a piece is ready before its data lands.
// Each panel learns its own timing (an EMA), so a slow cold query and a fast cached one
// settle at the rate they actually arrive. Writes the var imperatively (no re-render).
export function useSettle<T extends HTMLElement>(loading: boolean) {
  const ref = useRef<T>(null);
  const estMs = useRef(900); // EMA of this panel's load time
  const startedAt = useRef(0);
  const raf = useRef(0);

  useEffect(() => {
    cancelAnimationFrame(raf.current);
    const setVar = (k: string, v: number) =>
      ref.current?.style.setProperty(k, v.toFixed(3));

    if (loading) {
      startedAt.current = performance.now();
      if (REDUCED) {
        setVar("--settle", 0.85); // a calm, unreadable static veil — no animated trickle
        return;
      }
      const tick = () => {
        const t = performance.now() - startedAt.current;
        const rampIn = Math.min(t / 240, 1); // ease the veil in so instant loads barely flash
        const progress = Math.min(t / estMs.current, 1);
        const decay = (1 - progress) ** 2; // 1 → 0 as we approach the expected finish
        // Stays heavy enough to keep the content unreadable the whole time; the trickle is
        // only a gentle "developing" hint, never a slide back to legible.
        setVar("--settle", 0.95 * rampIn * (0.82 + 0.18 * decay));
        raf.current = requestAnimationFrame(tick);
      };
      tick();
    } else if (startedAt.current) {
      const dur = performance.now() - startedAt.current;
      estMs.current = estMs.current * 0.7 + dur * 0.3; // learn the timing for next time
      startedAt.current = 0;
      if (REDUCED) {
        setVar("--settle", 0);
        return;
      }
      // The reveal: blur resolves into focus while a brief purple glow pulses — the
      // "this piece just landed" punch.
      const from = Number(ref.current?.style.getPropertyValue("--settle")) || 0;
      const t0 = performance.now();
      const DUR = 560;
      const tick = () => {
        const k = Math.min((performance.now() - t0) / DUR, 1);
        setVar("--settle", from * (1 - k) ** 3); // ease-out to crisp
        setVar(
          "--flash",
          k < 0.28 ? k / 0.28 : Math.max(0, 1 - (k - 0.28) / 0.72),
        ); // pulse
        if (k < 1) raf.current = requestAnimationFrame(tick);
        else {
          setVar("--settle", 0);
          setVar("--flash", 0);
        }
      };
      tick();
    }
    return () => cancelAnimationFrame(raf.current);
  }, [loading]);

  return ref;
}

/**
 * Runs an abortable async task whenever `deps` change and reports whether it's in flight — the shared
 * scaffolding behind every data fetch here: abort the previous run on change/unmount, flip a loading
 * flag, and funnel failures to one error sink. Pass `null`/`false` as `run` to stand down (no fetch, not
 * loading) when a precondition isn't met. The task gets the AbortSignal; guard your setState calls with
 * `!signal.aborted` so a superseded fetch can't clobber the current selection.
 *
 * Lifting the fetch bodies out of `useEffect` and into a task argument is also what keeps the
 * set-state-in-effect rule satisfied: their setState calls no longer sit lexically inside an effect. The
 * single remaining in-effect transition is `setLoading(true)` below — and that render is exactly what we
 * want (it shows the panel's veil), so it's deliberately exempted.
 */
export function useAsyncTask(
  run: ((signal: AbortSignal) => Promise<void>) | null | false,
  deps: DependencyList,
  onError: (message: string) => void,
): boolean {
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!run) return;
    const ctrl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: render the loading veil
    setLoading(true);
    run(ctrl.signal)
      .catch((e) => !ctrl.signal.aborted && onError(friendlyError(e)))
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
    // deps are forwarded by the caller; exhaustive-deps validates them at the call site (additionalHooks).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return loading && !!run;
}
