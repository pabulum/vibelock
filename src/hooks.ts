// App-level React hooks: the "developing" veil. (Data fetching lives in TanStack Query —
// useSettle is driven from a query's `isFetching`.)

import { useEffect, useRef } from "react";

const REDUCED =
  typeof matchMedia !== "undefined" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

// How long a load must persist before the veil appears at all. A cached query resolves in a frame
// or two; veiling it just makes the page flinch. Only a load slow enough to be worth acknowledging
// (past this) gets veiled.
const ARM_MS = 110;
// How long the reveal waits after a load ends, so a second source starting right behind the first
// keeps the same veil instead of flashing twice. The build watches TWO queries (its archetype fetch
// *and* a counters re-rank); on a hero switch they finish a beat apart, and without this bridge that
// reads as two settles. Cancelled the instant a new load re-arms (React runs this effect's cleanup
// before the next run), so back-to-back sources coalesce into one continuous veil.
const GRACE_MS = 120;
// The steady veil opacity while a query is in flight. Substantial but not fully opaque: the scrim is a
// panel-colored, grain-textured cover (see the CSS) — NOT a see-through backdrop-blur, which smears
// while the content reorders behind it (that was the "digital artifacting"). At this hold it obscures
// the churn while still reading as frosted glass rather than a flat block.
const HOLD = 0.82;

// Drives a panel's `--settle` (0 = crisp, HOLD = covered) and `--flash` (0 → 1 → 0, the completion
// pulse). While its query is in flight the scrim eases in to a steady hold; when the data lands it
// eases back out while `--flash` pulses once — the "this piece just landed" punch. Both vars are set
// in JS on the *section* and inherit down to each box (.phase/.crow/.mchip), written imperatively so
// it never re-renders. Only real completion clears the scrim, so it can't lie that a piece is ready
// before its data arrives.
//
// Three behaviors keep it from flickering: (1) the scrim is *armed*, not shown, for the first ARM_MS
// of a load — an instant/cached load finishes before it ever appears; (2) once shown, a load
// re-entering keeps the existing scrim rather than re-arming (no re-pulse); (3) the reveal is deferred
// by GRACE_MS so a second source (a counters re-rank right after the build) bridges into the same
// settle — one pulse per load, not one per re-render.
export function useSettle<T extends HTMLElement>(loading: boolean) {
  const ref = useRef<T>(null);
  const raf = useRef(0);
  const armTimer = useRef(0);
  const graceTimer = useRef(0);
  const shown = useRef(false); // is a scrim currently painted (armed-and-elapsed)?

  useEffect(() => {
    const setVar = (k: string, v: number) =>
      ref.current?.style.setProperty(k, v.toFixed(3));

    if (loading) {
      // A new load. If a scrim is already up (a counters re-rank behind the build), keep it exactly
      // as-is — the cleanup below already cancelled any pending reveal, so it just holds. Only arm a
      // fresh scrim when nothing is shown yet.
      if (!shown.current) {
        const startVeil = () => {
          shown.current = true;
          setVar("--flash", 0);
          if (REDUCED) {
            setVar("--settle", HOLD); // a calm static cover — no animation
            return;
          }
          const t0 = performance.now();
          const tick = () => {
            const k = Math.min((performance.now() - t0) / 150, 1); // quick ease-in to the hold
            setVar("--settle", HOLD * k);
            if (k < 1) raf.current = requestAnimationFrame(tick);
          };
          tick();
        };
        setVar("--settle", 0); // clear any residue before arming
        setVar("--flash", 0);
        armTimer.current = window.setTimeout(startVeil, ARM_MS);
      }
    } else if (!shown.current) {
      // Load ended before the scrim ever armed (cached/instant) — ensure fully crisp.
      clearTimeout(armTimer.current);
      setVar("--settle", 0);
      setVar("--flash", 0);
    } else {
      // Defer the reveal: if another source re-arms within GRACE_MS, this effect's cleanup cancels
      // the timer and the scrim stays up — build + counters read as one settle, not two.
      graceTimer.current = window.setTimeout(() => {
        shown.current = false;
        cancelAnimationFrame(raf.current);
        if (REDUCED) {
          setVar("--settle", 0);
          return;
        }
        // The reveal: the scrim eases off while `--flash` pulses ONCE — a single "this piece just
        // landed" punch. It fires only when a real settle completes (armed + past the grace), and the
        // grace coalescing means one pulse per load, not one per re-render, so it reads as a landing,
        // not a strobe.
        const from =
          Number(ref.current?.style.getPropertyValue("--settle")) || HOLD;
        const t0 = performance.now();
        const DUR = 460;
        const tick = () => {
          const k = Math.min((performance.now() - t0) / DUR, 1);
          setVar("--settle", from * (1 - k) ** 2); // ease-out to crisp
          setVar(
            "--flash",
            k < 0.3 ? k / 0.3 : Math.max(0, 1 - (k - 0.3) / 0.7),
          );
          if (k < 1) raf.current = requestAnimationFrame(tick);
          else {
            setVar("--settle", 0);
            setVar("--flash", 0);
          }
        };
        tick();
      }, GRACE_MS);
    }
    return () => {
      cancelAnimationFrame(raf.current);
      clearTimeout(armTimer.current);
      clearTimeout(graceTimer.current);
    };
  }, [loading]);

  return ref;
}
