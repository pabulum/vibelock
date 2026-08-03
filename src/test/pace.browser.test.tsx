/// <reference types="@vitest/browser/matchers" />

// Smoke tests for the surfaces that read the baked pace/lane blocks.
//
// These exist because those blocks are OPTIONAL in the schema — they have to be, since the client
// ships before the first bake that emits them — and an optional field that silently never arrives
// looks exactly like a working feature nobody notices is missing. The unit suites prove the maths;
// this proves the panels actually mount against a real fixture and would fail loudly if the shape
// drifted.
//
// The fixture's pace/lane numbers are a genuine bake over a real harvested shard, not hand-written
// shapes (scripts/bake-wp-stats.mjs). Two things about it are worth knowing before editing it:
// the cells are keyed at TIER 11, because that is what highestPopulatedFloor resolves to against
// the badge-distribution fixture and a cell keyed anywhere else renders nothing; and the lane pair
// counts are projected from the one-day source bake to a 30-day window, so the display floors these
// tests exercise are the ones production will hit.

import { beforeEach, expect, test } from "vitest";

import { render } from "vitest-browser-react";
import { installApiMock } from "./apiMock";
import App from "../App";

const api = installApiMock();
const BAKE = { timeout: 15_000 } as const;

beforeEach(() => {
  history.replaceState(null, "", window.location.pathname);
  api.unmatched.length = 0;
});

test("the Soul pace panel renders the population curve without a linked account", async () => {
  const screen = await render(<App />);
  await expect
    .element(screen.getByRole("heading", { name: /^Soul pace/ }), BAKE)
    .toBeVisible();

  const { container } = screen;
  const pace = container.querySelector(".pace");
  expect(pace).toBeTruthy();

  // The curve is drawn: a band, a median line and the winning-games mean. Without an account there
  // is no "you" line and no per-phase rows, and the panel must still stand up on the population
  // half alone rather than rendering an empty shell.
  expect(pace!.querySelector(".pacechart svg .pband")).toBeTruthy();
  expect(pace!.querySelector(".pacechart svg .pmedian")).toBeTruthy();
  expect(pace!.querySelector(".pacechart svg .pyouline")).toBeNull();
  expect(pace!.querySelector(".pacerows")).toBeNull();

  // Identity is never colour-alone: the legend names every series that was drawn.
  const legend = pace!.querySelector(".pacelegend")?.textContent ?? "";
  expect(legend).toContain("middle half");
  expect(legend).toContain("median");

  // The chart carries its own accessible description rather than leaving the SVG unlabelled.
  const svg = pace!.querySelector(".pacechart svg");
  expect(svg?.getAttribute("role")).toBe("img");
  expect(svg?.getAttribute("aria-label") ?? "").toMatch(/net worth over time/i);

  // The survivorship caveat travels with the curve — it is not optional framing.
  expect(pace!.textContent).toContain("lasted");
});

test("lane matchups render as their own row, separate from whole-game matchups", async () => {
  const screen = await render(<App />);
  await expect
    .element(screen.getByRole("heading", { name: /^Lane/ }), BAKE)
    .toBeVisible();

  const { container } = screen;
  const row = container.querySelector(".matchups .lbl.lane");
  expect(row).toBeTruthy();
  expect(row!.textContent).toContain("Loses lane to");

  const chips = container.querySelectorAll(".lanechip");
  expect(chips.length).toBeGreaterThan(0);
  // Every chip shows a signed soul figure, never a win rate — the residual is a differential.
  for (const chip of chips) {
    const diff = chip.querySelector(".ldiff")?.textContent ?? "";
    expect(diff).toMatch(/^-?\d+$/);
    expect(chip.textContent).not.toContain("%");
  }
});

test("build rows carry a buy-time clock", async () => {
  const screen = await render(<App />);
  await expect
    .element(screen.getByRole("heading", { name: /^Lane/ }), BAKE)
    .toBeVisible();

  const clocks = screen.container.querySelectorAll(".line2 .buyat");
  expect(clocks.length).toBeGreaterThan(0);
  expect(clocks[0].textContent).toMatch(/^by \d+:\d{2}$/);
});

test("no fixture went unmatched", () => {
  // The mock routes by pathname; an unmatched URL means a new endpoint arrived without a fixture,
  // which these tests are supposed to catch loudly rather than silently pass around.
  expect(api.unmatched).toEqual([]);
});
