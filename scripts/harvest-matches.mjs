// Nightly match-metadata harvester. Accumulates a rolling 30-day sample of per-match data
// (rosters, item purchases with buy/sell times, and a sampled net-worth trajectory per player)
// as gzipped NDJSON shards — the training set for the offline models on the stats roadmap
// (logistic item effects, causal adjustment, WPA). Run by .github/workflows/harvest.yml; also
// runs locally: node scripts/harvest-matches.mjs (env: HARVEST_DAY=YYYY-MM-DD, MATCHES_PER_DAY,
// GOLD_SAMPLE, OUT_DIR, RETENTION_DAYS, FETCH_RETRIES).
//
// The roster/items/net-worth half comes from ONE /v1/sql query against the same ClickHouse the
// analytics endpoints aggregate. It replaced twelve bulk-metadata requests paced 7s apart for the
// 10 req/min limit, which is the only reason the old time-bin scheme existed: a contiguous block of
// match ids would have sampled a single time-of-day slice, so the day was cut into bins that each
// contributed up to PER_BIN matches. SQL samples the whole day in one pass instead —
// `ORDER BY cityHash64(match_id) LIMIT n` is a deterministic uniform draw over the day's matches,
// and it keeps a match's twelve player rows together.
//
// One deliberate change of sample composition came with that: equal-per-bin allocation gave the
// quiet hours (06:00–15:00 UTC, roughly a tenth of peak volume) the same weight as the peaks, which
// over-represents them. A hash draw is proportional to real volume, i.e. an unbiased sample of the
// population the models are meant to describe.
//
// Design constraints, in order:
//  - /v1/sql allows 2 req/min and 20 req/hour per IP. Two per run: the sampled ids, then the rows.
//    Never put it in a loop, and back off in tens of seconds, not seconds.
//  - `gold_sources` (per-source souls; breakables live ONLY there) is NOT in the SQL table and NOT
//    on the bulk endpoint — the flat gold_* columns cover sources 1-7 only. Recovering breakables
//    as a residual was measured and fails badly (the residual is 44% ± 36pt breakables, mostly team
//    bonus), so the per-source pass stays on single-match calls. See the GOLD_SAMPLE note below.
//  - Records are trimmed before writing: the full payload is ~50KB/match, mostly fields no
//    planned model reads. Trimmed+gzipped is ~2-3KB/match, so a month's rolling window stays
//    in the tens of MB.
//  - Shard records are BYTE-IDENTICAL to the ones the bulk endpoint produced (verified against it
//    on ranked/unranked/abandoned matches), so the accumulated window and the wp-stats bake carry
//    over untouched. That is why the enum columns are NOT cast: ClickHouse renders Enum8 as its
//    name ("Team0", "Unranked") and DateTime as "YYYY-MM-DD hh:mm:ss", which is exactly what the
//    bulk endpoint sends. Casting them to numbers would silently split the archive in two.

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
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";

const SQL_API = "https://api.deadlock-api.com/v1/sql";
const MATCH_API = "https://api.deadlock-api.com/v1/matches";

// The day being harvested (UTC). Default is yesterday: matches finish ingesting within hours,
// so by the nightly run the previous day is complete; today would be a biased partial sample.
// `||`, not `??`: a scheduled workflow run passes `${{ inputs.day }}` through as an EMPTY string,
// which must fall back the same as unset (an empty MATCHES_PER_DAY would otherwise coerce to 0).
const day = process.env.HARVEST_DAY || isoDay(Date.now() - 24 * 3600 * 1000);
// Matches sampled per day — the density the rolling window's statistical power is sized around
// (see the workflow's note: at this rate the 30-day window alone clears the hero×item
// stabilization point, so per-hero WPA works without accumulating past the retention horizon).
// Keep it equal to what the binned fetch was landing, or shard sizes and that property both move.
const MATCHES_PER_DAY = Number(process.env.MATCHES_PER_DAY || 12000);
// How many of those to additionally fetch per-source gold for (the soul-economy norms), via cached
// single-match calls at ~300ms each — the one thing SQL can't supply. A subsample, not all of them:
// a median gold-per-source per (hero, rank) needs a few hundred games per cell, which 1,440/day
// over a 30-day window supplies many times over. Taken off the front of the hash-ordered sample,
// which is itself a uniform draw, so first-N stays unbiased. 0 disables the pass.
const GOLD_SAMPLE = Number(process.env.GOLD_SAMPLE || 1440);
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

// --- Fetch: shared retry policy (used by the SQL passes and the per-source gold pass) ---

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
      const retryable =
        e.status === undefined || RETRYABLE_STATUS.has(e.status);
      if (!retryable || attempt >= maxAttempts) throw e;
      const wait = Math.min(30000, 6000 * attempt);
      const why = e.status
        ? `HTTP ${e.status}`
        : e.code || e.cause?.code || e.name;
      console.warn(
        `${label}: ${why} — retry ${attempt}/${retries} in ${wait / 1000}s`,
      );
      await sleep(wait);
    }
  }
}

// --- The day's sample, from one SQL query ---

/** The day's candidate pool, matching what the bulk endpoint's own defaults selected. */
// Mirrors src/lib/rankedMode.ts — kept as a literal because scripts/ deliberately share no code
// with src/. The 2026-07-30 matchmaking update split queueing into Standard and Ranked, and only
// Ranked is skill-matched, so from that point the models should train on Ranked alone. Before it,
// Ranked did not exist (verified against /v1/sql: zero ranked matches between 2024-11-22 and
// 2026-07-30), so a back-harvested day has to keep both or it comes back empty.
const RANKED_MODE_FROM_S = Date.UTC(2026, 6, 30, 19, 14, 37) / 1000;

const dayWhere = (fromUnix, toUnix) =>
  `start_time >= toDateTime(${fromUnix}) AND start_time < toDateTime(${toUnix})` +
  ` AND game_mode = 'Normal' AND match_mode IN ` +
  (fromUnix >= RANKED_MODE_FROM_S ? `('Ranked')` : `('Ranked', 'Unranked')`);

/** The sampled match ids, as a subquery. Deterministic, so the ids pass and the rows pass below
 * select the same matches without having to ship twelve thousand ids back up in a URL. */
const sampleIds = (fromUnix, toUnix, limit) =>
  `SELECT match_id FROM match_player WHERE ${dayWhere(fromUnix, toUnix)}` +
  ` GROUP BY match_id ORDER BY cityHash64(match_id) LIMIT ${limit}`;

// Exactly the fields trimMatch/trimPlayer keep, in their order. `stats.net_worth` is the sampled
// net-worth trajectory the WPA work needs — ~12 points per player rather than the full stats blob.
// Nothing is cast: see the header note on why the archive depends on the raw Enum8/DateTime forms.
const ROW_COLUMNS = `match_id, start_time, duration_s, winning_team, match_outcome, match_mode,
  average_badge_team0, average_badge_team1,
  account_id, hero_id, team, player_slot, assigned_lane,
  kills, deaths, assists, denies, last_hits, net_worth, ability_points, player_level,
  abandon_match_time_s, hero_build_id,
  items.item_id, items.game_time_s, items.sold_time_s, items.upgrade_id,
  items.imbued_ability_id, items.flags, items.net_worth_at_buy,
  stats.net_worth AS stats_net_worth, stats.time_stamp_s AS stats_time_stamp_s`;

/**
 * Run a query and hand back the raw NDJSON body stream. Retries like fetchJson, but with a floor
 * well above the 2 req/min limit — a fast retry here just burns the next minute's only other token.
 */
async function fetchSqlStream(sql, { label, retries = FETCH_RETRIES } = {}) {
  const url = `${SQL_API}?query=${encodeURIComponent(sql.replace(/\s+/g, " "))}&format=ndjson`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        const err = new Error(`HTTP ${res.status} for ${label}: ${body}`);
        err.status = res.status;
        throw err;
      }
      return res.body;
    } catch (e) {
      const retryable =
        e.status === undefined || RETRYABLE_STATUS.has(e.status);
      if (!retryable || attempt >= retries + 1) throw e;
      const wait = 35000 * attempt; // one full rate window, then two, …
      console.warn(
        `${label}: ${e.status ? `HTTP ${e.status}` : e.code || e.name} — retry ${attempt}/${retries} in ${wait / 1000}s`,
      );
      await sleep(wait);
    }
  }
}

/** Every line of an NDJSON response, parsed. */
async function* sqlRows(sql, opts) {
  const body = await fetchSqlStream(sql, opts);
  const lines = createInterface({
    input: Readable.fromWeb(body),
    crlfDelay: Infinity,
  });
  for await (const line of lines) if (line) yield JSON.parse(line);
}

/** Fold one player's flat row back into the nested item list the shard format stores. */
function rowItems(r) {
  return r["items.item_id"].map((_, i) => ({
    item_id: r["items.item_id"][i],
    game_time_s: r["items.game_time_s"][i],
    sold_time_s: r["items.sold_time_s"][i],
    upgrade_id: r["items.upgrade_id"][i],
    imbued_ability_id: r["items.imbued_ability_id"][i],
    flags: r["items.flags"][i],
    net_worth_at_buy: r["items.net_worth_at_buy"][i],
  }));
}

/**
 * The day's sampled matches, streamed, each shaped like a bulk-endpoint match so `trimMatch` stays
 * the single place the shard format is defined. One match at a time is held, never the day: a
 * day's rows are ~60MB of JSON, and the point of asking for NDJSON is that they never have to be
 * materialized at once. Rows arrive grouped by `ORDER BY match_id`, so a match is complete as soon
 * as the id changes.
 */
async function* fetchDayMatches(fromUnix, toUnix, limit) {
  const sql = `SELECT ${ROW_COLUMNS} FROM match_player
    WHERE ${dayWhere(fromUnix, toUnix)}
      AND match_id IN (${sampleIds(fromUnix, toUnix, limit)})
    ORDER BY match_id, player_slot`;
  let rows = [];
  const flush = () => {
    const h = rows[0];
    const m = {
      match_id: h.match_id,
      start_time: h.start_time,
      duration_s: h.duration_s,
      winning_team: h.winning_team,
      match_outcome: h.match_outcome,
      match_mode: h.match_mode,
      average_badge_team0: h.average_badge_team0,
      average_badge_team1: h.average_badge_team1,
      players: rows.map((r) => ({ ...r, items: rowItems(r) })),
    };
    rows = [];
    return m;
  };
  for await (const r of sqlRows(sql, { label: `rows for ${day}` })) {
    if (rows.length && r.match_id !== rows[0].match_id) yield flush();
    rows.push(r);
  }
  if (rows.length) yield flush();
}

/** The ids the economy pass should fetch, in the same deterministic order the rows come back in. */
async function fetchGoldIds(fromUnix, toUnix, limit, want) {
  if (want <= 0) return [];
  const ids = [];
  for await (const r of sqlRows(
    `SELECT match_id FROM (${sampleIds(fromUnix, toUnix, limit)}) LIMIT ${want}`,
    { label: `gold ids for ${day}` },
  ))
    ids.push(r.match_id);
  return ids;
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
  // Matches are gzipped into the shard as they stream in, rather than accumulated and serialized
  // once at the end: a day is several hundred MB of JSON, past V8's ~512MB max string length, so
  // the join()-then-gzip form throws RangeError. The shard goes to a temp file first, so an aborted
  // run can't leave a truncated day looking complete.
  const dayEnd = dayStart + 24 * 3600;
  const tmpPath = `${shardPath}.tmp`;
  const gzip = createGzip({ level: 9 });
  const flushed = pipeline(gzip, createWriteStream(tmpPath));
  let written = 0;
  try {
    // Economy subsample first: it needs ids up front, and the sample is deterministic, so asking
    // for the ids separately costs one small query and lets the row stream be consumed in one pass.
    // Fails soft as a whole — the day is still worth having without its per-source souls.
    const goldIds = await fetchGoldIds(
      dayStart,
      dayEnd,
      MATCHES_PER_DAY,
      GOLD_SAMPLE,
    ).catch((e) => {
      console.warn(`gold id query failed, skipping economy pass: ${e.message}`);
      return [];
    });
    const gold = goldIds.length ? await fetchGoldSources(goldIds) : new Map();
    console.log(
      `economy: ${gold.size}/${goldIds.length} matches with a ledger`,
    );

    let chunk = "";
    for await (const m of fetchDayMatches(dayStart, dayEnd, MATCHES_PER_DAY)) {
      chunk += JSON.stringify(trimMatch(m, gold.get(m.match_id))) + "\n";
      written++;
      // Batch the writes: one gzip.write per match would be ~3,600 tiny deflate calls.
      if (chunk.length > 4 << 20) {
        if (!gzip.write(chunk)) await once(gzip, "drain");
        chunk = "";
      }
    }
    if (chunk && !gzip.write(chunk)) await once(gzip, "drain");

    // Discard a day that came back too thin to trust rather than write a partial shard that
    // `existsSync` would then treat as a complete day and refuse to re-harvest. A short day is
    // real (the pool can genuinely hold fewer than asked); a mostly-empty one is a failure.
    if (written < MATCHES_PER_DAY / 2)
      throw new Error(
        `harvest too sparse: ${written} matches, wanted ${MATCHES_PER_DAY}`,
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
    `wrote ${shardPath}: ${written} matches, ${statSync(shardPath).size} bytes gz`,
  );
}

const manifest = await purgeAndManifest(OUT_DIR);
const total = manifest.reduce((s, e) => s + e.matches, 0);
console.log(`window now holds ${manifest.length} shards, ${total} matches`);
