/// <reference types="@vitest/browser/matchers" />

// Smoke tests: the real <App /> in real Chromium, fed by the fixture fetch mock
// (apiMock.ts). These don't judge the statistics — the lib/ suites do that — they
// guard the composition: assets load, the default selection bakes a build, the
// phase columns render populated, and the selection controls actually re-bake.

import { beforeEach, expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { installApiMock } from "./apiMock";
import App from "../App";

const api = installApiMock();

// Generous ceiling for the full boot cascade (assets → build bake → panels); the
// fixture-backed fetches are instant, so real runs settle far sooner.
const BAKE = { timeout: 15_000 } as const;

beforeEach(() => {
  // The app mirrors its selection into the query string; reset so one test's
  // deep-link can't leak into the next test's initial parse.
  history.replaceState(null, "", window.location.pathname);
  api.unmatched.length = 0;
});

test("boots to a populated build for the default hero", async () => {
  const screen = await render(<App />);

  // Assets land, Abrams (alphabetical first) is selected, the build bakes.
  await expect
    .element(screen.getByRole("heading", { name: /^Lane/ }), BAKE)
    .toBeVisible();
  for (const phase of [/^Early mid/, /^Mid/, /^Late/, /^Overtime buys/]) {
    await expect
      .element(screen.getByRole("heading", { name: phase }), BAKE)
      .toBeVisible();
  }

  const { container } = screen;
  expect(container.querySelector(".metatitle")?.textContent).toContain(
    "Abrams",
  );
  // The meta line's slot economy renders (i.e. the build really baked, not a shell).
  expect(container.querySelector(".meta")?.textContent).toContain(
    "standing slots",
  );
  // Each of the four phase columns (plus the overtime column, which shares the
  // .phase class) holds at least one real item row.
  const phases = container.querySelectorAll("section.phase");
  expect(phases).toHaveLength(5);
  for (const phase of phases) {
    expect(phase.querySelectorAll(".item").length).toBeGreaterThan(0);
  }

  expect(container.querySelector(".banner.error")).toBeNull();
  expect(api.unmatched).toEqual([]);
});

test("honors a deep link's hero and rank", async () => {
  history.replaceState(null, "", "?hero=grey-talon&rank=8");
  const screen = await render(<App />);

  await expect
    .element(screen.getByRole("heading", { name: /^Lane/ }), BAKE)
    .toBeVisible();

  const { container } = screen;
  expect(container.querySelector(".metatitle")?.textContent).toContain(
    "Grey Talon",
  );
  await expect
    .element(screen.getByRole("combobox", { name: "Rank" }))
    .toHaveValue("8");
  expect(api.unmatched).toEqual([]);
});

test("switching hero re-bakes the build", async () => {
  const screen = await render(<App />);

  await expect
    .element(screen.getByRole("heading", { name: /^Lane/ }), BAKE)
    .toBeVisible();

  await screen.getByRole("combobox", { name: "Hero" }).selectOptions("Bebop");

  await expect
    .element(screen.getByRole("combobox", { name: "Hero" }))
    .toHaveDisplayValue("Bebop");
  // The identity block follows the selection and the page settles back to a build.
  await expect
    .poll(() => screen.container.querySelector(".metatitle")?.textContent, BAKE)
    .toContain("Bebop");
  await expect
    .element(screen.getByRole("heading", { name: /^Overtime buys/ }), BAKE)
    .toBeVisible();
  expect(screen.container.querySelector(".banner.error")).toBeNull();
  expect(api.unmatched).toEqual([]);
});
