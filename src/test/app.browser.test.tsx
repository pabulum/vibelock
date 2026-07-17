/// <reference types="@vitest/browser/matchers" />

// Smoke tests: the real <App /> in real Chromium, fed by the fixture fetch mock
// (apiMock.ts). These don't judge the statistics — the lib/ suites do that — they
// guard the composition: assets load, the default selection bakes a build, the
// phase columns render populated, and the selection controls actually re-bake.

import { beforeEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
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

test("Ctrl+K palette fuzzy-switches the hero", async () => {
  const screen = await render(<App />);
  await expect
    .element(screen.getByRole("heading", { name: /^Lane/ }), BAKE)
    .toBeVisible();

  await userEvent.keyboard("{Control>}k{/Control}");
  const input = screen.getByRole("combobox", { name: "Search commands" });
  await expect.element(input).toBeVisible();
  await input.fill("beb");
  await userEvent.keyboard("{Enter}");

  // The commit closes the palette (deferred past the exit transition) and re-bakes.
  await expect
    .poll(() => screen.container.querySelector("dialog.palette"), BAKE)
    .toBeNull();
  await expect
    .poll(() => screen.container.querySelector(".metatitle")?.textContent, BAKE)
    .toContain("Bebop");
  await expect
    .element(screen.getByRole("heading", { name: /^Overtime buys/ }), BAKE)
    .toBeVisible();
  expect(screen.container.querySelector(".banner.error")).toBeNull();
  expect(api.unmatched).toEqual([]);
});

test("the counter picker's palette chains enemy adds and chips remove them", async () => {
  const screen = await render(<App />);
  await expect
    .element(screen.getByRole("heading", { name: /^Lane/ }), BAKE)
    .toBeVisible();

  await screen.getByRole("button", { name: /add enemies/ }).click();
  const input = screen.getByRole("combobox", { name: "Search commands" });
  await input.fill("haze");
  await userEvent.keyboard("{Enter}");
  // keepOpen: the palette stays up with a cleared query, ready for the next name.
  await expect.element(input).toHaveValue("");
  await input.fill("sev");
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard("{Escape}");
  await expect
    .poll(() => screen.container.querySelector("dialog.palette"))
    .toBeNull();

  // Both chips landed and the comp re-rank note appears.
  await expect
    .element(screen.getByRole("button", { name: "Haze ✕" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Seven ✕" }))
    .toBeVisible();
  await expect
    .element(screen.getByText(/re-ranked for Haze, Seven/), BAKE)
    .toBeVisible();

  await screen.getByRole("button", { name: "Haze ✕" }).click();
  await expect
    .poll(() =>
      [...screen.container.querySelectorAll(".enemies .chip")].map(
        (c) => c.textContent,
      ),
    )
    .toEqual(["Seven ✕"]);
  expect(screen.container.querySelector(".banner.error")).toBeNull();
  expect(api.unmatched).toEqual([]);
});

test("hovering a community build shows the structured diff", async () => {
  const screen = await render(<App />);
  await expect
    .element(screen.getByRole("heading", { name: /^Lane/ }), BAKE)
    .toBeVisible();
  await expect
    .poll(() => screen.container.querySelector(".crow"), BAKE)
    .not.toBeNull();

  const row = screen.container.querySelector(".crow")!;
  await page.elementLocator(row).hover();
  await expect.poll(() => document.querySelector(".buildprev")).not.toBeNull();

  const prev = document.querySelector(".buildprev")!;
  // The diff renders verdict sections with classed icons and a counts footer.
  expect(prev.querySelectorAll(".bp-sub").length).toBeGreaterThan(0);
  expect(
    prev.querySelectorAll(
      ".bp-item.agree, .bp-item.differ, .bp-item.added, .bp-item.missing",
    ).length,
  ).toBeGreaterThan(0);
  expect(prev.querySelector(".bp-foot")?.textContent).toMatch(
    /agree|differ|only/,
  );
  expect(api.unmatched).toEqual([]);
});

test("share panel paints the card and offers the app link", async () => {
  const screen = await render(<App />);
  await expect
    .element(screen.getByRole("heading", { name: /^Lane/ }), BAKE)
    .toBeVisible();

  await screen.getByRole("button", { name: "⤴ Share" }).click();

  // The card paints asynchronously (icon loads settle first, failures degrade to
  // placeholder tiles) — poll for the finished canvas.
  await expect
    .poll(() => screen.container.querySelector("canvas.share-preview"), BAKE)
    .not.toBeNull();

  // No baked og/manifest.json under the test server, so the link falls back from the
  // shim to the plain app URL — still carrying the full selection.
  const url = screen.container.querySelector(".share-url")?.textContent ?? "";
  expect(url).toContain("hero=abrams");
  expect(url).not.toContain("/og/");
  expect(screen.container.querySelector(".banner.error")).toBeNull();
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
