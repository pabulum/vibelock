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
- **Comment culture**: comments state constraints, gotchas, and *why* — never what the
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

## Verification

- `npm test` = unit suites + browser smoke tests (real App in headless Chromium against
  fixture API responses). One-time local setup: `npx playwright install chromium`.
- The fetch mock (src/test/apiMock.ts) routes by URL pathname; a new API endpoint must
  get a fixture there or smoke tests fail loudly (by design). Refresh fixtures with
  `node scripts/capture-fixtures.mjs`.
- `npm run build` typechecks (`tsc -b`) then bundles. `npm run lint` must stay clean.
- End-to-end checks in a real browser: use the project's `verify` skill.
