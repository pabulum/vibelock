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

/**
 * A player's rank tier, or null when this shard row carries no usable rank.
 *
 * Reads the PER-PLAYER `average_badge` first and only falls back to the match-level team pair.
 * That order is not a preference, it's a repair: the team-level columns went to zero upstream on
 * 2026-07-31 (measured against /v1/sql on 2026-08-03 — every match mode, 100% of rows), and
 * `Math.floor(0 / 10)` is a perfectly valid tier 0, so every rank-keyed cell baked after that date
 * silently filed into "Obscurus" instead of failing. Shards older than the outage have the team
 * columns and no per-player badge, hence the fallback.
 *
 * Null (rather than 0) when neither is present, so callers must decide what to do with an unranked
 * row instead of inheriting a bucket that looks real. Badge 0 is itself "no ranked result yet" and
 * is treated the same way.
 */
function tierOfPlayer(p, m) {
  const badge =
    p.average_badge ||
    (p.team === "Team0" ? m.average_badge_team0 : m.average_badge_team1) ||
    0;
  return badge > 0 ? Math.floor(badge / 10) : null;
}

// --- Soul pace: how a hero's net worth accumulates at a rank, and where a player falls off it ---
//
// Two different questions, so two different accumulators:
//   levels — net worth AT a tick, for the curve a single game is plotted against.
//   rates  — souls/min WITHIN a phase window, for the diagnosis. These are not derivable from the
//            levels: the percentile of a difference is not the difference of percentiles, and the
//            whole point is to find the one phase where a player's income falls off a cliff that a
//            whole-game average hides.
//
// Both are kept as fixed-width histograms rather than sample arrays. A 30-day window is ~3.2M
// player-rows; retaining values to percentile at the end would be hundreds of MB, while a
// histogram is ~14KB per (hero, tier) cell and streams exactly. Bucket widths are far below the
// noise floor of what the client displays.
//
// SURVIVORSHIP, stated once and carried into the UI: a tick is only recorded for games that
// actually REACHED it, so the 32-minute band describes games that lasted 32 minutes — a biased,
// closer-fought subset. That's unavoidable (there is no net worth at t for a game that ended at
// t-1) and it is why the client labels the curve "games that got this far" rather than "games".
const PACE_TICKS = [240, 480, 720, 960, 1200, 1440, 1680, 1920, 2160];
// Windows match the build's own phase columns so a weak phase here names the same span as the
// column of items that phase is supposed to buy. The geometry is src/lib/phases.ts
// (FLOW_PHASE_INTERVAL_S = 600, four columns) — mirrored as a literal because scripts/ deliberately
// shares no code with src/, the same way harvest-matches.mjs mirrors RANKED_MODE_FROM_S. If the
// flow interval is ever retuned, this moves with it or the labels go back to being a fiction.
const PACE_WINDOWS = [
  [0, 600],
  [600, 1200],
  [1200, 1800],
  [1800, 2400],
];
// Ceilings sit well clear of the observed tails on purpose: a histogram that saturates reports its
// top bucket as the answer for every percentile above the clip, which reads as a real number and
// is not one. Measured against a full day: p90 net worth peaks ~44k at 36 min and p90 rate ~1.6k
// souls/min in the 30-40 window, so both ceilings are roughly double the live tail.
const LEVEL_BUCKET = 100; // souls
const LEVEL_BUCKETS = 900; // → 0…90,000 souls
const RATE_BUCKET = 5; // souls/min
const RATE_BUCKETS = 600; // → 0…3,000 souls/min
const PACE_MIN_N = Number(process.env.PACE_MIN_N || 200);
// Levels carry a narrower grid than rates on purpose. The level curve is DRAWN — it needs a band
// (p25–p75) and a median, and the winner/loser means alongside say more about pace than a p10 tail
// would. The window rates are INTERPOLATED against, to place a player's phase on the ladder, and
// that wants the wider grid so the tails don't clamp. Every cell is paid for on every page load.
const LEVEL_PCTS = [25, 50, 75];
const RATE_PCTS = [10, 25, 50, 75, 90];

// key `heroId * 100 + tier` → { hist, levelN, rateN, winSum, winN }
const paceCells = new Map();
const paceCell = (key) => {
  let c = paceCells.get(key);
  if (!c)
    paceCells.set(
      key,
      (c = {
        // One flat array: the tick levels first, then the window rates.
        hist: new Uint32Array(
          PACE_TICKS.length * LEVEL_BUCKETS +
            PACE_WINDOWS.length * RATE_BUCKETS,
        ),
        levelN: new Uint32Array(PACE_TICKS.length),
        rateN: new Uint32Array(PACE_WINDOWS.length),
        // Mean level at each tick split by outcome — the "winning pace" line drawn over the
        // percentile band. Means, not percentiles: two numbers per tick instead of a histogram,
        // and the line only has to show the gap, not support a placement.
        winSum: new Float64Array(PACE_TICKS.length),
        winN: new Uint32Array(PACE_TICKS.length),
        lossSum: new Float64Array(PACE_TICKS.length),
        lossN: new Uint32Array(PACE_TICKS.length),
      }),
    );
  return c;
};
const RATE_OFFSET = PACE_TICKS.length * LEVEL_BUCKETS;

// --- Lane matchups: the hero-vs-hero read the analytics API genuinely cannot answer ---
//
// `assigned_lane` is harvested per player and until now was read by nothing. Lanes are 2v2 (three
// lanes, twelve players — verified against /v1/sql), so a raw "hero A vs hero B" net-worth
// differential is contaminated by both lane PARTNERS. Reporting that raw number would rediscover
// "Seven farms well" once per opponent, which is the same mistake the counter matrix makes before
// Bradley-Terry de-noising (lib/matchups).
//
// So the same shape of fix: fit an additive per-hero lane strength by least squares over every lane
// instance (+1 for each hero on side A, −1 for each on side B, target = the soul differential at
// 10 minutes), then report each PAIR as its residual against what strengths alone predict. What
// survives is genuine lane rock-paper-scissors rather than farm ability.
//
// Normal equations are accumulated on the fly — X'X is only heroes², so the fit costs one small
// solve at the end and no per-instance storage at all.
const LANE_TICK = 600; // the 10-minute mark: laning is over, the differential is the lane's result
const LANE_MIN_DURATION = 700; // a game must have actually reached the tick
const LANE_MIN_N = Number(process.env.LANE_MIN_N || 200);
const LANE_SHRINK_K = Number(process.env.LANE_SHRINK_K || 300); // pair evidence worth K observations
const LANE_RIDGE = 1e-3;
const heroIds = [...heroName.keys()].sort((a, b) => a - b);
const heroIdx = new Map(heroIds.map((id, i) => [id, i]));
const NH = heroIds.length;
const laneXtX = new Float64Array(NH * NH);
const laneXty = new Float64Array(NH);
// ordered pair key `aIdx * NH + bIdx` → { n, sum }
const lanePairs = new Map();
let laneObs = 0;

// Rank coverage, tracked so the badge outage that motivated `tierOfPlayer` can never recur
// silently: a bake where every row lands in one tier is a broken bake, not a converged ladder.
const tierCounts = new Map();
let ranklessRows = 0;

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
      // A rankless row is skipped rather than pooled — a norm the client labels "at Oracle" has to
      // actually be Oracle's.
      const tier = tierOfPlayer(p, m);
      if (tier === null) ranklessRows++;
      else tierCounts.set(tier, (tierCounts.get(tier) ?? 0) + 1);
      if (p.gold_src && tier !== null) {
        const key = p.hero_id * 100 + tier;
        let cell = farmCells.get(key);
        if (!cell) farmCells.set(key, (cell = {}));
        for (const src of SRC_KEEP) {
          (cell[src] ??= []).push((p.gold_src[src] ?? 0) / mins);
        }
      }

      // Soul pace: this player's own net-worth curve, bucketed under (hero, tier).
      if (tier !== null) {
        const ts = [0, ...(p.nw_times_s ?? [])];
        const nw = [0, ...(p.nw_series ?? [])];
        if (nw.length > 1) {
          const cell = paceCell(p.hero_id * 100 + tier);
          for (let i = 0; i < PACE_TICKS.length; i++) {
            const t = PACE_TICKS[i];
            if (t > dur) break; // never extrapolate past the game's own end
            const v = interp(t, ts, nw);
            const b = Math.min(
              LEVEL_BUCKETS - 1,
              Math.max(0, (v / LEVEL_BUCKET) | 0),
            );
            cell.hist[i * LEVEL_BUCKETS + b]++;
            cell.levelN[i]++;
            if (won) {
              cell.winSum[i] += v;
              cell.winN[i]++;
            } else {
              cell.lossSum[i] += v;
              cell.lossN[i]++;
            }
          }
          for (let w = 0; w < PACE_WINDOWS.length; w++) {
            const [a, b] = PACE_WINDOWS[w];
            if (b > dur) break; // a partially-played window is a lower rate, not a slower player
            const rate =
              ((interp(b, ts, nw) - interp(a, ts, nw)) / (b - a)) * 60;
            const rb = Math.min(
              RATE_BUCKETS - 1,
              Math.max(0, (rate / RATE_BUCKET) | 0),
            );
            cell.hist[RATE_OFFSET + w * RATE_BUCKETS + rb]++;
            cell.rateN[w]++;
          }
        }
      }
    }

    // Lane matchups: one observation per (lane, cross-team hero pair) at the 10-minute mark.
    if (dur >= LANE_MIN_DURATION) {
      const byLane = new Map();
      for (const p of m.players) {
        if (p.assigned_lane == null || !heroIdx.has(p.hero_id)) continue;
        let l = byLane.get(p.assigned_lane);
        if (!l) byLane.set(p.assigned_lane, (l = { Team0: [], Team1: [] }));
        (p.team === "Team0" ? l.Team0 : l.Team1).push(p);
      }
      for (const l of byLane.values()) {
        // Only a clean, symmetric lane. An uneven lane is a roam or a disconnect, and its
        // differential says nothing about the matchup that was drafted.
        if (l.Team0.length !== 2 || l.Team1.length !== 2) continue;
        const nwAt = (p) =>
          interp(
            LANE_TICK,
            [0, ...(p.nw_times_s ?? [])],
            [0, ...(p.nw_series ?? [])],
          );
        const a0 = l.Team0.map(nwAt);
        const b0 = l.Team1.map(nwAt);
        const diff = a0[0] + a0[1] - (b0[0] + b0[1]);
        // Normal-equation row: +1 per side-A hero, −1 per side-B hero. Mirrored (the row and its
        // negation are both valid observations) so the fit can't learn a side bias.
        const ia = l.Team0.map((p) => heroIdx.get(p.hero_id));
        const ib = l.Team1.map((p) => heroIdx.get(p.hero_id));
        for (const i of ia) {
          laneXty[i] += diff;
          for (const j of ia) laneXtX[i * NH + j] += 1;
          for (const j of ib) laneXtX[i * NH + j] -= 1;
        }
        for (const i of ib) {
          laneXty[i] -= diff;
          for (const j of ib) laneXtX[i * NH + j] += 1;
          for (const j of ia) laneXtX[i * NH + j] -= 1;
        }
        laneObs++;
        // Per-pair means. Each cross pair gets the LANE's differential, not a two-player slice of
        // it: souls in a 2v2 lane are a joint outcome, so attributing the whole differential to
        // each pairing and letting the additive fit remove the partner is the honest split.
        for (let x = 0; x < 2; x++)
          for (let y = 0; y < 2; y++) {
            const key = ia[x] * NH + ib[y];
            let pr = lanePairs.get(key);
            if (!pr) lanePairs.set(key, (pr = { n: 0, sum: 0 }));
            pr.n++;
            pr.sum += diff;
            const rev = ib[y] * NH + ia[x];
            let rp = lanePairs.get(rev);
            if (!rp) lanePairs.set(rev, (rp = { n: 0, sum: 0 }));
            rp.n++;
            rp.sum -= diff;
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

// --- Soul pace: histograms → percentile grids ---

/** The value at percentile `q` of a histogram slice, by cumulative count. Returns the bucket's
 * MIDPOINT, so a reading is never biased to the low edge of its bucket. */
function histPercentile(hist, offset, buckets, width, total, q) {
  const want = (q / 100) * total;
  let seen = 0;
  for (let b = 0; b < buckets; b++) {
    seen += hist[offset + b];
    if (seen >= want) return Math.round((b + 0.5) * width);
  }
  return Math.round((buckets - 0.5) * width);
}

const paceNorms = {};
let paceCellsEmitted = 0;
// Saturation watch: mass sitting in a histogram's LAST bucket is mass that was clipped, and a
// clipped percentile is indistinguishable from a real one downstream. Tallied so a shifting meta
// (longer games, richer late economy) reports the ceiling it outgrew instead of quietly flattening
// every high percentile onto it.
let clipped = 0;
let clippedOf = 0;
// Positional arrays against shared axes, not self-describing objects: the tick bounds, window
// bounds and field names are identical for every cell, so repeating them a few hundred times is
// pure transfer cost on a file every session fetches. A tick under PACE_MIN_N emits null in place
// rather than being dropped, so the arrays stay index-aligned with the shared `ticksS` axis.
for (const [key, cell] of paceCells) {
  const hero = Math.floor(key / 100);
  const tier = key % 100;
  const n = [];
  const lv = [];
  const won = [];
  const lost = [];
  let anyTick = false;
  for (let i = 0; i < PACE_TICKS.length; i++) {
    const cnt = cell.levelN[i];
    if (cnt < PACE_MIN_N) {
      n.push(0);
      lv.push(null);
      won.push(null);
      lost.push(null);
      continue;
    }
    anyTick = true;
    clipped += cell.hist[i * LEVEL_BUCKETS + (LEVEL_BUCKETS - 1)];
    clippedOf += cnt;
    n.push(cnt);
    lv.push(
      LEVEL_PCTS.map((q) =>
        histPercentile(
          cell.hist,
          i * LEVEL_BUCKETS,
          LEVEL_BUCKETS,
          LEVEL_BUCKET,
          cnt,
          q,
        ),
      ),
    );
    // Mean level among winners / losers at this tick — the pace gap, drawn over the band.
    won.push(cell.winN[i] ? Math.round(cell.winSum[i] / cell.winN[i]) : null);
    lost.push(
      cell.lossN[i] ? Math.round(cell.lossSum[i] / cell.lossN[i]) : null,
    );
  }
  const wn = [];
  const rt = [];
  let anyWindow = false;
  for (let w = 0; w < PACE_WINDOWS.length; w++) {
    const cnt = cell.rateN[w];
    if (cnt < PACE_MIN_N) {
      wn.push(0);
      rt.push(null);
      continue;
    }
    anyWindow = true;
    clipped += cell.hist[RATE_OFFSET + w * RATE_BUCKETS + (RATE_BUCKETS - 1)];
    clippedOf += cnt;
    wn.push(cnt);
    rt.push(
      RATE_PCTS.map((q) =>
        histPercentile(
          cell.hist,
          RATE_OFFSET + w * RATE_BUCKETS,
          RATE_BUCKETS,
          RATE_BUCKET,
          cnt,
          q,
        ),
      ),
    );
  }
  if (anyTick && anyWindow) {
    paceNorms[`${hero}:${tier}`] = { n, lv, won, lost, wn, rt };
    paceCellsEmitted++;
  }
}

// --- Lane matchups: solve the additive fit, then report pair residuals ---
//
// (X'X + λI)s = X'y by Gaussian elimination with partial pivoting. X'X is only heroes², and the
// ridge term also fixes the rank deficiency the design has by construction: adding a constant to
// every hero's strength leaves every differential unchanged, so the unpenalized system is singular.
function solveRidge(A, b, n, lambda) {
  const M = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) M[i * (n + 1) + j] = A[i * n + j];
    M[i * (n + 1) + i] += lambda * (A[i * n + i] || 1);
    M[i * (n + 1) + n] = b[i];
  }
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(M[r * (n + 1) + col]) > Math.abs(M[piv * (n + 1) + col]))
        piv = r;
    if (Math.abs(M[piv * (n + 1) + col]) < 1e-9) continue;
    if (piv !== col)
      for (let j = col; j <= n; j++) {
        const t = M[col * (n + 1) + j];
        M[col * (n + 1) + j] = M[piv * (n + 1) + j];
        M[piv * (n + 1) + j] = t;
      }
    const d = M[col * (n + 1) + col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r * (n + 1) + col] / d;
      if (!f) continue;
      for (let j = col; j <= n; j++)
        M[r * (n + 1) + j] -= f * M[col * (n + 1) + j];
    }
  }
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = M[i * (n + 1) + i];
    s[i] = Math.abs(d) < 1e-9 ? 0 : M[i * (n + 1) + n] / d;
  }
  return s;
}

const laneStrength = laneObs
  ? solveRidge(laneXtX, laneXty, NH, LANE_RIDGE)
  : new Float64Array(NH);
// Centre the strengths: only differences are identified, so an arbitrary offset would otherwise
// ride along and make the per-hero number unreadable.
const laneMean = laneStrength.reduce((s, v) => s + v, 0) / (NH || 1);
for (let i = 0; i < NH; i++) laneStrength[i] -= laneMean;

const laneMatchups = {};
let lanePairsEmitted = 0;
for (const [key, pr] of lanePairs) {
  if (pr.n < LANE_MIN_N) continue;
  const ai = Math.floor(key / NH);
  const bi = key % NH;
  const observed = pr.sum / pr.n;
  const predicted = laneStrength[ai] - laneStrength[bi];
  // Shrunk toward "the strengths already explain it" — a thin pair reports no rock-paper-scissors
  // rather than a loud one.
  const resid = (observed - predicted) * (pr.n / (pr.n + LANE_SHRINK_K));
  // [n, rawDiff, residual] — a tuple rather than a keyed object, for the same transfer reason the
  // pace cells are positional: this is ~1,200 pairs on a file fetched every session.
  (laneMatchups[heroIds[ai]] ??= {})[heroIds[bi]] = [
    pr.n,
    Math.round(observed),
    Math.round(resid),
  ];
  lanePairsEmitted++;
}
const laneStrengths = {};
for (let i = 0; i < NH; i++)
  laneStrengths[heroIds[i]] = Math.round(laneStrength[i]);

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
  // Soul pace. Axes are shared by every cell; `cells` is keyed "heroId:tier" like farmNorms, and
  // each cell's arrays are index-aligned with those axes (null = under the sample floor at that
  // index). See the accumulator block for the survivorship caveat the client has to carry.
  pace: {
    ticksS: PACE_TICKS,
    windowsS: PACE_WINDOWS,
    levelPcts: LEVEL_PCTS,
    ratePcts: RATE_PCTS,
    minN: PACE_MIN_N,
    cells: paceNorms,
  },
  // Lane matchups. `strengths` is the fitted additive per-hero lane strength (souls at the tick,
  // centred on 0); `matchups[a][b]` is the ordered pair a-vs-b as [n, rawDiff, residual], where the
  // residual is what survives removing both heroes' strengths — the actual matchup signal.
  lane: {
    tickS: LANE_TICK,
    obs: laneObs,
    minN: LANE_MIN_N,
    strengths: laneStrengths,
    matchups: laneMatchups,
  },
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
console.log(
  `pace norms: ${paceCellsEmitted} (hero,tier) cells emitted` +
    (clippedOf
      ? `, ${((clipped / clippedOf) * 100).toFixed(3)}% of observations in a top bucket`
      : ""),
);
if (clippedOf && clipped / clippedOf > 0.005)
  console.warn(
    `WARN: ${((clipped / clippedOf) * 100).toFixed(2)}% of pace observations clipped to a ceiling —\n` +
      `raise LEVEL_BUCKETS / RATE_BUCKETS, or every percentile above the clip is reporting the ceiling.`,
  );
console.log(
  `lane: ${laneObs} lane instances, ${lanePairsEmitted} hero pairs past n=${LANE_MIN_N}`,
);

// --- Rank-coverage guard ---
//
// The bake that motivated `tierOfPlayer` failed silently for days: upstream zeroed the badge, every
// row filed into a valid-looking tier 0, and the output stayed the right SHAPE the whole time. A
// fixture cannot catch that and neither can the schema, so the invariant is asserted here, where
// the numbers actually are. Loud and non-zero-exit: a bad bake must not overwrite a good one.
const rankedRows = [...tierCounts.values()].reduce((s, n) => s + n, 0);
const topTierShare = rankedRows
  ? Math.max(...tierCounts.values()) / rankedRows
  : 0;
console.log(
  `rank coverage: ${tierCounts.size} tiers populated, ${ranklessRows} rankless rows, ` +
    `largest tier holds ${(topTierShare * 100).toFixed(1)}%`,
);
if (rankedRows === 0 || tierCounts.size < 3 || topTierShare > 0.9) {
  console.error(
    `\nFATAL: rank signal looks broken — ${tierCounts.size} tier(s) populated, ` +
      `largest holds ${(topTierShare * 100).toFixed(1)}% of ${rankedRows} ranked rows.\n` +
      `This is what the 2026-07-31 average_badge outage looked like. Check that shards carry a\n` +
      `per-player average_badge (harvest-matches.mjs ROW_COLUMNS) before trusting any rank-keyed\n` +
      `cell in this file.`,
  );
  process.exit(1);
}
