// Nightly match-metadata harvester. Accumulates a rolling 30-day sample of per-match data
// (rosters, item purchases with buy/sell times, and a sampled net-worth trajectory per player)
// as gzipped NDJSON shards — the training set for the offline models on the stats roadmap
// (logistic item effects, causal adjustment, WPA). Run by .github/workflows/harvest.yml; also
// runs locally: node scripts/harvest-matches.mjs (env: HARVEST_DAY=YYYY-MM-DD, BINS, PER_BIN,
// OUT_DIR, RETENTION_DAYS, FETCH_RETRIES).
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
const MATCH_API = "https://api.deadlock-api.com/v1/matches";

// The day being harvested (UTC). Default is yesterday: matches finish ingesting within hours,
// so by the nightly run the previous day is complete; today would be a biased partial sample.
// `||`, not `??`: a scheduled workflow run passes `${{ inputs.day }}` through as an EMPTY string,
// which must fall back the same as unset (empty BINS etc. would otherwise coerce to 0).
const day = process.env.HARVEST_DAY || isoDay(Date.now() - 24 * 3600 * 1000);
const BINS = Number(process.env.BINS || 12);
const PER_BIN = Number(process.env.PER_BIN || 100);
// How many matches per bin to additionally fetch per-source gold for (the soul-economy norms). The
// bulk endpoint can't return `gold_sources` (breakables/boxes live only there), so these come from a
// subsample of single-match calls — cached (disable_steam), ~300ms each. A subsample, not all
// PER_BIN: a median gold-per-source per (hero, rank) needs a few hundred games per cell, which
// ~120/bin × 12 bins × 30-day window supplies many times over. 0 disables the pass.
const GOLD_PER_BIN = Number(process.env.GOLD_PER_BIN || 120);
const OUT_DIR = process.env.OUT_DIR || "data/shards";
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);
// Retry budget for a single request. The nightly run lives across the internet from a CDN, so a
// mid-body socket reset (UND_ERR_SOCKET) or a transient 5xx will happen eventually; losing a whole
// day's sample to one dropped connection isn't worth it. Bounded so a genuine outage still fails.
const FETCH_RETRIES = Number(process.env.FETCH_RETRIES || 4);

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Fetch: one request per time bin, paced for the 10 req/min limit ---

// Server-side statuses worth a retry: rate limiting and the transient 5xx family. A 4xx other
// than 429 is deterministic (bad params, gone) — retrying can't fix it, so those throw at once.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Fetch and parse JSON with bounded retries on transient failures. A thrown fetch()/res.json()
 * error is always network-layer (socket reset, connect/DNS, timeout, truncated body) and carries
 * no `.status`, so it's retried; our own HTTP errors carry `.status` and retry only when the
 * status is in RETRYABLE_STATUS. Backoff is linear (6s × attempt, capped 30s) — comfortably above
 * the bulk endpoint's 6s/request floor, and a failed request may already have cost a rate token.
 */
async function fetchJson(url, { label = url, retries = FETCH_RETRIES } = {}) {
  const maxAttempts = retries + 1;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        const err = new Error(`HTTP ${res.status} for ${label}: ${body}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (e) {
      const retryable = e.status === undefined || RETRYABLE_STATUS.has(e.status);
      if (!retryable || attempt >= maxAttempts) throw e;
      const wait = Math.min(30000, 6000 * attempt);
      const why = e.status ? `HTTP ${e.status}` : e.code || e.cause?.code || e.name;
      console.warn(
        `${label}: ${why} — retry ${attempt}/${retries} in ${wait / 1000}s`,
      );
      await sleep(wait);
    }
  }
}

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
  return fetchJson(`${API}?${params}`, { label: `bin ${fromUnix}-${toUnix}` });
}

// --- Per-source gold (soul economy): a subsample of single-match fetches ---
//
// EGoldSource ids we keep (verified against the flat gold_* fields): 1 kills, 2 lane creeps,
// 3 neutral camps, 4 bosses, 5 treasure/urn, 6 assists, 7 denies, 12 breakables. `gold_orbs` is
// folded into `gold` so the total matches what the client's economy view reads.
const SRC_KEEP = [1, 2, 3, 4, 5, 6, 7, 12];

/** Final per-source gold for one single-match player, or null when the sample has no ledger. */
function goldFromPlayer(p) {
  const last = p.stats?.[p.stats.length - 1];
  if (!last?.gold_sources) return null;
  const g = {};
  for (const gs of last.gold_sources) {
    if (SRC_KEEP.includes(gs.source))
      g[gs.source] = (gs.gold ?? 0) + (gs.gold_orbs ?? 0);
  }
  return g;
}

/**
 * Fetch `gold_sources` for a list of match ids via the cached single-match endpoint (a different,
 * looser rate family than the bulk metadata call). Returns match_id → (player_slot → {src:gold}).
 * Fails soft per match — a miss just means that match contributes no economy sample.
 */
async function fetchGoldSources(ids, concurrency = 8) {
  const out = new Map();
  let idx = 0;
  async function worker() {
    while (idx < ids.length) {
      const id = ids[idx++];
      try {
        // One retry only: this is a best-effort subsample on the looser single-match rate family,
        // and a broad outage shouldn't stall the run behind hundreds of backing-off gold fetches.
        const mi = (
          await fetchJson(`${MATCH_API}/${id}/metadata?disable_steam=true`, {
            label: `gold ${id}`,
            retries: 1,
          })
        ).match_info;
        const bySlot = {};
        for (const p of mi?.players ?? []) {
          const g = goldFromPlayer(p);
          if (g) bySlot[p.player_slot] = g;
        }
        out.set(id, bySlot);
      } catch {
        /* skip this match's economy sample */
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, ids.length) }, worker),
  );
  return out;
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

function trimPlayer(p, gsrc) {
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
    // Per-source gold, present only on the economy subsample (see fetchGoldSources). Absent ⇒ this
    // player's match wasn't sampled for economy; the bake simply skips it.
    ...(gsrc ? { gold_src: gsrc } : {}),
  };
}

function trimMatch(m, goldBySlot) {
  return {
    match_id: m.match_id,
    start_time: m.start_time,
    duration_s: m.duration_s,
    winning_team: m.winning_team,
    match_outcome: m.match_outcome,
    match_mode: m.match_mode,
    average_badge_team0: m.average_badge_team0,
    average_badge_team1: m.average_badge_team1,
    players: (m.players ?? []).map((p) =>
      trimPlayer(p, goldBySlot?.[p.player_slot]),
    ),
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
  let failedBins = 0;
  try {
    for (let i = 0; i < BINS; i++) {
      const from = dayStart + i * binSeconds;
      const to = i === BINS - 1 ? dayStart + 24 * 3600 : from + binSeconds;
      // A bin that still fails after fetchBin's retries is skipped, not fatal: 11/12 bins is a fine
      // day, losing one time-of-day slice is a small bias next to losing the whole sample. The
      // sparsity guard after the loop aborts only if too little came back to trust.
      let matches;
      try {
        matches = await fetchBin(from, to);
      } catch (e) {
        failedBins++;
        console.warn(`bin ${i + 1}/${BINS} failed, skipping: ${e.message}`);
        if (i < BINS - 1) await sleep(7000);
        continue;
      }
      const fresh = matches.filter((m) => !seen.has(m.match_id));
      // Economy subsample: fetch per-source gold for the first GOLD_PER_BIN fresh matches (order is
      // arbitrary within a time bin, so first-N is an unbiased sample). One extra request each, on
      // the looser single-match rate family — spaced out by the 7s inter-bin sleep below.
      const goldIds = fresh.slice(0, GOLD_PER_BIN).map((m) => m.match_id);
      const gold = goldIds.length ? await fetchGoldSources(goldIds) : new Map();
      let chunk = "";
      for (const m of fresh) {
        seen.add(m.match_id);
        chunk += JSON.stringify(trimMatch(m, gold.get(m.match_id))) + "\n";
      }
      if (chunk && !gzip.write(chunk)) await once(gzip, "drain");
      console.log(
        `bin ${i + 1}/${BINS}: ${matches.length} matches, ${gold.size} with economy (running total ${seen.size})`,
      );
      if (i < BINS - 1) await sleep(7000);
    }
    // Discard a day that came back too thin to trust rather than write a biased partial shard that
    // `existsSync` would then treat as a complete day and refuse to re-harvest. A failed run here
    // surfaces in the workflow; the tmp shard is cleaned up by the catch below.
    if (failedBins > BINS / 2)
      throw new Error(
        `harvest too sparse: ${failedBins}/${BINS} bins failed (${seen.size} matches)`,
      );
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
