// Lighthouse CI config (.github/workflows/lighthouse.yml, or `npx @lhci/cli autorun` locally).
//
// What this is for: the app has no backend and no telemetry, so nothing but a person looking at it
// notices when a change makes the page slower or less readable. An audit is the cheapest substitute.
// It has already earned its place — the first run found --ink-3 failing WCAG AA in ~70 places at
// 10px, which is now fixed in tokens.css and pinned by src/tokens.test.ts.
//
// CommonJS because @lhci/cli require()s its config, and the package is ESM.
//
// The assertion policy, and why each threshold is where it is:
//
//  - Accessibility is the gate, at 100. It's the category whose failures are real defects rather
//    than trade-offs, it's deterministic (no network timing in it), and the page is at 100 today —
//    so anything less is a regression this commit introduced.
//  - Best-practices and SEO are gates just under their current scores, for the same reason with a
//    point of slack for audit churn between Lighthouse releases.
//  - Performance is a WARNING, not a gate. The audited page fans out ~15 requests to a live
//    third-party API from a shared CI runner IP; its LCP is partly a measurement of how busy
//    deadlock-api.com is this minute. Failing a PR on that would be failing it on the weather.
//    It's still collected and still printed, because the trend is worth seeing.

module.exports = {
  ci: {
    collect: {
      // Mobile emulation (the Lighthouse default) is kept deliberately: this thing gets opened on a
      // phone next to a keyboard, mid-match, which is the harsher and more honest profile.
      startServerCommand: "npx vite preview --port 4173 --strictPort",
      // LHCI's default readiness pattern is /listen|ready/i, which vite preview never prints — it
      // announces itself with "Local: <url>". Without this it waits out the full 30s timeout on
      // every run and then proceeds anyway.
      startServerReadyPattern: "Local:",
      url: ["http://localhost:4173/vibelock/"],
      // Three runs, median reported — one cold run against a live API is mostly noise.
      numberOfRuns: 3,
    },
    assert: {
      assertions: {
        "categories:accessibility": ["error", { minScore: 1 }],
        "categories:best-practices": ["error", { minScore: 0.95 }],
        "categories:seo": ["error", { minScore: 1 }],
        "categories:performance": ["warn", { minScore: 0.8 }],

        // Belt and braces on the one that bit: a category score can absorb a single failing audit,
        // and contrast is the audit whose regression is invisible to everyone who isn't affected.
        "color-contrast": ["error", { minScore: 1 }],

        // OFF, deliberately, and not a lapse. Lighthouse wants ≥12px body text on mobile; this UI
        // is a dense instrument whose mono labels are 10–11.5px by design (see tokens.css), and it
        // reports "34% legible text" as a result. Changing that is a design decision about what the
        // app *is*, not a lint to satisfy — so the audit is disabled rather than silently failing
        // the best-practices gate forever. Revisit it as a design question, not as a CI failure.
        "font-size": "off",

        // Known, measured, not gated. The page assembles progressively as ~8 independent queries
        // land, so each strip that arrives pushes everything under it: measured 0.24–0.38 across
        // runs, the spread being how fast the live API answered that minute. Fixing it means
        // reserving space for strips that may legitimately never render (no movers this patch, no
        // profile), which is a decision about how the page should look while loading, not a tweak.
        //
        // The obvious cheap fix is NOT the answer — reserving a screen under the loading
        // placeholder was tried and measured at 0.47, i.e. worse. See App.css `.loadstate`.
        //
        // 0.45 is set above the observed band on purpose: a warning that fires on every single run
        // is one people stop reading. This one fires when the page gets genuinely less stable.
        "cumulative-layout-shift": ["warn", { maxNumericValue: 0.45 }],
      },
    },
    upload: {
      // No LHCI server to talk to — reports land as workflow artifacts instead.
      target: "filesystem",
      outputDir: "./.lighthouseci",
    },
  },
};
