// Boundary tests for the wire schemas — specifically the places where the API has already changed
// its encoding under us once. The browser smoke tests can't catch these: they run against captured
// fixtures, so a fixture recorded before an upstream change keeps passing forever (see the
// avg_sell_time_s nullability lesson). These assert the shapes we've observed LIVE.

import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { MatchMetadataResponseSchema } from "./schemas";

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
