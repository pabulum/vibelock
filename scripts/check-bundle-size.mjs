// Bundle budget. Run after a build (npm run size, and as the last step of npm run check / CI):
//
//   node scripts/check-bundle-size.mjs
//
// The thing this protects is specific. Vibelock is a static page with no backend, opened mid-match
// on whatever connection a living room has — the entry bundle is the whole time-to-first-anything,
// and it is the one number that only ever moves in one direction unless something watches it. A
// dependency added for a small feature, a lazy chunk that quietly stops being lazy, a polyfill
// pulled in by a config change: each is a few KB nobody notices, and the drift is only visible
// against a number written down beforehand. So the numbers below are written down.
//
// Measured gzipped, because that's what crosses the wire. Budgets are the current size plus enough
// headroom for ordinary work — when a change genuinely needs more, RAISE THE NUMBER in the same
// commit. That edit is the point: it makes "this feature costs 12KB" a thing a reviewer sees.
//
// Fonts are excluded and unbudgeted: three latin-subset families, self-hosted, byte-frozen unless
// someone adds a weight, and `font-display: swap` keeps them off the critical path anyway.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ASSETS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "assets",
);

const KB = 1024;

// Budgets in KB (gzipped). Keep the comments — the number is only meaningful next to what it buys.
const BUDGETS = {
  // The entry chunk: React, TanStack Query, Valibot, every schema, and the whole build generator.
  // The generator is the app, so this is expected to be large; it is not expected to creep.
  entry: 165,
  // All CSS, in one file. The design system is hand-written, so this tracks stylesheet sprawl.
  css: 16,
  // Everything route-split behind a modal (Guide, Lab, Match, Export, Share). A jump here usually
  // means a lazy boundary broke and the chunk merged into the entry — check `entry` first.
  lazy: 40,
};

function gzipped(dir, predicate) {
  return readdirSync(dir)
    .filter(predicate)
    .map((name) => ({
      name,
      kb: gzipSync(readFileSync(join(dir, name))).length / KB,
    }));
}

const isJs = (f) => f.endsWith(".js");
const isCss = (f) => f.endsWith(".css");
// Vite names the entry chunk `index-<hash>.js`; every other .js in assets/ is a lazy chunk.
const isEntry = (f) => isJs(f) && /^index-/.test(f);

let files;
try {
  files = readdirSync(ASSETS);
} catch {
  console.error(
    "No dist/assets — run `npm run build` before checking the bundle budget.",
  );
  process.exit(1);
}
if (!files.some(isEntry)) {
  // A rename upstream (or an empty build) would otherwise report 0.00 KB and pass forever.
  console.error(
    "No entry chunk matching /^index-.*\\.js$/ in dist/assets — the build layout changed; " +
      "update isEntry() in scripts/check-bundle-size.mjs.",
  );
  process.exit(1);
}

const groups = {
  entry: gzipped(ASSETS, isEntry),
  css: gzipped(ASSETS, isCss),
  lazy: gzipped(ASSETS, (f) => isJs(f) && !isEntry(f)),
};

let over = false;
for (const [group, budget] of Object.entries(BUDGETS)) {
  const items = groups[group];
  const total = items.reduce((a, f) => a + f.kb, 0);
  const pct = Math.round((total / budget) * 100);
  const verdict = total > budget ? "OVER" : "ok";
  if (total > budget) over = true;

  console.log(
    `${group.padEnd(6)} ${total.toFixed(1).padStart(6)} KB / ${String(budget).padStart(3)} KB  ${String(pct).padStart(3)}%  ${verdict}`,
  );
  // Per-file breakdown for the multi-file groups, so an OVER points at a culprit.
  if (items.length > 1)
    for (const f of items.sort((a, b) => b.kb - a.kb))
      console.log(`       ${f.kb.toFixed(1).padStart(6)} KB  ${f.name}`);
}

if (over) {
  console.error(
    "\nOver budget. Either trim it, or raise the budget in scripts/check-bundle-size.mjs\n" +
      "in this same commit — with a note on what the extra weight buys.",
  );
  process.exit(1);
}
console.log("\nAll bundle groups within budget (gzipped).");
