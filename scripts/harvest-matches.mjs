// Nightly match-metadata harvester. Accumulates a rolling 30-day sample of per-match data
// (rosters, item purchases with buy/sell times, and a sampled net-worth trajectory per player)
// as gzipped NDJSON shards — the training set for the offline models on the stats roadmap
// (logistic item effects, causal adjustment, WPA). Run by .github/workflows/harvest.yml; also
// runs locally: node scripts/harvest-matches.mjs (env: HARVEST_DAY=YYYY-MM-DD, BINS, PER_BIN,
// OUT_DIR, RETENTION_DAYS).
//
// Design constraints, in order:
//  - The bulk metadata endpoint allows 10 req/min per IP — so few, large requests, spaced 7s.
//  - Taking one contiguous block of match ids would sample a single time-of-day slice; instead
//    the target day is split into BINS windows and each contributes up to PER_BIN matches, so
//    the sample spans EU/NA/Asia peaks.
//  - Records are trimmed before writing: the full payload is ~50KB/match, mostly fields no
//    planned model reads. Trimmed+gzipped is ~2-3KB/match, so a month's rolling window stays
//    in the tens of MB.

import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";

const API = "https://api.deadlock-api.com/v1/matches/metadata";

// The day being harvested (UTC). Default is yesterday: matches finish ingesting within hours,
// so by the nightly run the previous day is complete; today would be a biased partial sample.
// `||`, not `??`: a scheduled workflow run passes `${{ inputs.day }}` through as an EMPTY string,
// which must fall back the same as unset (empty BINS etc. would otherwise coerce to 0).
const day = process.env.HARVEST_DAY || isoDay(Date.now() - 24 * 3600 * 1000);
const BINS = Number(process.env.BINS || 12);
const PER_BIN = Number(process.env.PER_BIN || 100);
const OUT_DIR = process.env.OUT_DIR || "data/shards";
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// --- Fetch: one request per time bin, paced for the 10 req/min limit ---

async function fetchBin(fromUnix, toUnix) {
  const params = new URLSearchParams({
    min_unix_timestamp: String(fromUnix),
    max_unix_timestamp: String(toUnix),
    game_mode: "normal", // match_mode already defaults to ranked,unranked server-side
    include_player_info: "true",
    include_player_items: "true",
    // A sampled net-worth time series per player — the game-state signal WPA needs, at ~1.5KB
    // per match instead of the ~90KB full stats payload.
    extra_player_columns: "stats.net_worth,stats.time_stamp_s",
    limit: String(PER_BIN),
  });
  const res = await fetch(`${API}?${params}`);
  if (!res.ok)
    throw new Error(
      `HTTP ${res.status} for bin ${fromUnix}-${toUnix}: ${(await res.text()).slice(0, 200)}`,
    );
  return res.json();
}

// --- Trim: keep only what a model would read; gzip handles the repeated keys ---

function trimItem(it) {
  return {
    item_id: it.item_id,
    game_time_s: it.game_time_s,
    sold_time_s: it.sold_time_s,
    upgrade_id: it.upgrade_id,
    imbued_ability_id: it.imbued_ability_id,
    flags: it.flags,
    net_worth_at_buy: it.net_worth_at_buy,
  };
}

function trimPlayer(p) {
  return {
    account_id: p.account_id,
    hero_id: p.hero_id,
    team: p.team,
    player_slot: p.player_slot,
    assigned_lane: p.assigned_lane,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    denies: p.denies,
    last_hits: p.last_hits,
    net_worth: p.net_worth,
    ability_points: p.ability_points,
    player_level: p.player_level,
    abandon_match_time_s: p.abandon_match_time_s,
    hero_build_id: p.hero_build_id,
    items: (p.items ?? []).map(trimItem),
    nw_series: p.stats_net_worth,
    nw_times_s: p.stats_time_stamp_s,
  };
}

function trimMatch(m) {
  return {
    match_id: m.match_id,
    start_time: m.start_time,
    duration_s: m.duration_s,
    winning_team: m.winning_team,
    match_outcome: m.match_outcome,
    match_mode: m.match_mode,
    average_badge_team0: m.average_badge_team0,
    average_badge_team1: m.average_badge_team1,
    players: (m.players ?? []).map(trimPlayer),
  };
}

// --- Shard maintenance: rolling retention + a manifest regenerated from what's on disk ---

// Counts records by streaming the gunzip and tallying newline bytes. A shard decompresses to
// well over V8's ~512MB max string length, so it can never be read into a string to be split.
async function countRecords(path) {
  let n = 0;
  const gunzip = createGunzip();
  gunzip.on("data", (chunk) => {
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === 0x0a) n++;
  });
  await pipeline(createReadStream(path), gunzip);
  return n;
}

async function purgeAndManifest(dir) {
  const cutoff = isoDay(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000);
  const manifest = [];
  for (const f of readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.ndjson\.gz$/.test(f))
    .sort()) {
    const shardDay = f.slice(0, 10);
    const path = join(dir, f);
    if (shardDay < cutoff) {
      rmSync(path);
      console.log(`purged ${f} (older than ${RETENTION_DAYS}d)`);
      continue;
    }
    manifest.push({
      day: shardDay,
      matches: await countRecords(path),
      gz_bytes: statSync(path).size,
    });
  }
  writeFileSync(
    join(dir, "..", "manifest.json"),
    JSON.stringify(manifest, null, 1) + "\n",
  );
  return manifest;
}

// --- Main ---

const dayStart = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
if (!Number.isFinite(dayStart)) throw new Error(`Bad HARVEST_DAY: ${day}`);
mkdirSync(OUT_DIR, { recursive: true });

const shardPath = join(OUT_DIR, `${day}.ndjson.gz`);
if (existsSync(shardPath) && !process.env.FORCE) {
  console.log(
    `${shardPath} already exists — skipping fetch (set FORCE=1 to re-harvest)`,
  );
} else {
  // Each bin is gzipped into the shard as it arrives, rather than accumulating every trimmed
  // match and serializing once at the end: a full-density day is several hundred MB of JSON,
  // past V8's ~512MB max string length, so the join()-then-gzip form throws RangeError. Only
  // match ids are held across bins (for de-duplication), and the shard is written to a temp
  // file first so an aborted run can't leave a truncated day looking complete.
  const binSeconds = Math.floor((24 * 3600) / BINS);
  const tmpPath = `${shardPath}.tmp`;
  const gzip = createGzip({ level: 9 });
  const flushed = pipeline(gzip, createWriteStream(tmpPath));
  const seen = new Set();
  try {
    for (let i = 0; i < BINS; i++) {
      const from = dayStart + i * binSeconds;
      const to = i === BINS - 1 ? dayStart + 24 * 3600 : from + binSeconds;
      const matches = await fetchBin(from, to);
      let chunk = "";
      for (const m of matches) {
        if (seen.has(m.match_id)) continue;
        seen.add(m.match_id);
        chunk += JSON.stringify(trimMatch(m)) + "\n";
      }
      if (chunk && !gzip.write(chunk)) await once(gzip, "drain");
      console.log(
        `bin ${i + 1}/${BINS}: ${matches.length} matches (running total ${seen.size})`,
      );
      if (i < BINS - 1) await new Promise((r) => setTimeout(r, 7000));
    }
    gzip.end();
    await flushed;
  } catch (e) {
    gzip.destroy();
    rmSync(tmpPath, { force: true });
    throw e;
  }
  renameSync(tmpPath, shardPath);
  console.log(
    `wrote ${shardPath}: ${seen.size} matches, ${statSync(shardPath).size} bytes gz`,
  );
}

const manifest = await purgeAndManifest(OUT_DIR);
const total = manifest.reduce((s, e) => s + e.matches, 0);
console.log(`window now holds ${manifest.length} shards, ${total} matches`);
