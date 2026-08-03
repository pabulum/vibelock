# Vibelock — notes for Claude sessions

Data-driven Deadlock item builds. React 19 + Vite 8 + TypeScript, static on GitHub Pages,
no backend — everything runs in the browser against api.deadlock-api.com. Read
docs/METHODOLOGY.md before touching anything statistical.

## Conventions that aren't obvious from the code

- **React Compiler is ON** (see vite.config.ts: `reactCompilerPreset`). Write plain
  components — do NOT add `useMemo`/`useCallback`/`React.memo` for performance; the
  compiler memoizes automatically and bails out per-component on anything unsafe.
  Existing hand-memoization predates the compiler: harmless, remove it opportunistically
  when editing a component, don't add more.
- **Comment culture**: comments state constraints, gotchas, and _why_ — never what the
  next line does. Match the density and voice of the file you're in.
- **Never `git commit`** — the user commits their own work. Keep changes chunked
  feature-by-feature so the tree stays splittable into commits.
- **CSP is first-party only** (built in vite.config.ts). Don't add CDN scripts, external
  fonts, or new connect-src hosts; inline or self-host instead.
- New dependencies are allowed but earn their place — prefer platform features
  (popover/anchor CSS, `<dialog>`, View Transitions are already in use).

## Architecture pointers

- Data fetching: TanStack Query (src/queryClient.ts) with Valibot schemas validating
  every API response at the boundary (src/api/). The match endpoints have a separate,
  much tighter rate family — never add retries there (see comments in api/deadlock.ts).
- Build generation: src/lib/buildgen/* modules behind the src/lib/buildGenerator.ts
  facade. Statistical primitives live in src/lib/stats.ts and are unit-tested.
- URL is the source of truth for selection state (src/lib/urlState.ts); shared links
  must reproduce the sender's view.
- **Design system: src/tokens.css** — the whole palette, type scale, and geometry, as
  semantic tokens (`--paper`/`--ink`/`--rule`, `--pos`/`--neg`/`--warn`/`--spirit`,
  `--accent-ui`, `--r-sm`). Component stylesheets must never reach for a raw hex; light
  mode is `light-dark()` on those tokens and comes free. The look is a technical document:
  hairline rules instead of cards, **no radii at all** (only `--r-pill`, for portraits; the UA
  reset in App.css zeroes what Firefox puts on form controls), mono (IBM Plex Mono) for
  every number and label, Archivo for running text, Space Grotesk for headings. Colour is
  meaning-only — a delta inside ±2pt gets none.
- **Mode-dependent rules that aren't colours** must key off `:root[data-theme="dark"|"light"]`,
  never `@media (prefers-color-scheme:)`. `light-dark()` resolves to a `<color>` and nothing
  else, and the media query reports the _OS_ — so with the theme toggle (src/lib/theme.ts,
  which writes both `color-scheme` and `data-theme` to `<html>`) a forced light theme on a
  dark machine would otherwise get light colours with dark-mode grain. Current users: grain
  opacity, shadow recipe, and the invert() that makes Deadlock's white ability art — pure
  greyscale, luminance ~1.0 — legible on light paper.

## Verification

- `npm test` = unit suites + browser smoke tests (real App in headless Chromium against
  fixture API responses). One-time local setup: `npx playwright install chromium`.
- The fetch mock (src/test/apiMock.ts) routes by URL pathname; a new API endpoint must
  get a fixture there or smoke tests fail loudly (by design). Refresh fixtures with
  `node scripts/capture-fixtures.mjs` — pass names (`… matchMetadata`) to refresh only some,
  since a full run rewrites all of them and buries a one-endpoint change.
- **The match-metadata fixture is a real pinned game (97000027)** and the Match smoke tests assert
  its actual numbers, so re-capturing it against a different match means updating
  src/test/matchModal.browser.test.tsx with the new one. Note the capture projection drops nulls,
  so the fixture proves nothing about nullability — that's src/api/schemas.test.ts's job, which
  walks the schema and nulls every `nullish` field back in.
- `npm run build` typechecks (`tsc -b`) then bundles. `npm run lint` must stay clean.
- **`npm run test:contract` validates every Valibot schema against the LIVE API** (project
  `contract`, src/test/contract.live.test.ts) — the guard fixtures structurally cannot provide,
  since a captured response keeps passing forever after upstream changes shape. Not in `npm test`
  (needs network, fails on upstream's deploys not ours); a nightly workflow runs it and files one
  auto-closing issue. After any schema edit, run it before believing the edit.
- `npm run size` enforces gzipped bundle budgets (scripts/check-bundle-size.mjs) after a build.
  Over budget ⇒ raise the number _in the same commit_, with a note on what the weight buys.
- Lighthouse runs on PRs touching src/ (lighthouserc.cjs). **Accessibility is gated at 100** and
  contrast is pinned twice — once by the audit, once by src/tokens.test.ts, which reads tokens.css
  and asserts every ink step clears WCAG AA on every substrate. Performance is a warning only
  (the audited page fetches from a live third-party API on a shared runner IP). The `font-size`
  audit is deliberately off: 10–11.5px mono labels are the design, not a lint failure.
- End-to-end checks in a real browser: use the project's `verify` skill.
- **Ground truth for anything statistical: `/v1/sql`.**
  `GET https://api.deadlock-api.com/v1/sql?query=<ClickHouse SQL>` runs read-only SQL over the
  same database the analytics endpoints aggregate — `/v1/sql/tables` lists them,
  `/v1/sql/tables/{t}/schema` describes one, and `match_player` is 201 columns of per-player
  match record. Check an aggregate endpoint against it before trusting a number from it: that's
  how `hero-stats.matches` was caught reading ~13% high as a pick-rate denominator while
  item-flow-stats' own count agreed with `count(DISTINCT match_id)` to under 1%. Also the fastest
  way to settle a spike (does this effect survive a control? is this population big enough?)
  without harvesting match metadata at 10/min.
  **2 req/min, 20 req/hour, per IP** — a diagnostic and research tool, never a client path and
  never in a loop. Budget it: write one aggregate query, not N narrow ones.
