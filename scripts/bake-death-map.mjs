// Bakes death-map.json: where players die on the map, as a coarse density grid per game phase,
// plus the MAP REFERENCE FRAME the map is read against.
//
// This is the population layer the post-game death map is read against — "here is where deaths
// happen at your rank; here are yours". Without it a scatter of fourteen dots is unreadable, because
// nothing says whether a cluster is a mistake or simply where the game is played.
//
// WHY NOT A MAP IMAGE: the app ships no Valve art, and CSP is first-party only. It doesn't need
// either. Aggregate death density traces the map's own structure well enough to orient by, and the
// LANDMARKS — cores, guardians, walkers — can be located in world coordinates from the same data
// (see the frame query below). So the reference is derived and checkable rather than drawn and
// trusted, and every name on the finished map is one the API itself uses.
//
// TWO FRAME FACTS, both measured here and both load-bearing downstream:
//
//  1. Team0's base is at NEGATIVE y, Team1's at positive. Verified three independent ways: laning
//     deaths fall on the dier's own side of the midline; the last fight of a game happens in the
//     LOSER's base; and `match_paths` puts each team's spawn at y ≈ ∓10100 at t=0.
//  2. The map is symmetric under a 180° ROTATION about the origin, not a mirror. Measured: every
//     Team1 structure lands within ~50 world units of the negation of its Team0 counterpart. That is
//     why the client can store ONE set of landmarks and negate it for the enemy's, and why a Team1
//     player's whole game can be rotated into a single "your base at the bottom" display frame.
//
// The grids are baked in that TEAM-RELATIVE frame (Team1's deaths rotated 180°), so a cell means
// "deaths this far into the enemy half" rather than "deaths at this absolute spot" — the pooled
// absolute version smears the two halves together and throws away the only axis a player can act on.
//
// WHY ITS OWN SCRIPT AND ASSET: bake-wp-stats.mjs reads harvested shards, and death positions are
// not in them (`death_details` was never added to ROW_COLUMNS, and adding it would grow every shard
// for a number only this feature reads). Both of these are AGGREGATES, so /v1/sql computes them
// directly — no per-match storage, fresh nightly, and it lands in a separate file the client fetches
// lazily when the Match view opens rather than on every page load.
//
// Runs in the harvest workflow after the shard lands; locally: node scripts/bake-death-map.mjs
// (env: OUT, DAYS, GRID, HALF_EXTENT, FRAME_HOURS).
//
// /v1/sql is 2 req/min and 20 req/hour per IP. This spends exactly TWO, spaced. Never put it in a
// loop: a retry loop here once burned 41 requests against a 20/hour budget, and because every
// rejected attempt still consumes a token, polling actively prevents recovery.

import { writeFileSync } from "node:fs";

const SQL_API = "https://api.deadlock-api.com/v1/sql";
const OUT = process.env.OUT || "_data/death-map.json";
/** Days of ranked play to aggregate. Deaths are dense (~60 per match), so a few days is already
 * millions of points — this is about tracking map changes, not about sample size. */
const DAYS = Number(process.env.DAYS || 3);
/** Grid resolution per side. 64 is about the point where the map's lanes read clearly and a single
 * game's dozen deaths still land in distinguishable cells. */
const GRID = Number(process.env.GRID || 64);
/**
 * Half-width of the square world box the grid covers, in world units.
 *
 * Square on purpose even though the playable area is taller than it is wide (measured 2026-08-03
 * over 3h of ranked deaths: x ∈ [−9445, 9284], y ∈ [−10725, 10890]). A square box with one scale on
 * both axes keeps the map's true aspect ratio, at the cost of some empty margin left and right;
 * fitting each axis independently would stretch the map and quietly lie about distances.
 */
const HALF_EXTENT = Number(process.env.HALF_EXTENT || 11520);
/** Window for the frame query. The landmarks are fixed geometry, so this only needs enough deaths
 * to resolve a mode — hours, not days, and a short window keeps the query cheap. */
const FRAME_HOURS = Number(process.env.FRAME_HOURS || 6);

/** Phase columns, mirroring src/lib/phases.ts (600s × 4). scripts/ shares no code with src/, so
 * this is a literal — the same arrangement as RANKED_MODE_FROM_S in the harvester. */
const PHASE_S = 600;
const PHASE_LABELS = ["Lane", "Early mid", "Mid", "Late"];

const CELL = (2 * HALF_EXTENT) / GRID;

/**
 * One query, with ONE retry and only against the per-MINUTE limit.
 *
 * This is deliberately not a retry loop. The harvest step ahead of this one spends its own two
 * /v1/sql requests, so the first query here can land inside the same minute and take a 429 that a
 * single wait clears — the API reports exactly how long in `next_request_in`. A 429 against the
 * HOURLY quota is not retried at all: the wait would be tens of minutes, and every rejected attempt
 * still consumes a token, so polling an exhausted hourly budget actively prevents recovery. That is
 * not hypothetical; it is how 41 requests once went against a 20/hour limit. Failing here is cheap
 * — the workflow step continues on error and yesterday's asset carries forward.
 */
async function sql(query, what, retried = false) {
  const url = `${SQL_API}?query=${encodeURIComponent(query.replace(/\s+/g, " "))}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 429 && !retried) {
      const err = (() => {
        try {
          return JSON.parse(body).error;
        } catch {
          return null;
        }
      })();
      const waitS = err?.next_request_in;
      if (err?.quota?.period <= 60 && waitS != null && waitS <= 90) {
        console.warn(
          `  ${what}: per-minute limit hit, waiting ${waitS}s for the one retry`,
        );
        await new Promise((r) => setTimeout(r, (waitS + 2) * 1000));
        return sql(query, what, true);
      }
    }
    throw new Error(
      `HTTP ${res.status} from /v1/sql (${what}): ${body.slice(0, 200)}`,
    );
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error(`${what} query returned no rows — refusing to write`);
  return rows;
}

// ---------------------------------------------------------------------------
// 0. The map's skeleton, from the assets API.
//
// /v1/assets/map ships the three zipline routes as WORLD COORDINATES, which is the one piece of
// real map geometry available without shipping any art. Drawn as hairlines in our own ink it gives
// the map its recognizable silhouette — the thing a density field alone can't provide — while
// staying a themed vector rather than a screenshot pasted into a technical document.
//
// The coordinate system was verified against Valve's own minimap render rather than assumed: all
// 128 zipline points land within 4px of their own colour in minimap.png under the plain top-down
// transform, so world coordinates and that image agree exactly. (The asset's `objective_positions`
// do NOT — they are rounded icon-placement hints, off by up to ~1400 world units, which is why the
// structure anchors are still measured in step 1 rather than read from there.)
//
// Not on the /v1/sql budget: a plain asset GET.
// ---------------------------------------------------------------------------

const MAP_ASSET = "https://api.deadlock-api.com/v1/assets/map";

/** Baked rather than fetched at runtime: static geometry, and it saves the client a request. */
async function ziplines() {
  const res = await fetch(MAP_ASSET);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${MAP_ASSET}`);
  const map = await res.json();
  const paths = (map.zipline_paths ?? []).map((z) => {
    const [ox, oy] = z.origin;
    // P0 is the route itself; P1/P2 are ~520-unit end decorations and would draw as stubs.
    return z.P0_points.map((p) => [
      Math.round(ox + p[0]),
      Math.round(oy + p[1]),
    ]);
  });
  if (paths.length === 0 || paths.some((p) => p.length < 8))
    throw new Error("map asset returned no usable zipline paths");
  return { paths, radius: map.radius ?? null };
}

const zip = await ziplines();

// ---------------------------------------------------------------------------
// 1. The frame: where the map's fixed structures actually are.
//
// A death is attributed to an objective when it happens within ±10s of that objective being
// destroyed, and only deaths of the objective's OWNER count — defenders die at the thing they are
// defending. That window still catches deaths happening elsewhere on the map at the same moment, so
// the anchor is a 2-D MODE rather than a mean: unrelated deaths are spread thin over the whole map
// while the fight for a structure piles into a few cells. Taking a median instead drags every
// landmark ~1500 units toward the origin, which is enough to put a guardian in the wrong place.
// ---------------------------------------------------------------------------

const FRAME_CELL = 512;
const FRAME_OFFSET = 12288;

const FRAME_SQL = `
SELECT obj, owner, gx, gy, count() AS n FROM (
 SELECT toString(objs[oi]) AS obj, toString(owners[oi]) AS owner,
  intDiv(toInt32(dx) + ${FRAME_OFFSET}, ${FRAME_CELL}) AS gx,
  intDiv(toInt32(dy) + ${FRAME_OFFSET}, ${FRAME_CELL}) AS gy
 FROM (
  SELECT dx, dy, objs, owners, tm,
   arrayFirstIndex(d -> abs(toInt32(d) - toInt32(gt)) <= 10, dts) AS oi
  FROM (
   SELECT team AS tm,
    objectives.team_objective AS objs, objectives.team AS owners,
    objectives.destroyed_time_s AS dts,
    death_details.game_time_s AS gts,
    arrayMap(t -> t.1, death_details.death_pos) AS dxs,
    arrayMap(t -> t.2, death_details.death_pos) AS dys
   FROM match_player
   WHERE start_time > now() - INTERVAL ${FRAME_HOURS} HOUR AND match_mode = 'Ranked'
  ) ARRAY JOIN gts AS gt, dxs AS dx, dys AS dy
  WHERE dx != 0 OR dy != 0
 )
 WHERE oi > 0 AND tm = owners[oi]
)
WHERE startsWith(obj, 'Tier') OR obj = 'Core'
GROUP BY obj, owner, gx, gy
HAVING n >= 4
`;

/** Cell index → the world coordinate of its centre. */
const frameWorld = (g) => FRAME_CELL * g + FRAME_CELL / 2 - FRAME_OFFSET;

/** Mode cell, then the count-weighted centroid of the 3×3 around it: the mode alone is quantized to
 * 512 units, and the neighbourhood sharpens it without letting the spread-out unrelated deaths back
 * in the way a global centroid would. */
function anchor(rows) {
  const top = rows.reduce((a, b) => (b.n > a.n ? b : a));
  const near = rows.filter(
    (r) => Math.abs(r.gx - top.gx) <= 1 && Math.abs(r.gy - top.gy) <= 1,
  );
  const tot = near.reduce((s, r) => s + r.n, 0);
  return {
    x: Math.round(near.reduce((s, r) => s + frameWorld(r.gx) * r.n, 0) / tot),
    y: Math.round(near.reduce((s, r) => s + frameWorld(r.gy) * r.n, 0) / tot),
    n: tot,
    peak: top.n,
  };
}

const frameRows = await sql(FRAME_SQL, "frame");
const byObj = new Map();
for (const r of frameRows) {
  const key = `${r.obj}|${r.owner}`;
  if (!byObj.has(key)) byObj.set(key, []);
  byObj.get(key).push(r);
}

const anchors = new Map();
for (const [key, rows] of byObj) anchors.set(key, anchor(rows));

/**
 * Fold two measurements of the same structure into one anchor, in the frame where the viewer's own
 * base is at negative y.
 *
 * Team0 is already in that frame; Team1's is rotated 180° onto it. Averaging is not just tidiness —
 * it doubles the sample behind every anchor and, more usefully, the disagreement between the two is
 * a free accuracy check on the whole method, which is what `spread` reports.
 */
function fold(a, b, dist) {
  return {
    x: Math.round((a.x - b.x) / 2),
    y: Math.round((a.y - b.y) / 2),
    n: a.n + b.n,
    spread: Math.round(dist),
  };
}

/**
 * Pair each of Team0's structures with its Team1 counterpart BY GEOMETRY — the Team1 anchor whose
 * 180° rotation lands nearest — rather than by matching lane numbers.
 *
 * Matching by name is the obvious thing and it is wrong: the enum's lane numbering is absolute in x
 * (both teams' 'Lane1' sits at negative x), so Team0's Lane1 and Team1's Lane1 are the two ends of
 * the SAME corridor, not reflections of each other. Team0's Lane1 pairs with Team1's Lane4. Pairing
 * on position derives that instead of assuming it, and keeps working if the numbering ever changes.
 * The symmetry guard below is what proves the pairing was right.
 */
function foldLanes(prefix, lanes) {
  const own = lanes
    .map((lane) => ({ lane, a: anchors.get(`${prefix}Lane${lane}|Team0`) }))
    .filter((e) => e.a);
  const other = lanes
    .map((lane) => anchors.get(`${prefix}Lane${lane}|Team1`))
    .filter(Boolean);
  return own.map(({ lane, a }) => {
    let best = null;
    let bestD = Infinity;
    for (const b of other) {
      const d = Math.hypot(a.x + b.x, a.y + b.y);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return { lane, ...fold(a, best, bestD) };
  });
}

// 'Tier1Lane1'/'3'/'4' is the objective enum's own numbering. It does NOT agree with
// `assigned_lane`, which numbers the same three corridors 1/4/6; both are legacy artifacts of a
// wider map. Neither number is ever shown to a player: the client says left/mid/right, which is
// unambiguous once the map is oriented to them.
const LANES = [1, 3, 4];
const c0 = anchors.get("Core|Team0");
const c1 = anchors.get("Core|Team1");
const core =
  c0 && c1 ? fold(c0, c1, Math.hypot(c0.x + c1.x, c0.y + c1.y)) : null;
const tier1 = foldLanes("Tier1", LANES);
const tier2 = foldLanes("Tier2", LANES);

if (!core || tier1.length !== 3 || tier2.length !== 3)
  throw new Error(
    `frame is incomplete: core=${!!core} tier1=${tier1.length} tier2=${tier2.length} — refusing to publish a map with missing landmarks`,
  );
// The rotational symmetry is the method's own error bar. A structure whose two independent
// measurements disagree by more than a grid cell means the mode found a crowd, not a landmark.
const worstSpread = Math.max(
  ...[core, ...tier1, ...tier2].map((a) => a.spread),
);
if (worstSpread > CELL * 3)
  throw new Error(
    `frame failed its symmetry check: worst Team0/Team1 disagreement ${worstSpread} world units (> ${CELL * 3}) — the map geometry may have changed, or the mode is landing on a crowd`,
  );
// Every landmark must be on the viewer's own side, or the fold has the sign backwards and the whole
// display frame would be upside down.
if (core.y > 0 || tier1.some((t) => t.y > 0) || tier2.some((t) => t.y > 0))
  throw new Error(
    "frame has a landmark on the wrong side of the midline — Team0 is expected to be at negative y",
  );

// Two seconds under the 2-req/min ceiling is not enough margin for a shared CI runner IP; this is
// the one place in the whole pipeline that spends a second /v1/sql request, so it waits properly.
await new Promise((r) => setTimeout(r, 35_000));

// ---------------------------------------------------------------------------
// 2. The density grids, in the team-relative frame.
// ---------------------------------------------------------------------------

// Split by OUTCOME as well as phase. A winning team dies deep because it is pushing, so "you died
// further into their half than most" is, uncontrolled, largely a restatement of "you won" — the
// client compares a player only against deaths from games that ended the same way theirs did.
const GRID_SQL = `
SELECT
  least(intDiv(toUInt32(gt), ${PHASE_S}), ${PHASE_LABELS.length - 1}) AS ph,
  won,
  intDiv(toInt32(sg * dx) + ${HALF_EXTENT}, ${CELL}) AS gx,
  intDiv(toInt32(sg * dy) + ${HALF_EXTENT}, ${CELL}) AS gy,
  count() AS n
FROM (
  SELECT if(team = 'Team1', -1, 1) AS sg, winning_team = team AS won,
    death_details.game_time_s AS gts,
    arrayMap(t -> t.1, death_details.death_pos) AS dxs,
    arrayMap(t -> t.2, death_details.death_pos) AS dys
  FROM match_player
  WHERE start_time > now() - INTERVAL ${DAYS} DAY
    AND match_mode = 'Ranked'
) ARRAY JOIN gts AS gt, dxs AS dx, dys AS dy
WHERE gt > 0
  AND abs(dx) < ${HALF_EXTENT} AND abs(dy) < ${HALF_EXTENT}
GROUP BY ph, won, gx, gy
HAVING n > 2
`;

const rows = await sql(GRID_SQL, "density");

// Per-phase grids of raw counts. The drawn underlay pools both outcomes — it answers "where is the
// game played", which is not an outcome question — while the depth marginal keeps them apart.
const grids = PHASE_LABELS.map(() => new Float64Array(GRID * GRID));
const totals = PHASE_LABELS.map(() => 0);
/** y-marginal per (phase, outcome), in grid rows — the depth distribution, free from the same
 * counts the grid is built from. */
const depthRows = PHASE_LABELS.map(() => ({
  won: new Float64Array(GRID),
  lost: new Float64Array(GRID),
}));
let dropped = 0;
for (const r of rows) {
  const { ph, gx, gy, n } = r;
  if (
    gx < 0 ||
    gx >= GRID ||
    gy < 0 ||
    gy >= GRID ||
    ph < 0 ||
    ph >= grids.length
  ) {
    dropped += n;
    continue;
  }
  // ROW ORDER IS SCREEN ORDER, NOT WORLD ORDER: row 0 is the HIGHEST world y, because the client
  // draws cell i at `y = floor(i / size)`, i.e. top-down. `gy` counts up with world y, so it is
  // flipped here rather than in the client — the asset should be drawable as-is, and the deaths
  // drawn over it are already flipped the same way (lib/deathMap.worldToUnit). Getting this wrong
  // mirrors the field against the dots, which on a roughly symmetric map looks entirely plausible.
  grids[ph][(GRID - 1 - gy) * GRID + gx] += n;
  depthRows[ph][r.won ? "won" : "lost"][gy] += n;
  totals[ph] += n;
}

/**
 * Quantize a grid to one byte per cell.
 *
 * The ramp is a square root of the share of the phase's PEAK cell, not of the raw count: death
 * density spans orders of magnitude between a lane choke and open jungle, so a linear byte would
 * render everything except the two or three hottest cells as zero. Square root compresses that tail
 * without the "everything is visible" mush a log ramp produces.
 */
function quantize(grid) {
  const peak = Math.max(...grid, 1);
  const bytes = Buffer.alloc(grid.length);
  for (let i = 0; i < grid.length; i++)
    bytes[i] = Math.round(255 * Math.sqrt(grid[i] / peak));
  return { b64: bytes.toString("base64"), peak };
}

/**
 * The depth distribution for one (phase, outcome), from the row marginal.
 *
 * `enemyHalf` is the share of deaths past the midline, and it is the number the client actually
 * reads: a share is legible where a quantile of world units is not. The quantiles come along
 * because they cost nothing and they are what makes "deep" concrete when a number has to be shown.
 * Resolution is one grid row — 360 world units, far finer than the thing being measured.
 */
const DEPTH_PCTS = [10, 25, 50, 75, 90];
function depthStats(marg) {
  const total = marg.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const rowY = (gy) => gy * CELL + CELL / 2 - HALF_EXTENT;
  const q = {};
  let seen = 0;
  let at = 0;
  let past = 0;
  for (let gy = 0; gy < GRID; gy++) {
    seen += marg[gy];
    if (rowY(gy) > 0) past += marg[gy];
    while (at < DEPTH_PCTS.length && seen >= (DEPTH_PCTS[at] / 100) * total) {
      q[`p${DEPTH_PCTS[at]}`] = Math.round(rowY(gy));
      at++;
    }
  }
  return { n: total, enemyHalf: Number((past / total).toFixed(4)), q };
}

const phases = PHASE_LABELS.map((label, i) => {
  const { b64, peak } = quantize(grids[i]);
  return {
    label,
    fromS: i * PHASE_S,
    toS: i === PHASE_LABELS.length - 1 ? null : (i + 1) * PHASE_S,
    n: totals[i],
    peak,
    /** Split by outcome so a player is compared against games that ended like theirs. */
    depth: {
      won: depthStats(depthRows[i].won),
      lost: depthStats(depthRows[i].lost),
    },
    grid: b64,
  };
});

const out = {
  generatedAt: new Date().toISOString(),
  days: DAYS,
  size: GRID,
  /** World box the grid covers; a point maps to a cell by ((v + halfExtent) / cell) | 0. */
  halfExtent: HALF_EXTENT,
  cell: CELL,
  /** Landmarks in the viewer's own frame — own base at negative y. The enemy's are the negation of
   * these (the map is 180°-rotation symmetric; see the header). */
  frame: { core, tier1, tier2 },
  /**
   * The three zipline routes in world coordinates, from the assets API — the map's silhouette.
   *
   * Frame-agnostic: the set maps onto itself under the same 180° rotation (the left route becomes
   * the right one), so one drawing serves both teams and no rotation is applied. `radius` is the
   * game's own map radius, kept as documentation — the grid box is deliberately wider (HALF_EXTENT)
   * so the routes, which run to ±11520, are not clipped at their ends.
   */
  ziplines: zip.paths,
  mapRadius: zip.radius,
  phases,
};
writeFileSync(OUT, JSON.stringify(out) + "\n");

const total = totals.reduce((a, b) => a + b, 0);
console.log(
  `wrote ${OUT}: ${total.toLocaleString()} deaths over ${DAYS}d, ${GRID}×${GRID} grid` +
    (dropped ? `, ${dropped.toLocaleString()} out of bounds` : ""),
);
for (const p of phases)
  console.log(
    `  ${p.label.padEnd(10)} ${p.n.toLocaleString().padStart(9)} deaths, peak cell ${p.peak}` +
      (p.depth.won && p.depth.lost
        ? `, in enemy half ${(p.depth.won.enemyHalf * 100).toFixed(0)}% won / ${(p.depth.lost.enemyHalf * 100).toFixed(0)}% lost`
        : ""),
  );
console.log(
  `  frame: core (${core.x}, ${core.y}) · symmetry check worst ${worstSpread} world units`,
);
for (const t of tier1)
  console.log(`    tier1 lane${t.lane} (${t.x}, ${t.y})  ±${t.spread}`);
for (const t of tier2)
  console.log(`    tier2 lane${t.lane} (${t.x}, ${t.y})  ±${t.spread}`);
// A phase with no deaths is a broken bake, not a quiet meta shift: every phase of every game has
// deaths in it.
if (phases.some((p) => p.n === 0))
  throw new Error(
    "a phase came back empty — refusing to publish a partial map",
  );
