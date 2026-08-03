/// <reference types="@vitest/browser/matchers" />

// The Match view, driven end to end in a real browser: type a match id → the payload is fetched and
// validated → pick a seat → the analysis renders.
//
// This is the app's least-defended surface and its most-broken one. It has gone down in production
// twice, both times on an upstream shape change, both times silently: HTTP 200, a Valibot reject,
// and a view that showed an error where a game's analysis should be. Until now nothing rendered it
// at all — the lib/ suites test `analyzeMatch` against hand-built objects, and the app smoke test
// never opens the modal, so every wire between the two was untested.
//
// What these can and can't catch, stated honestly, because the difference is the whole point:
//   - They CANNOT catch upstream drift. The fixture is a captured response; it will keep passing
//     forever after the API changes. That is what `npm run test:contract` is for, and why it talks
//     to the live API instead.
//   - They CAN catch us breaking the path the drift runs through: a schema edit that stops
//     accepting a real payload, a rename that unhooks the analysis from its data, a change that
//     turns "no gold_sources on this sample" into a crash. Every one of those is a regression a
//     commit in this repo introduces, which is exactly what a fixture-backed test is good for.
//
// Assertions are pinned to the captured game's real numbers (see MATCH in scripts/capture-fixtures)
// rather than to "something rendered", so a wire that comes loose and leaves the section rendering
// someone else's figures fails instead of passing.

import { beforeEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { installApiMock } from "./apiMock";
import App from "../App";

const api = installApiMock();

const BAKE = { timeout: 15_000 } as const;

// Facts about the captured match (97000027), read off the fixture. Team 0 won.
const MATCH_ID = "97000027";
const WINNER = { hero: "Mina", kda: "8/1/10" }; // slot 6, team 0
const LOSER = { hero: "Pocket", kda: "1/9/6" }; // slot 8, team 1

beforeEach(() => {
  history.replaceState(null, "", window.location.pathname);
  api.unmatched.length = 0;
});

/** A seat in the "whose game is it?" picker. Matched on hero *and* KDA: the hero name alone also
 * hits the matchup chips on the page behind the modal. */
const seat = (s: { hero: string; kda: string }) =>
  page.getByRole("button", { name: new RegExp(`${s.hero}\\s+${s.kda}`) });

/** Open the Match modal from the masthead and load the fixture match. Leaves the seat picker up. */
async function openMatch() {
  const screen = await render(<App />);
  await expect
    .element(page.getByRole("button", { name: "Match" }), BAKE)
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Match" }));

  const input = page.getByRole("textbox", { name: "Match id" });
  await expect.element(input, BAKE).toBeVisible();
  await userEvent.fill(input, MATCH_ID);
  await userEvent.click(page.getByRole("button", { name: "Analyze" }));
  return screen;
}

test("loads a match and offers every seat in it", async () => {
  await openMatch();

  // The payload parsed: with no linked profile the app can't know which seat is yours, so it asks.
  // Reaching this heading at all means the whole schema accepted a real 12-player payload.
  await expect
    .element(page.getByRole("heading", { name: "Whose game is it?" }), BAKE)
    .toBeVisible();

  const seats = document.querySelectorAll(".matchrecent .matchrow");
  expect(seats).toHaveLength(12);

  // Won/lost per seat is the comparison the team-encoding bug broke (`player.team === winning_team`
  // across two encodings). Team 0 won this game, so these two must disagree.
  const rowFor = (hero: string) =>
    [...seats].find((r) => r.textContent?.includes(hero));
  expect(rowFor(WINNER.hero)?.textContent).toContain("won");
  expect(rowFor(LOSER.hero)?.textContent).toContain("lost");
  expect(rowFor(WINNER.hero)?.textContent).toContain(WINNER.kda);

  expect(document.querySelector(".crash")).toBeNull();
  expect(api.unmatched).toEqual([]);
});

test("analyses a seat: verdict, souls and deaths, from the real payload", async () => {
  await openMatch();
  await expect
    .element(page.getByRole("heading", { name: "Whose game is it?" }), BAKE)
    .toBeVisible();

  // Pick the winning seat.
  await userEvent.click(seat(WINNER));

  // The verdict line: this seat was on the winning team, and its KDA is carried through.
  const head = page.getByText("WIN", { exact: true });
  await expect.element(head, BAKE).toBeVisible();
  const headEl = document.querySelector(".matchhead");
  expect(headEl?.textContent).toContain(WINNER.hero);
  expect(headEl?.textContent).toContain(WINNER.kda);

  // The souls breakdown is computed from gold_sources on the LAST stats sample — the exact field
  // whose flip to null took the view down. If it stops being read, this section renders nothing.
  await expect
    .element(
      page.getByRole("heading", { name: "Where the souls came from" }),
      BAKE,
    )
    .toBeVisible();
  const econRows = document.querySelectorAll(".econrow");
  expect(econRows.length).toBeGreaterThan(2);
  // Real souls, not zeroes: every row shows a per-minute rate, and they can't all be 0.
  const perMin = [...econRows].map((r) =>
    Number(r.querySelector(".fpct")?.textContent?.replace(/\D/g, "") ?? 0),
  );
  expect(perMin.some((n) => n > 0)).toBe(true);

  // Deaths come from death_details (nullish, and absent on plenty of real players).
  await expect
    .element(page.getByRole("heading", { name: "Deaths" }), BAKE)
    .toBeVisible();
  // This seat died once — the count has to survive the trip, not just the section.
  expect(document.querySelector(".matchdeaths")?.textContent).toMatch(/\b1\b/);

  expect(document.querySelector(".crash")).toBeNull();
  expect(document.querySelector(".banner.error")).toBeNull();
  expect(api.unmatched).toEqual([]);
});

test("a losing seat is reported as a loss", async () => {
  // The other half of the win/loss comparison. Cheap, and it's the assertion that would have caught
  // the team-encoding change turning every game into a loss (or every game into a win) rather than
  // into a visible error.
  await openMatch();
  await expect
    .element(page.getByRole("heading", { name: "Whose game is it?" }), BAKE)
    .toBeVisible();
  await userEvent.click(seat(LOSER));

  await expect
    .element(page.getByText("LOSS", { exact: true }), BAKE)
    .toBeVisible();
  expect(document.querySelector(".matchhead")?.textContent).toContain(
    LOSER.kda,
  );
});
