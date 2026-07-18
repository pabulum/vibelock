// Bakes the per-hero Open Graph pages into dist/og/ at deploy time:
//   og/<hero>.png   — a 1200×630 link-preview card (dark, hero portrait + wordmark), rendered
//                     by screenshotting a small HTML page in headless Chromium (playwright is
//                     already a dev dependency and the deploy workflow installs its Chromium
//                     for the browser smoke tests).
//   og/<hero>.html  — a shim page carrying hero-specific og:/twitter: meta tags. OG crawlers
//                     don't run JS, and GitHub Pages can't render per-URL meta server-side —
//                     so the app's Share button hands out this URL instead of the SPA's. Real
//                     visitors bounce straight into the app: an inline script forwards the full
//                     query string (?hero=…&rank=…) into ../, and a meta refresh covers no-JS.
//   og/manifest.json — the baked slugs; the Share panel checks it before preferring a shim
//                     (a hero released after the last deploy simply falls back to the app URL).
//
// Run after `vite build`: node scripts/bake-og-cards.mjs (env: DIST, SITE).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const DIST = process.env.DIST || "dist";
const SITE = process.env.SITE || "https://pabulum.github.io/vibelock/";

/** Keep in sync with slugify in src/lib/urlState.ts — the shim filename must match the
 * hero slug the app's Share button builds. */
const slugify = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const esc = (s) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

// The wordmark font, inlined as a data URI so the card page needs no network for type.
const grotesk = readFileSync(
  "node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2",
).toString("base64");

/** The card page. Same palette as the app (App.css tokens) so the preview and the site
 * read as one thing. The portrait hides itself if the CDN fails — the card still works. */
function cardHtml(hero) {
  const tagline = hero.tagline ? `<p class="tag">${esc(hero.tagline)}</p>` : "";
  const img = hero.image
    ? `<img class="face" src="${esc(hero.image)}" onerror="this.style.display='none'">`
    : "";
  return `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face {
    font-family: "Space Grotesk";
    font-weight: 700;
    src: url(data:font/woff2;base64,${grotesk}) format("woff2");
  }
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; overflow: hidden;
    display: flex; align-items: stretch;
    background: #0f1216; color: #e6e9ee;
    font: 26px/1.4 system-ui, sans-serif;
    background-image:
      radial-gradient(900px 420px at 85% 0%, rgba(111, 177, 255, 0.16), transparent 70%),
      radial-gradient(700px 500px at 0% 100%, rgba(155, 109, 209, 0.12), transparent 70%);
  }
  .left {
    flex: 1; display: flex; flex-direction: column; justify-content: center;
    padding: 64px 24px 64px 72px; min-width: 0;
  }
  .brand {
    font-family: "Space Grotesk", system-ui, sans-serif;
    font-size: 30px; font-weight: 700; letter-spacing: 0.4px; color: #6fb1ff;
  }
  h1 {
    font-family: "Space Grotesk", system-ui, sans-serif;
    font-size: 92px; line-height: 1.04; font-weight: 700;
    margin: 18px 0 10px; overflow-wrap: break-word;
  }
  .tag { font-style: italic; color: #98a2b3; font-size: 27px; }
  .what { margin-top: 26px; color: #e6e9ee; font-size: 28px; max-width: 620px; }
  .site { margin-top: 34px; color: #98a2b3; font-size: 22px; }
  .right { flex: 0 0 440px; display: flex; align-items: center; padding: 48px 56px 48px 0; }
  .face {
    width: 100%; height: 100%; object-fit: cover; object-position: top;
    border-radius: 24px; border: 1px solid #2a313b;
    box-shadow: 0 0 80px rgba(111, 177, 255, 0.18);
  }
</style>
<div class="left">
  <div class="brand">VIBELOCK</div>
  <h1>${esc(hero.name)}</h1>
  ${tagline}
  <p class="what">A phased, annotated item build — with the win-rate numbers behind every pick.</p>
  <div class="site">${esc(SITE.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</div>
</div>
<div class="right">${img}</div>`;
}

/** The shim the Share button hands out. Crawlers read the meta; people get forwarded into the
 * app with their full selection (the query string the share link carried). */
function shimHtml(hero, slug) {
  const title = `${hero.name} — Vibelock build`;
  const desc = `${hero.tagline ? `${hero.tagline}. ` : ""}A phased, annotated ${hero.name} item build for your rank — core and situational picks, with the win-rate numbers behind each one.`;
  const png = `${SITE}og/${slug}.png`;
  const url = `${SITE}og/${slug}.html`;
  const app = `../?hero=${slug}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${esc(title)}</title>
    <meta name="robots" content="noindex" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Vibelock" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(desc)}" />
    <meta property="og:url" content="${esc(url)}" />
    <meta property="og:image" content="${esc(png)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="${esc(title)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(title)}" />
    <meta name="twitter:description" content="${esc(desc)}" />
    <meta name="twitter:image" content="${esc(png)}" />
    <script>
      // Forward the full selection (?hero=…&rank=…&vs=…) into the app; crawlers never run
      // this, which is the whole point of the shim.
      location.replace("../" + (location.search || "?hero=${slug}") + location.hash);
    </script>
    <!-- No-JS fallback ONLY inside noscript: link-preview crawlers (Discord, Slack,
         Facebook) honor a bare meta-refresh as a redirect and would scrape the SPA's
         generic index.html card instead of the tags above. Inside noscript, browsers
         with JS disabled still redirect and crawlers read this page's own tags. -->
    <noscript>
      <meta http-equiv="refresh" content="0; url=${esc(app)}" />
    </noscript>
  </head>
  <body>
    <p>Redirecting to <a href="${esc(app)}">${esc(hero.name)} on Vibelock</a>…</p>
  </body>
</html>
`;
}

const heroes = (
  await (
    await fetch(
      "https://api.deadlock-api.com/v1/assets/heroes?only_active=true",
    )
  ).json()
)
  .filter((h) => h.name)
  .map((h) => ({
    name: h.name,
    image: h.images?.icon_hero_card ?? h.image,
    tagline: h.description?.role?.trim() || undefined,
  }));

const outDir = join(DIST, "og");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1200, height: 630 },
});

const slugs = [];
for (const hero of heroes) {
  const slug = slugify(hero.name);
  // networkidle so the portrait (the page's one network fetch) is painted before the shot.
  await page.setContent(cardHtml(hero), { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(outDir, `${slug}.png`) });
  writeFileSync(join(outDir, `${slug}.html`), shimHtml(hero, slug));
  slugs.push(slug);
}
await browser.close();

writeFileSync(join(outDir, "manifest.json"), JSON.stringify(slugs));
console.log(`baked ${slugs.length} OG cards + shims into ${outDir}`);
