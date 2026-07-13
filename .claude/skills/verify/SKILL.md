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

No Playwright in the repo. Install `playwright-core` in the scratchpad and drive the system
Chromium:

```js
import { chromium } from "playwright-core";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
});
```

- Wait for `main.phases` (build generated), then ~2s more for late fetches.
- **Selects, in order**: `select[0]` hero (labels are hero names), `select[1]` rank,
  `select[2]` patch, `select[3]` "+ add enemy…" (comp re-rank).
- **Hero switches render the OLD build while loading.** After `selectOption`, poll a fingerprint
  (`main.phases .item .name` joined) until it changes (up to ~30s), else you capture stale data.
- Item rows: `.item` (`.muted` = situational/optional, non-muted = core with a role chip
  prefixing the name text: CORE/VALUE/FILLER/PART/SELL). Overtime column: `section.phase.overtime`,
  sell line `.ot-sell`, group headers `h3.grouphdr`.
- Headless Chromium reports no-hover, so item cards open via the tap path — verify hover-only
  behavior by inspection or a real browser (see memory: headless-reports-no-hover).

## Gotchas

- Analytics API allows ~200 req/60s per IP — a handful of hero switches is fine; don't sweep the
  whole roster in a loop.
- Icons lazy-load; below-the-fold element screenshots may show blank icon squares. Not a bug.
