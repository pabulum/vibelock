// Boundary tests for the wire schemas — specifically the places where the API has already changed
// its encoding under us once. The browser smoke tests can't catch these: they run against captured
// fixtures, so a fixture recorded before an upstream change keeps passing forever (see the
// avg_sell_time_s nullability lesson). These assert the shapes we've observed LIVE.

import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { MatchMetadataResponseSchema } from "./schemas";
import { analyzeMatch } from "../lib/matchAnalysis";
import matchFixture from "../test/fixtures/matchMetadata.json";

const match = (winning: unknown, team: unknown) => ({
  match_info: {
    match_id: 1,
    start_time: 0,
    duration_s: 100,
    winning_team: winning,
    players: [
      {
        account_id: 7,
        player_slot: 1,
        team,
        hero_id: 15,
        kills: 0,
        deaths: 0,
        assists: 0,
        net_worth: 0,
      },
    ],
  },
});

describe("match metadata team encoding", () => {
  it("accepts the proto enum numbers the endpoint sends now", () => {
    const r = v.parse(MatchMetadataResponseSchema, match(0, 1));
    expect(r.match_info.winning_team).toBe(0);
    expect(r.match_info.players[0].team).toBe(1);
  });

  it("still accepts the enum NAMES it used to send", () => {
    // The switch from "Team0" to 0 broke every match analysis with "Unexpected response shape";
    // both stay accepted so a flip back doesn't do it again.
    const r = v.parse(MatchMetadataResponseSchema, match("Team1", "Team0"));
    expect(r.match_info.winning_team).toBe(1);
    expect(r.match_info.players[0].team).toBe(0);
  });

  it("normalizes both encodings to the same value, so they compare directly", () => {
    const asNumbers = v.parse(MatchMetadataResponseSchema, match(1, 1));
    const asNames = v.parse(
      MatchMetadataResponseSchema,
      match("Team1", "Team1"),
    );
    expect(asNumbers).toEqual(asNames);
    // The comparison the whole "did I win" path is built on.
    const { winning_team, players } = asNames.match_info;
    expect(players[0].team === winning_team).toBe(true);
  });

  it("rejects a team value it can't map, rather than inventing a side", () => {
    expect(() =>
      v.parse(MatchMetadataResponseSchema, match(0, "Team7")),
    ).toThrow();
  });
});

// ---- The nullish rule ---------------------------------------------------------------------------
// schemas.ts states a rule for the match slice: everything not required is `nullish`, never
// `optional`, because this endpoint moves between omitting a field and sending it as null with no
// warning, and the two mean the same thing here. `gold_sources[].kills` and `.gold_orbs` making that
// exact move is what took the whole Match view down.
//
// A rule in a comment is a rule until someone adds a field. These assert it mechanically instead —
// off the schema's own structure, so a field added tomorrow is covered without anyone remembering.

/** Every sub-schema in the tree, by dot path, walking objects, arrays, unions and wrappers. */
function walk(
  schema: unknown,
  path = "",
  out: Array<{ path: string; schema: v.GenericSchema }> = [],
): Array<{ path: string; schema: v.GenericSchema }> {
  const s = schema as v.GenericSchema & {
    type: string;
    entries?: Record<string, unknown>;
    item?: unknown;
    options?: unknown[];
    wrapped?: unknown;
  };
  if (!s || typeof s.type !== "string") return out;
  if (path) out.push({ path, schema: s });
  if (s.entries)
    for (const [k, e] of Object.entries(s.entries))
      walk(e, path ? `${path}.${k}` : k, out);
  if (s.item) walk(s.item, `${path}[]`, out);
  if (s.options) for (const o of s.options) walk(o, path, out);
  if (s.wrapped) walk(s.wrapped, path, out);
  return out;
}

describe("match metadata nullability", () => {
  it("uses nullish, never optional, for every field in the match slice", () => {
    // `optional` accepts a missing key but REJECTS an explicit null — the precise gap the endpoint
    // has fallen through before. Anything genuinely optional here must be `nullish`.
    const offenders = walk(MatchMetadataResponseSchema)
      .filter(({ schema }) => (schema as { type: string }).type === "optional")
      .map(({ path }) => path);
    expect(
      offenders,
      `these accept a missing key but would throw on an explicit null: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("parses a real payload with every nullable field explicitly null", () => {
    // The captured fixture is a real 12-player game, but the capture projection drops nulls — so
    // the fixture alone proves nothing about nullability. Null every nullish field back in, driven
    // off the schema so the coverage can't fall behind it.
    const nulled = nullifyNullish(MatchMetadataResponseSchema, matchFixture);
    const result = v.safeParse(MatchMetadataResponseSchema, nulled);
    const issue = result.success ? null : result.issues[0];
    expect(
      result.success,
      issue
        ? `rejected null at ${v.getDotPath(issue)}: ${issue.message}`
        : undefined,
    ).toBe(true);

    // ...and the analyzer downstream survives it. Parsing was never the whole failure: a view that
    // parses and then throws on `sample.gold_sources.length` is just as dead.
    const parsed = v.parse(MatchMetadataResponseSchema, nulled);
    const focus = parsed.match_info.players[0].account_id;
    expect(() =>
      analyzeMatch(parsed.match_info, focus, null, null),
    ).not.toThrow();
  });
});

/** Deep copy of `value` with every field the schema marks `nullish` set to null. */
function nullifyNullish(schema: unknown, value: unknown): unknown {
  const s = schema as {
    type: string;
    entries?: Record<string, unknown>;
    item?: unknown;
    wrapped?: unknown;
  };
  if (!s || typeof s.type !== "string") return value;
  if (s.type === "nullish") return null;
  if (s.type === "optional") return nullifyNullish(s.wrapped, value);
  if (s.entries && value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = { ...src };
    for (const [k, e] of Object.entries(s.entries))
      if (k in src) out[k] = nullifyNullish(e, src[k]);
    return out;
  }
  if (s.item && Array.isArray(value))
    return value.map((x) => nullifyNullish(s.item, x));
  return value;
}
