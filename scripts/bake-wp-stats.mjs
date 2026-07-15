// Bakes wp-stats.json from the harvested shards: the win-probability surface plus the two
// statistics that survived the WPA spike's reliability tests (split-half r=0.82 / r=0.96) —
//   items:  state-adjusted value ("excess") = how often buyers WON minus how often the game
//           state at the moment of purchase said they SHOULD win. Positive = the item beats
//           the situations it's bought in; negative = its raw win rate is flattered by them.
//   heroes: closing power = the same excess pooled over everything a hero buys ≈ how much the
//           hero over/under-performs the win probability implied by their team's soul lead.
//           Scalers (Seven) run positive: an even game is quietly a won game. Tempo heroes
//           (Silver) run negative: a soul lead they don't convert was never really theirs.
// Hero-x-item cells are deliberately NOT baked: after removing hero and item main effects the
// remaining interaction is ~0.9pt sd and needs ~3k purchases per cell to detect — noise at our
// window size (see the spike notes). Runs in the harvest workflow after the nightly shard lands;
// locally: node scripts/bake-wp-stats.mjs (env: SHARDS_DIR, OUT).
//
// Method: per-time-bin logistic WP(soul lead) — lead standardized per bin — fit by IRLS on one
// observation per (match, 3-min tick). Purchases are then priced by interpolating the team's
// lead at each buy time. Full-window CV put the model at AUC 0.80, calibrated within ~1pt/decile.

import { createReadStream, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";

const SHARDS_DIR = process.env.SHARDS_DIR || "_data/shards";
const OUT = process.env.OUT || "_data/wp-stats.json";
const MIN_ITEM_N = 2000; // ~±1pt excess SE — below this the number is mostly noise
const MIN_HERO_N = 5000;

const TBINS = [0, 360, 720, 1080, 1440, 1800, 2400, Infinity]; // bin k = [TBINS[k], TBINS[k+1])
const NB = TBINS.length - 1;
const binOf = (t) => {
  for (let k = 0; k < NB; k++) if (t < TBINS[k + 1]) return k;
  return NB - 1;
};

// Linear interpolation matching np.interp: clamps at both edges.
function interp(x, xs, ys) {
  if (x <= xs[0]) return ys[0];
  const n = xs.length;
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0,
    hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  return ys[lo] + ((x - xs[lo]) / (xs[hi] - xs[lo])) * (ys[hi] - ys[lo]);
}

// --- Pass over shards: WP-model observations + purchase events ---

const upgradeTier = new Map(); // item_id -> tier, filters out abilities
const itemName = new Map();
for (const a of await (
  await fetch("https://api.deadlock-api.com/v1/assets/items")
).json()) {
  if (a.type === "upgrade") {
    upgradeTier.set(a.id, a.item_tier ?? 0);
    itemName.set(a.id, a.name);
  }
}
const heroName = new Map();
for (const h of await (
  await fetch("https://api.deadlock-api.com/v1/assets/heroes?only_active=true")
).json())
  heroName.set(h.id, h.name);

const S1_STEP = 180;
const obsT = [],
  obsLead = [],
  obsY = []; // WP-model training rows
const pIid = [],
  pHid = [],
  pT = [],
  pLead = [],
  pWon = []; // purchase events
let nMatches = 0;

// Soul-economy norms: per-source gold-per-minute distributions, per (hero, rank tier). Populated
// from the harvester's economy subsample (players carrying `gold_src`); absent players are skipped.
// Keyed `hero*100 + tier`; each cell maps a source id to an array of per-minute values we percentile
// at the end. See scripts/harvest-matches.mjs SRC_KEEP for the source ids.
const SRC_KEEP = [1, 2, 3, 4, 5, 6, 7, 12];
const FARM_MIN_N = Number(process.env.FARM_MIN_N || 100); // below this a per-cell percentile is too thin to show
const farmCells = new Map();

const shardFiles = readdirSync(SHARDS_DIR)
  .filter((f) => f.endsWith(".ndjson.gz"))
  .sort();

for (const f of shardFiles) {
  const rl = createInterface({
    input: createReadStream(join(SHARDS_DIR, f)).pipe(createGunzip()),
  });
  for await (const line of rl) {
    if (!line) continue;
    const m = JSON.parse(line);
    if (
      (m.winning_team !== "Team0" && m.winning_team !== "Team1") ||
      m.players?.length !== 12
    )
      continue;
    nMatches++;
    const dur = m.duration_s;
    // team0-minus-team1 net worth on a 30s grid; players' sampled series are ~3min apart
    const grid = [];
    for (let t = 0; t <= dur; t += 30) grid.push(t);
    const lead = new Float64Array(grid.length);
    for (const p of m.players) {
      const ts = [0, ...(p.nw_times_s ?? [])];
      const nw = [0, ...(p.nw_series ?? [])];
      const sign = p.team === "Team0" ? 1 : -1;
      for (let g = 0; g < grid.length; g++)
        lead[g] += sign * interp(grid[g], ts, nw);
    }
    const y0 = m.winning_team === "Team0" ? 1 : 0;
    for (let t = S1_STEP; t < dur; t += S1_STEP) {
      obsT.push(t);
      obsLead.push(lead[(t / 30) | 0]);
      obsY.push(y0);
    }
    const mins = Math.max(1, dur / 60);
    for (const p of m.players) {
      const sign = p.team === "Team0" ? 1 : -1;
      const won = p.team === m.winning_team ? 1 : 0;
      for (const it of p.items ?? []) {
        if (!upgradeTier.has(it.item_id)) continue;
        const t = Math.min(it.game_time_s, dur);
        pIid.push(it.item_id);
        pHid.push(p.hero_id);
        pT.push(t);
        pLead.push(sign * lead[Math.min((t / 30) | 0, lead.length - 1)]);
        pWon.push(won);
      }
      // Economy sample (subsampled matches only): file each source's gold/min under (hero, tier).
      if (p.gold_src) {
        const badge =
          (p.team === "Team0"
            ? m.average_badge_team0
            : m.average_badge_team1) ?? 0;
        const tier = Math.floor(badge / 10);
        const key = p.hero_id * 100 + tier;
        let cell = farmCells.get(key);
        if (!cell) farmCells.set(key, (cell = {}));
        for (const src of SRC_KEEP) {
          (cell[src] ??= []).push((p.gold_src[src] ?? 0) / mins);
        }
      }
    }
  }
}
console.log(
  `${nMatches} matches, ${obsY.length} WP obs, ${pWon.length} purchases from ${shardFiles.length} shards`,
);

// --- Per-bin logistic fit (IRLS on [1, lead/sigma]) ---

const model = []; // per bin: {fromS, toS, sigma, w0, w1}
for (let k = 0; k < NB; k++) {
  const x = [],
    y = [];
  for (let j = 0; j < obsY.length; j++)
    if (binOf(obsT[j]) === k) {
      x.push(obsLead[j]);
      y.push(obsY[j]);
    }
  const sigma = Math.sqrt(
    x.reduce((s, v) => s + v * v, 0) / x.length -
      (x.reduce((s, v) => s + v, 0) / x.length) ** 2,
  );
  let w0 = 0,
    w1 = 0;
  for (let iter = 0; iter < 40; iter++) {
    let g0 = 0,
      g1 = 0,
      h00 = 1e-6,
      h01 = 0,
      h11 = 1e-6;
    for (let j = 0; j < y.length; j++) {
      const xs = x[j] / sigma;
      const p = 1 / (1 + Math.exp(-(w0 + w1 * xs)));
      const r = y[j] - p,
        q = p * (1 - p) + 1e-9;
      g0 += r;
      g1 += xs * r;
      h00 += q;
      h01 += q * xs;
      h11 += q * xs * xs;
    }
    const det = h00 * h11 - h01 * h01;
    w0 += (h11 * g0 - h01 * g1) / det;
    w1 += (h00 * g1 - h01 * g0) / det;
  }
  model.push({
    fromS: TBINS[k],
    toS: TBINS[k + 1] === Infinity ? null : TBINS[k + 1],
    sigma,
    w0,
    w1,
  });
}

// --- Price purchases, aggregate per item and per hero ---

const itemAgg = new Map(),
  heroAgg = new Map(); // id -> [n, sumExcess, sumWp, sumWon]
const cellN = new Map(); // hero<<33|item -> purchase count, for the WPA-readiness gauge
let sumExc = 0;
for (let j = 0; j < pWon.length; j++) {
  const b = model[binOf(pT[j])];
  const wp = 1 / (1 + Math.exp(-(b.w0 + (b.w1 * pLead[j]) / b.sigma)));
  const e = pWon[j] - wp;
  sumExc += e;
  for (const [map, key] of [
    [itemAgg, pIid[j]],
    [heroAgg, pHid[j]],
  ]) {
    let a = map.get(key);
    if (!a) map.set(key, (a = [0, 0, 0, 0]));
    a[0]++;
    a[1] += e;
    a[2] += wp;
    a[3] += pWon[j];
  }
  const ck = (BigInt(pHid[j]) << 33n) | BigInt(pIid[j]);
  cellN.set(ck, (cellN.get(ck) ?? 0) + 1);
}

// WPA-readiness: hero-specific item values become worth showing when hero-item cells clear the
// stabilization point — the purchase count where a cell's own data outweighs the shrinkage prior.
// K is from the 2026-07 spike (true hero-item interaction sd ~0.9pt after removing hero and item
// main effects => K = 0.25/sd^2 ~ 3160); revisit if the interaction estimate moves.
const READY_K = 3160;
const CELL_MIN = 200;
const counts = [...cellN.values()].filter((n) => n >= CELL_MIN);
const readiness = {
  k: READY_K,
  cellsTracked: counts.length, // hero-item pairs with a usable floor of data
  cellsPastK: counts.filter((n) => n >= READY_K).length,
  medianCellN: counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)] ?? 0,
};

const items = [...itemAgg.entries()]
  .filter(([, a]) => a[0] >= MIN_ITEM_N)
  .map(([id, a]) => ({
    id,
    name: itemName.get(id) ?? String(id),
    tier: upgradeTier.get(id) ?? 0,
    n: a[0],
    wpBuy: +(a[2] / a[0]).toFixed(4),
    wr: +(a[3] / a[0]).toFixed(4),
    excess: +(a[1] / a[0]).toFixed(4),
  }))
  .sort((x, y) => y.excess - x.excess);

const heroes = [...heroAgg.entries()]
  .filter(([, a]) => a[0] >= MIN_HERO_N)
  .map(([id, a]) => ({
    id,
    name: heroName.get(id) ?? String(id),
    n: a[0],
    closing: +(a[1] / a[0]).toFixed(4),
    wr: +(a[3] / a[0]).toFixed(4),
    se: +Math.sqrt(0.25 / a[0]).toFixed(4),
  }))
  .sort((x, y) => y.closing - x.closing);

// Closing power tracks plain hero win rate closely (measured r≈0.93) — most of it is "good
// heroes win," which the UI already shows. The uniquely informative part is the RESIDUAL:
// closing beyond what the hero's WR predicts (split-half r≈0.97, sd≈1pt). Positive = converts
// even games / does more with less; negative = wins ride on soul leads (snowballer). The chips'
// style hints key off this, not raw closing.
{
  const mx = heroes.reduce((s, h) => s + h.wr, 0) / heroes.length;
  const my = heroes.reduce((s, h) => s + h.closing, 0) / heroes.length;
  const b =
    heroes.reduce((s, h) => s + (h.wr - mx) * (h.closing - my), 0) /
    heroes.reduce((s, h) => s + (h.wr - mx) ** 2, 0);
  for (const h of heroes)
    h.resid = +(h.closing - (my + b * (h.wr - mx))).toFixed(4);
}

// Soul-economy norms: per (hero, tier), each source's gold/min at a small percentile grid, so the
// client can place a single game's per-source farm on the population (like the fundamentals card).
// Only cells with a real sample are emitted; the client falls back to no-benchmark when a cell or
// source is missing (day-one, rare hero/rank).
const FARM_PCTS = [10, 25, 50, 75, 90];
const farmNorms = {};
let farmCellsEmitted = 0;
let farmSamplesTotal = 0;
for (const [key, cell] of farmCells) {
  const hero = Math.floor(key / 100);
  const tier = key % 100;
  const bySrc = {};
  for (const src of SRC_KEEP) {
    const vals = cell[src];
    if (!vals || vals.length < FARM_MIN_N) continue;
    vals.sort((a, b) => a - b);
    bySrc[src] = FARM_PCTS.map((q) =>
      Math.round(
        vals[Math.min(vals.length - 1, Math.floor((q / 100) * vals.length))],
      ),
    );
    farmSamplesTotal += vals.length;
  }
  if (Object.keys(bySrc).length) {
    farmNorms[`${hero}:${tier}`] = {
      n: (cell[SRC_KEEP[0]] ?? []).length,
      src: bySrc,
    };
    farmCellsEmitted++;
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  window: {
    fromDay: shardFiles[0].slice(0, 10),
    toDay: shardFiles.at(-1).slice(0, 10),
    matches: nMatches,
    purchases: pWon.length,
  },
  meanExcess: +(sumExc / pWon.length).toFixed(5), // sanity: should hover ~0; drift means miscalibration
  wpModel: model.map((b) => ({
    ...b,
    sigma: Math.round(b.sigma),
    w0: +b.w0.toFixed(4),
    w1: +b.w1.toFixed(4),
  })),
  readiness,
  items,
  heroes,
  // Percentile grid the farmNorms arrays correspond to (so the client interpolates correctly).
  farmPcts: FARM_PCTS,
  farmNorms,
};
writeFileSync(OUT, JSON.stringify(out) + "\n");
console.log(
  `wrote ${OUT}: ${items.length} items, ${heroes.length} heroes, meanExcess ${out.meanExcess}`,
);
console.log(
  `readiness: ${readiness.cellsPastK}/${readiness.cellsTracked} hero-item cells past k=${READY_K} (median n=${readiness.medianCellN})`,
);
console.log(
  `farm norms: ${farmCellsEmitted} (hero,tier) cells emitted from ${farmSamplesTotal} economy samples`,
);
