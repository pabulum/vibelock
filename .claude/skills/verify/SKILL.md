---
name: verify
description: Build/launch/drive recipe for verifying Vibelock changes end-to-end in a real browser.
---

# Verifying Vibelock

Vite + React SPA, no backend of its own — it fetches live data from deadlock-api.com at runtime.

## Launch

```bash
npm run dev   # http://localhost:5173/vibelock/  (note the /vibelock/ base path)
```

## Drive (headless browser)

Playwright is already a devDependency (the browser smoke tests use it), so there is nothing to
install. Run the driver script with the repo root as the working directory — e.g. keep it in the
scratchpad and pipe it in with `node --input-type=module < /path/to/drive.mjs` — so
`playwright-core` resolves from the repo's `node_modules`. Drive the system Chromium:

```js
import { chromium } from "playwright-core";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
});
```

- Wait for `main.phases` (build generated), then ~2s more for late fetches.
- **Selects, in order**: `select[0]` hero (labels are hero names), `select[1]` rank,
  `select[2]` patch. Enemies have no select: click `.addenemy` (or `Control+k`) to open the
  command palette (`dialog.palette`), type into `.pal-in`, Enter commits (enemy commits keep
  it open for chaining), Escape closes. Chips: `.enemies .chip`.
- **Hero switches render the OLD build while loading.** After `selectOption`, poll a fingerprint
  (`main.phases .item .name` joined) until it changes (up to ~30s), else you capture stale data.
- Item rows: `.item` (`.muted` = situational/optional, non-muted = core with a role chip
  prefixing the name text: CORE/VALUE/FILLER/PART/SELL). Overtime column: `section.phase.overtime`,
  sell line `.ot-sell`, group headers `h3.grouphdr`.
- The default context reports hover-capable, so item cards take the **hover** path:
  `locator.hover()` opens one and moving the mouse away closes it (Escape/scroll dismissal is
  deliberately not wired there). For the tap path, create the page from
  `browser.newContext({ hasTouch: true, isMobile: true })` and use `locator.tap()`. More detail,
  including simulating a no-anchor browser: memory `headless-reports-no-hover`.

## Gotchas

- Analytics API allows ~200 req/60s per IP — a handful of hero switches is fine; don't sweep the
  whole roster in a loop.
- Icons lazy-load; below-the-fold element screenshots may show blank icon squares. Not a bug.
