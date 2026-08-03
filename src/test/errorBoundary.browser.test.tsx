/// <reference types="@vitest/browser/matchers" />

// An untested error boundary is a coin flip — it only ever runs on the day everything else has
// already gone wrong. These render a component that throws and assert the boundary does its two
// jobs: keep the failure legible, and keep it contained.

import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ErrorBoundary } from "../components/ErrorBoundary";

function Boom(): never {
  throw new Error("shape drift: expected number at players.0.team");
}

// React logs caught render errors to the console itself, and the boundary adds its own report —
// both are noise here, not failures.
function quietConsole() {
  vi.spyOn(console, "error").mockImplementation(() => {});
}

test("a scoped boundary reports the failure and leaves its siblings alone", async () => {
  quietConsole();
  const screen = await render(
    <div>
      <p>the page around it</p>
      <ErrorBoundary scope="panel" what="This panel">
        <Boom />
      </ErrorBoundary>
    </div>,
  );

  await expect
    .element(screen.getByText(/This panel couldn't be rendered/))
    .toBeVisible();
  // The thrown message is shown verbatim — it's what a bug report needs to quote.
  await expect.element(screen.getByText(/shape drift/)).toBeVisible();
  // ...and the rest of the tree rendered normally.
  await expect.element(screen.getByText("the page around it")).toBeVisible();
});

test("the root boundary offers a reload and a cache-clearing reset", async () => {
  quietConsole();
  const screen = await render(
    <ErrorBoundary scope="root" what="Vibelock">
      <Boom />
    </ErrorBoundary>,
  );

  await expect
    .element(screen.getByText(/Vibelock stopped rendering/))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Reload", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: /Clear cached data/ }))
    .toBeVisible();
});
