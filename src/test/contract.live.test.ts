// Schema-drift canary: every response schema, checked against the LIVE API.
//
//   npm run test:contract        (also run nightly — .github/workflows/contract.yml)
//
// Why this exists, specifically. The fixtures the smoke tests run on are captured production
// responses, and captured responses are a photograph: they cannot show you that upstream started
// serializing team ids as numbers instead of enum names, or that a field flipped from omitted to
// null. Both of those have happened. The second one took the whole Match view down in production —
// HTTP 200, Valibot reject, "Unexpected response shape", and nothing anywhere went red, because
// every test in the repo was still being served the payload from the week before.
//
// So this suite is deliberately the *opposite* of the rest: no fixtures, no mock, real network, and
// it is not part of `npm test` (which must stay hermetic and offline-clean). It fails when the API
// stops matching what the app compiles against — which is a fact about the world, not about this
// commit — so it runs on a schedule and files an issue, rather than blocking a PR on someone else's
// deploy.
//
// Budget: ~20 requests, all within the analytics family's 200/60s. The two exceptions are called
// out where they happen — /v1/sql (2 req/min, 20/hr) runs exactly once, and the match-metadata
// endpoint is fetched with `disable_steam=true`, the free ingested-only probe. Nothing here retries:
// a rate-limited canary must report "couldn't check", never hammer the API it is monitoring.

import * as v from "valibot";
import { beforeAll, expect, test } from "vitest";
import {
  AbilityOrderRowSchema,
  BadgeDistributionRowSchema,
  HeroBuildStatRowSchema,
  HeroCounterRowSchema,
  HeroLadderStatSchema,
  ItemFlowStatsSchema,
  ItemPermutationStatsSchema,
  ItemStatSchema,
  MatchHistoryRowSchema,
  MatchMetadataResponseSchema,
  PlayerHeroStatSchema,
  PlayerMetricsSchema,
  PlayerRankSchema,
  RawBuildEnvelopeSchema,
  RawHeroSchema,
  RawItemSchema,
  RawPatchSchema,
  RawRankedSeasonSchema,
  SteamPlayerMatchSchema,
} from "../api/schemas";

const BASE = "https://api.deadlock-api.com";
const HERO_ID = 1; // Abrams — same reference hero the fixtures are captured for
// Long enough to cover the API's slower aggregates (permutation stats is 1–2 MB) without letting a
// hung request stall the whole run.
const TIMEOUT = 60_000;

type AnySchema = v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>;

/** Fetch and validate, failing with the endpoint + the exact path that drifted — the same message
 * shape a user would have seen in the error banner, which is the point: if this passes, that banner
 * cannot say "unexpected response shape". */
async function check<T extends AnySchema>(
  path: string,
  schema: T,
): Promise<v.InferOutput<T>> {
  const res = await fetch(`${BASE}${path}`);
  expect(res.ok, `${path} → HTTP ${res.status} ${res.statusText}`).toBe(true);
  const body: unknown = await res.json();
  const result = v.safeParse(schema, body);
  if (!result.success) {
    const issue = result.issues[0];
    const dotPath = v.getDotPath(issue);
    // `received` (not the payload) — the message has to be readable in a CI log and in an issue.
    throw new Error(
      `${path} drifted at ${dotPath || "(root)"}: ${issue.message}. ` +
        `Fix the schema in src/api/schemas.ts, then re-capture fixtures.`,
    );
  }
  return result.output;
}

const rows = <T extends AnySchema>(schema: T) => v.array(schema);

// A window the API definitely has data for, and one it computes quickly. Deliberately not the app's
// patch-derived windows: this suite is asking "does the payload still have the shape we parse",
// not "is the current patch's slice populated", and a young or empty window answers neither.
const params = (extra: Record<string, string> = {}) =>
  new URLSearchParams({ ...extra }).toString();

// Ids for the account-scoped and match-scoped endpoints, discovered rather than hard-coded: a
// pinned account can go private and a pinned match can age out, and a canary that cries wolf gets
// muted. Resolved once, from a single /v1/sql query (see the budget note in the header).
let sample: { matchId: number; accountId: number } | null = null;

beforeAll(async () => {
  const sql =
    `SELECT match_id, account_id FROM match_player ` +
    `WHERE start_time > now() - INTERVAL 3 DAY LIMIT 1`;
  try {
    const res = await fetch(
      `${BASE}/v1/sql?query=${encodeURIComponent(sql)}&format=json`,
    );
    if (!res.ok) return;
    const body = (await res.json()) as
      | { match_id: number; account_id: number }[]
      | { data?: { match_id: number; account_id: number }[] };
    const row = Array.isArray(body) ? body[0] : body.data?.[0];
    if (row) sample = { matchId: row.match_id, accountId: row.account_id };
  } catch {
    // Leave `sample` null — the dependent checks skip themselves and say so, which is the honest
    // outcome when the rate limiter, not the schema, is what we ran into.
  }
}, TIMEOUT);

// ---- Assets -----------------------------------------------------------------------------------
// These three are the only responses whose *emptiness* is asserted. Everything else can legitimately
// come back empty (a rank slice with no games, a patch nobody has a build for); a hero list that
// came back empty would mean the app renders nothing at all.

test(
  "/v1/assets/heroes",
  async () => {
    const heroes = await check(
      "/v1/assets/heroes?only_active=true",
      rows(RawHeroSchema),
    );
    expect(heroes.length).toBeGreaterThan(0);
  },
  TIMEOUT,
);

test(
  "/v1/assets/items",
  async () => {
    const items = await check("/v1/assets/items", rows(RawItemSchema));
    // The list carries abilities *and* shop items; the client filters on these two fields, so a
    // payload where nothing has them would parse cleanly and still bake an empty build.
    expect(
      items.filter((i) => i.item_slot_type && i.item_tier).length,
    ).toBeGreaterThan(0);
  },
  TIMEOUT,
);

test(
  "/v1/assets/ranked-seasons",
  async () => {
    await check("/v1/assets/ranked-seasons", rows(RawRankedSeasonSchema));
  },
  TIMEOUT,
);

test(
  "/v2/patches",
  async () => {
    const patches = await check("/v2/patches", rows(RawPatchSchema));
    expect(patches.length).toBeGreaterThan(0);
  },
  TIMEOUT,
);

// ---- Analytics --------------------------------------------------------------------------------

test(
  "/v1/analytics/item-stats",
  async () => {
    await check(
      `/v1/analytics/item-stats?${params({ hero_id: String(HERO_ID), min_matches: "20" })}`,
      rows(ItemStatSchema),
    );
  },
  TIMEOUT,
);

test(
  "/v1/analytics/item-flow-stats",
  async () => {
    // `hero_ids` (plural) — the singular form is silently ignored here and returns the all-heroes
    // aggregate. Sent the way the client sends it, so this checks the request too, not just the
    // response.
    await check(
      `/v1/analytics/item-flow-stats?${params({
        hero_ids: String(HERO_ID),
        min_matches: "100",
        phase_interval_s: "600",
        phase_count: "4",
      })}`,
      ItemFlowStatsSchema,
    );
  },
  TIMEOUT,
);

test(
  "/v1/analytics/item-permutation-stats",
  async () => {
    await check(
      `/v1/analytics/item-permutation-stats?${params({
        hero_id: String(HERO_ID),
        comb_size: "2",
      })}`,
      rows(ItemPermutationStatsSchema),
    );
  },
  TIMEOUT,
);

test(
  "/v1/analytics/ability-order-stats",
  async () => {
    await check(
      `/v1/analytics/ability-order-stats?${params({
        hero_id: String(HERO_ID),
        min_matches: "100",
      })}`,
      rows(AbilityOrderRowSchema),
    );
  },
  TIMEOUT,
);

test(
  "/v1/analytics/hero-counter-stats",
  async () => {
    await check(
      `/v1/analytics/hero-counter-stats?${params({
        min_matches: "100",
        same_lane_filter: "false",
      })}`,
      rows(HeroCounterRowSchema),
    );
  },
  TIMEOUT,
);

test(
  "/v1/analytics/hero-stats",
  async () => {
    await check("/v1/analytics/hero-stats", rows(HeroLadderStatSchema));
  },
  TIMEOUT,
);

test(
  "/v1/analytics/badge-distribution",
  async () => {
    await check(
      "/v1/analytics/badge-distribution",
      rows(BadgeDistributionRowSchema),
    );
  },
  TIMEOUT,
);

test(
  "/v1/analytics/hero-build-stats/{hero}",
  async () => {
    await check(
      `/v1/analytics/hero-build-stats/${HERO_ID}?${params({ min_matches: "20" })}`,
      rows(HeroBuildStatRowSchema),
    );
  },
  TIMEOUT,
);

test(
  "/v1/analytics/player-stats/metrics",
  async () => {
    const metrics = await check(
      `/v1/analytics/player-stats/metrics?${params({ hero_ids: String(HERO_ID) })}`,
      PlayerMetricsSchema,
    );
    // A record schema accepts `{}`, so the shape check alone can't tell a healthy response from an
    // empty one — and lib/fundamentals reads metrics by name.
    expect(Object.keys(metrics).length).toBeGreaterThan(0);
  },
  TIMEOUT,
);

test(
  "/v1/builds",
  async () => {
    await check(
      `/v1/builds?${params({
        hero_id: String(HERO_ID),
        only_latest: "true",
        sort_by: "favorites",
        sort_direction: "desc",
        limit: "20",
      })}`,
      rows(RawBuildEnvelopeSchema),
    );
  },
  TIMEOUT,
);

// ---- Player + match ---------------------------------------------------------------------------

test(
  "/v1/players/steam-search",
  async () => {
    await check(
      `/v1/players/steam-search?${params({
        search_query: "deadlock",
        min_matches_played_last_30d: "0",
      })}`,
      rows(SteamPlayerMatchSchema),
    );
  },
  TIMEOUT,
);

test(
  "/v1/players/hero-stats",
  async () => {
    expect(
      sample,
      "no sample account (the /v1/sql probe didn't answer)",
    ).not.toBeNull();
    await check(
      `/v1/players/hero-stats?account_ids=${sample!.accountId}`,
      rows(PlayerHeroStatSchema),
    );
  },
  TIMEOUT,
);

test(
  "/v1/players/{id}/rank",
  async () => {
    expect(
      sample,
      "no sample account (the /v1/sql probe didn't answer)",
    ).not.toBeNull();
    await check(`/v1/players/${sample!.accountId}/rank`, PlayerRankSchema);
  },
  TIMEOUT,
);

test(
  "/v1/players/{id}/match-history",
  async () => {
    expect(
      sample,
      "no sample account (the /v1/sql probe didn't answer)",
    ).not.toBeNull();
    await check(
      `/v1/players/${sample!.accountId}/match-history`,
      rows(MatchHistoryRowSchema),
    );
  },
  TIMEOUT,
);

test(
  "/v1/matches/{id}/metadata",
  async () => {
    expect(
      sample,
      "no sample match (the /v1/sql probe didn't answer)",
    ).not.toBeNull();
    // `disable_steam=true`: the ingested-only probe, which is free and header-less. WITHOUT it this
    // request would fall back to fetching from Steam, which is the ~3/hour family — never do that
    // from anything that runs on a timer.
    const { match_info } = await check(
      `/v1/matches/${sample!.matchId}/metadata?disable_steam=true`,
      MatchMetadataResponseSchema,
    );
    // The two fields that have actually drifted: `team` moved from enum names to numbers, and the
    // per-player arrays flipped between omitted and null. The schema normalizes both, so assert the
    // normalization still produces what the analyzer indexes on.
    expect([0, 1, 16]).toContain(match_info.winning_team);
    for (const p of match_info.players) expect([0, 1]).toContain(p.team);
  },
  TIMEOUT,
);
