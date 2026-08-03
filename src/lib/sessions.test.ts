import { describe, expect, it } from "vitest";
import type { MatchHistoryRow } from "../types";
import {
  QUICK_REQUEUE_S,
  RESTED_S,
  SESSION_GAP_S,
  sessionStats,
  tiltVerdict,
} from "./sessions";

const DUR = 1800;
let clock = 1_700_000_000;

/** A game `gapS` after the previous one ended. `win` decides the outcome via the winning-team
 * encoding (match_result is the WINNING TEAM's number, not a flag). */
function game(win: boolean, gapS = 600): MatchHistoryRow {
  clock += DUR + gapS;
  return {
    match_id: clock,
    hero_id: 15,
    start_time: clock,
    match_duration_s: DUR,
    match_result: win ? 0 : 1,
    player_team: 0,
    player_kills: 0,
    player_deaths: 0,
    player_assists: 0,
    net_worth: 0,
    ranked_display_badge: null,
    ranked_delta: null,
    ranked_calibration_match: null,
    ranked_used_demotion_protection: null,
  };
}

const reset = () => {
  clock = 1_700_000_000;
};

/** A loss used only to put the NEXT game on a streak. Its own gap sits deliberately between the two
 * arms — longer than a quick requeue, shorter than a rest — so the setup games land in neither arm
 * and can't tilt the contrast they exist to create. (A 600s gap would make every filler a
 * quick-requeue-on-streak loss in its own right, which is correct behaviour and ruins the fixture.) */
const NEITHER_ARM_S = QUICK_REQUEUE_S + 600;
const filler = () => game(false, NEITHER_ARM_S);

describe("sessionStats", () => {
  it("is null on a history too short to say anything about", () => {
    reset();
    expect(sessionStats([game(true), game(false)])).toBeNull();
  });

  it("counts sessions by idle gap, not by day", () => {
    reset();
    const h = [
      ...Array.from({ length: 6 }, () => game(true, 600)),
      game(true, SESSION_GAP_S + 60), // new session
      ...Array.from({ length: 6 }, () => game(false, 600)),
    ];
    const s = sessionStats(h)!;
    expect(s.sessions).toBe(2);
    expect(s.games).toBe(13);
  });

  it("buckets games by the losing streak that preceded them", () => {
    reset();
    // W L L L W  → streak-before is 0,0,1,2,3
    const h = [
      game(true),
      game(false),
      game(false),
      game(false),
      game(true),
      ...Array.from({ length: 9 }, () => game(true)),
    ];
    const s = sessionStats(h)!;
    const at = (k: number) => s.byStreak.find((r) => r.losses === k);
    expect(at(1)?.games).toBe(1);
    expect(at(2)?.games).toBe(1);
    expect(at(3)?.atLeast).toBe(true);
    expect(at(3)?.games).toBe(1);
  });

  it("carries the streak across a session break so the rested arm can exist at all", () => {
    reset();
    // Two losses, then a long break, then a game. That last game must still count as "on a
    // streak" — resetting at the break would make every rested game streak-0 by construction.
    const h = [
      ...Array.from({ length: 10 }, () => game(true)),
      game(false),
      game(false),
      game(true, RESTED_S + 60),
    ];
    const s = sessionStats(h)!;
    expect(s.sessions).toBe(2);
    expect(s.byStreak.find((r) => r.losses === 2)?.games).toBe(1);
  });

  it("reports no contrast until both arms have real samples", () => {
    reset();
    const h = Array.from({ length: 40 }, (_, i) => game(i % 3 === 0));
    expect(sessionStats(h)!.tilt).toBeNull();
  });

  it("measures requeue-vs-rest at equal streak state", () => {
    reset();
    const h: MatchHistoryRow[] = [];
    // 20 streak-games requeued fast, all losses; 20 streak-games after a break, all wins.
    for (let i = 0; i < 20; i++) {
      h.push(filler(), filler());
      h.push(game(false, QUICK_REQUEUE_S - 60)); // on a streak, requeued → loss
    }
    for (let i = 0; i < 20; i++) {
      h.push(filler(), filler());
      h.push(game(true, RESTED_S + 60)); // same streak state, rested → win
    }
    const t = sessionStats(h)!.tilt!;
    expect(t.quick.games).toBeGreaterThanOrEqual(20);
    expect(t.rested.games).toBeGreaterThanOrEqual(20);
    expect(t.quick.winRate).toBeLessThan(t.rested.winRate);
    expect(t.significant).toBe(true);
    expect(tiltVerdict(t)).toContain("Stopping after two is worth it");
  });

  it("calls an inconclusive contrast inconclusive", () => {
    reset();
    const h: MatchHistoryRow[] = [];
    // Both arms at ~50%: a real gap of ~0, which must not be dressed up as a finding.
    for (let i = 0; i < 20; i++) {
      h.push(filler(), filler());
      h.push(game(i % 2 === 0, QUICK_REQUEUE_S - 60));
      h.push(filler(), filler());
      h.push(game(i % 2 === 0, RESTED_S + 60));
    }
    const t = sessionStats(h)!.tilt!;
    expect(t.significant).toBe(false);
    const v = tiltVerdict(t);
    expect(v).toContain("indistinguishable from noise");
    expect(v).toContain("more likely the ladder finding your rank");
  });

  it("does not claim tilt when requeueing looks better", () => {
    reset();
    const h: MatchHistoryRow[] = [];
    for (let i = 0; i < 20; i++) {
      h.push(filler(), filler());
      h.push(game(true, QUICK_REQUEUE_S - 60));
      h.push(filler(), filler());
      h.push(game(false, RESTED_S + 60));
    }
    const t = sessionStats(h)!.tilt!;
    expect(t.delta).toBeGreaterThan(0);
    expect(tiltVerdict(t)).toContain("aren't tilt");
  });

  it("says what it cannot separate when there is no contrast", () => {
    expect(tiltVerdict(null)).toContain("separate tilt from the ladder");
  });
});
