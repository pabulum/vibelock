import { describe, expect, it } from 'vitest';
import { WIN_STATE_GAP, classifyWinState } from './buildGenerator';

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
