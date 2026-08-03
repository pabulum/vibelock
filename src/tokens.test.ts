// Contrast guard for the design tokens.
//
// A Lighthouse run caught --ink-3 — the mono label voice used in ~70 places — sitting at 3.58:1 on
// the dark paper, i.e. failing WCAG AA everywhere it appears, at 10px. That's the kind of regression
// nothing else here can see: it isn't a type error, it isn't a broken render, and the browser smoke
// tests are happy to screenshot unreadable text. So the ramp is asserted directly, off the
// stylesheet itself rather than a copy of the values, and in a plain node suite that runs in
// milliseconds — the audit only has to catch it once for the test to keep catching it forever.
//
// AA (4.5:1) not AAA: every ink step is small text by design (the whole page is a dense instrument),
// so 4.5 is the bar that actually applies, and clearing it on *every* substrate means no component
// can compose a failing pair by putting dim ink on the raised surface.

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

/** `--name: light-dark(#light, #dark);` → the two hexes. Throws rather than skipping: a token that
 * stopped matching is a token that stopped being checked, which is the failure mode to avoid. */
function lightDark(name: string): { light: string; dark: string } {
  const m = css.match(
    new RegExp(
      `--${name}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`,
      "i",
    ),
  );
  if (!m)
    throw new Error(`--${name} is not a light-dark() pair of hex colours`);
  return { light: m[1], dark: m[2] };
}

const srgb = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
/** sRGB transfer function, inverted — the linear-light values both formulas below are defined on. */
const linear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

/** WCAG relative luminance, then the 4.5:1-style ratio it feeds. */
function luminance(hex: string): number {
  const [r, g, b] = srgb(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Oklab lightness — perceptual, unlike the WCAG luminance above, so it's the honest way to ask
 * "are these still three distinct greys". */
function okLightness(hex: string): number {
  const [r, g, b] = srgb(hex).map(linear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

const INKS = ["ink", "ink-2", "ink-3"] as const;
const SUBSTRATES = ["paper", "surface", "surface-2"] as const;
const AA_SMALL_TEXT = 4.5;

test.each(["light", "dark"] as const)(
  "every ink step clears WCAG AA on every substrate (%s)",
  (mode) => {
    for (const ink of INKS) {
      for (const substrate of SUBSTRATES) {
        const ratio = contrast(
          lightDark(ink)[mode],
          lightDark(substrate)[mode],
        );
        expect(
          ratio,
          `--${ink} on --${substrate} (${mode}) is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
      }
    }
  },
);

// The other direction: the cheap way to pass the test above is to flatten the ramp until every step
// is the same near-white, which would erase the hierarchy the three steps exist to carry. 0.06 of
// oklab lightness is roughly the point where two greys stop reading as deliberately different.
test.each(["light", "dark"] as const)(
  "the three ink steps stay distinguishable (%s)",
  (mode) => {
    const [ink, ink2, ink3] = INKS.map((n) => okLightness(lightDark(n)[mode]));
    expect(Math.abs(ink - ink2)).toBeGreaterThan(0.06);
    expect(Math.abs(ink2 - ink3)).toBeGreaterThan(0.06);
    // ...and in that order: --ink-3 is the quietest, never brighter than --ink-2.
    expect(Math.abs(ink - ink3)).toBeGreaterThan(Math.abs(ink - ink2));
  },
);
