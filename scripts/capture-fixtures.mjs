// Captures live API responses as test fixtures for the browser smoke tests
// (src/test/). Each response is projected down to exactly the fields the client
// reads (the Raw* shapes in src/api/deadlock.ts), so fixtures stay small and the
// diff stays reviewable when they're refreshed.
//
//   node scripts/capture-fixtures.mjs
//
// The smoke tests route fetch() by URL *pathname only* (src/test/apiMock.ts), so
// the query params used here just need to be representative, not exact: one hero
// (Abrams, id 1), no rank filter (denser data), the API's default 30-day window.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://api.deadlock-api.com";
const HERO_ID = 1; // Abrams — the app's alphabetical-first default selection
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "test",
  "fixtures",
);

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/** Keep only the listed keys (dropping undefined), recursing where a key maps to a projector. */
function pick(obj, spec) {
  const out = {};
  for (const [key, sub] of Object.entries(spec)) {
    const v = obj?.[key];
    if (v === undefined || v === null) continue;
    out[key] = typeof sub === "function" ? sub(v) : v;
  }
  return out;
}

// ---- Projections: mirror the Raw* shapes in src/api/deadlock.ts ----

const projHero = (h) =>
  pick(h, {
    id: true,
    name: true,
    image: true,
    images: (im) => pick(im, { icon_hero_card: true }),
    description: (d) => pick(d, { role: true }),
    items: true,
  });

const projProp = (p) =>
  pick(p, { value: true, postfix: true, label: true, disable_value: true });

// Entries without a slot type + tier are filtered out of the item list by the client;
// only the ability map reads them, and it touches just these fields — so the heavy
// tooltip/properties payload is dropped for them.
const projAbility = (i) =>
  pick(i, {
    id: true,
    name: true,
    type: true,
    class_name: true,
    image: true,
    shop_image: true,
  });

const projShopItem = (i) =>
  pick(i, {
    id: true,
    name: true,
    type: true,
    class_name: true,
    item_tier: true,
    item_slot_type: true,
    cost: true,
    shop_image: true,
    image: true,
    description: (d) => (typeof d === "object" ? pick(d, { desc: true }) : d),
    is_active_item: true,
    properties: (props) =>
      Object.fromEntries(
        Object.entries(props).map(([k, v]) => [k, projProp(v)]),
      ),
    tooltip_sections: (secs) =>
      secs.map((s) =>
        pick(s, {
          section_type: true,
          section_attributes: (attrs) =>
            attrs.map((a) =>
              pick(a, {
                loc_string: true,
                properties: true,
                elevated_properties: true,
                important_properties: true,
              }),
            ),
        }),
      ),
    component_items: true,
  });

const projItem = (i) =>
  i.item_slot_type && i.item_tier ? projShopItem(i) : projAbility(i);

const projBuild = (env) => ({
  hero_build: pick(env.hero_build ?? {}, {
    hero_build_id: true,
    name: true,
    author_account_id: true,
    version: true,
    last_updated_timestamp: true,
    publish_timestamp: true,
    details: (d) =>
      pick(d, {
        mod_categories: (cats) =>
          cats.map((c) =>
            pick(c, {
              name: true,
              optional: true,
              mods: (mods) =>
                mods.map((m) =>
                  pick(m, { ability_id: true, imbue_target_ability_id: true }),
                ),
            }),
          ),
        ability_order: (ao) =>
          pick(ao, {
            currency_changes: (ch) =>
              ch.map((c) => pick(c, { ability_id: true })),
          }),
      }),
  }),
});

// ---- Capture ----

const captures = [
  {
    file: "patches.json",
    url: `${BASE}/v2/patches`,
    // Only the title is read (the MM-DD-YYYY in it); 40 entries ≈ a year of windows.
    project: (rows) => rows.slice(0, 40).map((p) => pick(p, { title: true })),
  },
  {
    file: "heroes.json",
    url: `${BASE}/v1/assets/heroes?only_active=true`,
    project: (rows) => rows.map(projHero),
  },
  {
    file: "items.json",
    url: `${BASE}/v1/assets/items`,
    project: (rows) => rows.map(projItem),
  },
  {
    file: "itemStats.json",
    url: `${BASE}/v1/analytics/item-stats?hero_id=${HERO_ID}&min_matches=20`,
  },
  {
    // min_matches raised above the app's floor purely to shrink the fixture —
    // fewer junk-tail rows, same shape and same popular items.
    file: "flowStats.json",
    url: `${BASE}/v1/analytics/item-flow-stats?hero_ids=${HERO_ID}&min_matches=400`,
  },
  {
    file: "heroBuildStats.json",
    url: `${BASE}/v1/analytics/hero-build-stats/${HERO_ID}?min_matches=20`,
  },
  {
    file: "builds.json",
    url: `${BASE}/v1/builds?hero_id=${HERO_ID}&only_latest=true&sort_by=favorites&sort_direction=desc&limit=30`,
    project: (rows) => rows.map(projBuild),
  },
  {
    // All pairs is 1–2 MB; the popular head is what build generation actually
    // consults, so keep the 8000 most-played pairs.
    file: "permutationStats.json",
    url: `${BASE}/v1/analytics/item-permutation-stats?hero_id=${HERO_ID}&comb_size=2`,
    project: (rows) =>
      rows
        .sort((a, b) => b.wins + b.losses - (a.wins + a.losses))
        .slice(0, 8000),
  },
  {
    file: "abilityOrder.json",
    url: `${BASE}/v1/analytics/ability-order-stats?hero_id=${HERO_ID}&min_matches=100`,
  },
  {
    file: "counterMatrix.json",
    url: `${BASE}/v1/analytics/hero-counter-stats?min_matches=500`,
  },
  {
    file: "heroLadder.json",
    url: `${BASE}/v1/analytics/hero-stats`,
  },
  {
    file: "wpStats.json",
    url: "https://raw.githubusercontent.com/pabulum/vibelock/data/wp-stats.json",
  },
];

await mkdir(OUT, { recursive: true });
for (const c of captures) {
  const raw = await getJson(c.url);
  const data = c.project ? c.project(raw) : raw;
  const text = JSON.stringify(data);
  await writeFile(join(OUT, c.file), text);
  console.log(
    `${c.file.padEnd(22)} ${(text.length / 1024).toFixed(0).padStart(6)} KB  ← ${c.url}`,
  );
}
