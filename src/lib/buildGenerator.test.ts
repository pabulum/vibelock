import { describe, expect, it } from 'vitest';
import { WIN_STATE_GAP, classifyWinState, generateBuild } from './buildGenerator';
import type { Hero, Item, ItemFlowStats } from '../types';

// classifyWinState reads the raw-vs-adjusted (game-state-corrected) win-rate gap: a pick whose raw
// rate runs well above its adjusted rate mostly wins games you were already winning ("win more"); the
// reverse holds up when bought from behind ("comeback"). A clear loser is never labelled.
describe('classifyWinState', () => {
  const baseline = 0.5;

  it('labels a pick that wins far more raw than adjusted as "winmore"', () => {
    expect(classifyWinState(0.56, 0.5, baseline)).toBe('winmore');
  });

  it('labels a pick that holds up better adjusted than raw as "comeback"', () => {
    expect(classifyWinState(0.5, 0.56, baseline)).toBe('comeback');
  });

  it('returns undefined when the gap is within noise', () => {
    expect(classifyWinState(0.51, 0.5, baseline)).toBeUndefined();
  });

  it('never labels a clear loser, even with a large raw-vs-adjusted gap', () => {
    // adjusted well below baseline ⇒ just a bad pick, not a "win more" option, despite the wide gap.
    expect(classifyWinState(0.6, 0.4, baseline)).toBeUndefined();
  });

  it('keys "winmore"/"comeback" off the gap sign at the WIN_STATE_GAP threshold', () => {
    const adj = 0.5;
    expect(classifyWinState(adj + WIN_STATE_GAP, adj, baseline)).toBe('winmore');
    expect(classifyWinState(adj - WIN_STATE_GAP, adj, baseline)).toBe('comeback');
    // Just inside the threshold ⇒ unlabelled.
    expect(classifyWinState(adj + WIN_STATE_GAP - 1e-6, adj, baseline)).toBeUndefined();
  });
});

// Regression: Deadlock never lets you buy a component standalone once its upgrade is owned (you can
// buy a *different* item built from that component, but not the component itself again). A build that
// puts the upgrade core in an earlier phase and then offers the component again in a later phase is
// recommending an impossible purchase.
describe('generateBuild — component/upgrade cross-phase dedup', () => {
  it('never offers a component once its upgrade is already core in an earlier phase', () => {
    const component: Item = {
      id: 1,
      name: 'Mystic Vulnerability',
      tier: 1,
      cost: 500,
      slot: 'spirit',
      componentIds: [],
    };
    const upgrade: Item = {
      id: 2,
      name: 'Escalating Exposure',
      tier: 2,
      cost: 1500,
      slot: 'spirit',
      componentIds: [component.id],
    };
    const items = new Map<number, Item>([
      [component.id, component],
      [upgrade.id, upgrade],
    ]);

    const flow: ItemFlowStats = {
      nodes: [
        // The upgrade is bought (and is the sole, universal, core-worthy pick) in Mid (column 2).
        {
          column: 2,
          item_id: upgrade.id,
          wins: 60,
          losses: 40,
          players: 100,
          matches: 100,
          adjusted_win_rate: 0.6,
          avg_net_worth_at_buy: 5000,
          total_kills: 0,
          total_deaths: 0,
          total_assists: 0,
        },
        // Its component resurfaces as a distinct, universal, core-worthy candidate in Late (column 3) —
        // e.g. a different slice of players who buy it standalone and never upgrade.
        {
          column: 3,
          item_id: component.id,
          wins: 70,
          losses: 30,
          players: 100,
          matches: 100,
          adjusted_win_rate: 0.7,
          avg_net_worth_at_buy: 8000,
          total_kills: 0,
          total_deaths: 0,
          total_assists: 0,
        },
      ],
      edges: [],
      summary: {
        matches: 100,
        players: 100,
        wins: 50,
        losses: 50,
        avg_duration_s: 1800,
        avg_net_worth: 8000,
      },
      baseline: {
        matches: 100,
        players: 100,
        wins: 50,
        losses: 50,
        avg_duration_s: 1800,
        avg_net_worth: 8000,
      },
      reached_per_column: [100, 100, 100, 100],
    };

    const hero: Hero = { id: 1, name: 'Test Hero', signatureClasses: [] };
    const build = generateBuild(hero, 'Test Rank', items, flow, new Map(), new Map());

    const allItemIds = build.phases.flatMap((p) =>
      [...p.core, ...p.situational].map((b) => b.item.id),
    );
    expect(allItemIds).not.toContain(component.id);
    expect(allItemIds).toContain(upgrade.id);
  });
});
