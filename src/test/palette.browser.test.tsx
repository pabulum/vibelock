/// <reference types="@vitest/browser/matchers" />

// Regression guard for the command palette's counter flow: opening via Ctrl+K, chaining
// enemy adds without the dialog closing, and — the reported bug — that page scroll is
// released once the palette closes.

import { StrictMode } from "react";
import { beforeEach, expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { installApiMock } from "./apiMock";
import App from "../App";

const api = installApiMock();
const BAKE = { timeout: 15_000 } as const;

beforeEach(() => {
  history.replaceState(null, "", window.location.pathname);
  api.unmatched.length = 0;
  document.body.style.overflow = "";
});

function pressCtrlK() {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
  );
}

const nativeSetValue = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value",
)!.set!;

/** Type into the palette's controlled input (native setter so React's onChange fires) and Enter. */
function typeAndEnter(input: HTMLInputElement, text: string) {
  input.focus();
  nativeSetValue.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

test("Ctrl+K enemy add chains and releases scroll on close", async () => {
  // StrictMode on purpose — it mirrors main.tsx and surfaces mount-effect cleanup bugs
  // (showModal/overflow) that a single mount hides.
  const screen = await render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await expect
    .element(screen.getByRole("heading", { name: /^Lane/ }), BAKE)
    .toBeVisible();

  pressCtrlK();
  await expect
    .poll(() =>
      screen.container.querySelector<HTMLDialogElement>("dialog.palette")?.open,
    )
    .toBe(true);
  const dialog =
    screen.container.querySelector<HTMLDialogElement>("dialog.palette");
  expect(getComputedStyle(document.body).overflow).toBe("hidden");

  // First counter via its "vs …" command.
  const input = screen.container.querySelector<HTMLInputElement>(".pal-in")!;
  typeAndEnter(input, "vs bebop");
  await expect
    .poll(() => screen.container.querySelector(".pal-opt.on .pal-lbl")?.textContent)
    .toContain("Bebop");
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );

  // keepOpen + chain: the dialog stays open AND flips into enemies mode — the placeholder is now
  // the enemies-picker copy, so the next bare name is another counter, not a hero switch.
  await expect.poll(() => dialog?.open).toBe(true);
  await expect
    .poll(() =>
      screen.container.querySelector<HTMLInputElement>(".pal-in")?.placeholder,
    )
    .toContain("enemies");
  expect(
    screen.container.querySelector<HTMLInputElement>(".pal-in")?.value,
  ).toBe("");

  // Second counter by BARE name (no "vs" prefix) — proof the chain works.
  typeAndEnter(input, "lash");
  await expect
    .poll(() => screen.container.querySelector(".pal-opt.on .pal-lbl")?.textContent)
    .toContain("Lash");
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  await expect.poll(() => dialog?.open).toBe(true);

  // Both enemies are now active in the list (current enemies sort first, marked active).
  await expect
    .poll(
      () =>
        screen.container.querySelectorAll(".pal-opt.active .pal-lbl").length,
      BAKE,
    )
    .toBeGreaterThanOrEqual(2);

  // Esc-equivalent close, and confirm scroll is released (the reported stuck-overflow bug).
  dialog?.close();
  await expect
    .poll(() => getComputedStyle(document.body).overflow, BAKE)
    .not.toBe("hidden");
});

test("opening a modal from the palette does not strip scroll (overlap lock)", async () => {
  const screen = await render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await expect
    .element(screen.getByRole("heading", { name: /^Lane/ }), BAKE)
    .toBeVisible();

  pressCtrlK();
  await expect
    .poll(() =>
      screen.container.querySelector<HTMLDialogElement>("dialog.palette")?.open,
    )
    .toBe(true);

  // Commit the "Lab" panel command: the palette closes (deferred) while the Lab modal opens.
  const input = screen.container.querySelector<HTMLInputElement>(".pal-in")!;
  input.focus();
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  setValue.call(input, "lab experimental");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await expect.poll(() =>
    screen.container.querySelector(".pal-opt.on .pal-lbl")?.textContent,
  ).toContain("Lab");
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );

  // The Lab dialog opens; close it and scroll must be released.
  await expect
    .poll(
      () => screen.container.querySelector<HTMLDialogElement>("dialog.lab"),
      BAKE,
    )
    .toBeTruthy();
  screen.container.querySelector<HTMLDialogElement>("dialog.lab")?.close();
  await expect
    .poll(() => getComputedStyle(document.body).overflow, BAKE)
    .not.toBe("hidden");
});
