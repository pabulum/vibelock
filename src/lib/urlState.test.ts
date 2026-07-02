import { describe, expect, it } from 'vitest';
import { decodeUrlState, encodeUrlState, slugify, type UrlState } from './urlState';

describe('slugify', () => {
  it('lowercases and dashes non-alphanumerics', () => {
    expect(slugify('Grey Talon')).toBe('grey-talon');
    expect(slugify("Mo & Krill")).toBe('mo-krill');
    expect(slugify('Pocket')).toBe('pocket');
  });

  it('trims leading/trailing dashes', () => {
    expect(slugify('  Abrams!  ')).toBe('abrams');
  });
});

describe('encodeUrlState', () => {
  it('omits defaults: the "all" build and empty enemies leave no trace', () => {
    expect(encodeUrlState({ hero: 'paradox', tier: 11, build: 'all', enemies: [] })).toBe(
      '?hero=paradox&rank=11',
    );
  });

  it('encodes every set field', () => {
    expect(
      encodeUrlState({
        hero: 'abrams',
        tier: 8,
        patchTs: 1_700_000_000,
        build: 'spirit',
        enemies: ['seven', 'haze'],
      }),
    ).toBe('?hero=abrams&rank=8&patch=1700000000&build=spirit&vs=seven%2Chaze');
  });

  it('returns an empty string when there is nothing to encode', () => {
    expect(encodeUrlState({})).toBe('');
  });
});

describe('decodeUrlState', () => {
  it('parses a full query string (leading ? optional)', () => {
    expect(decodeUrlState('?hero=abrams&rank=8&patch=1700000000&build=spirit&vs=seven,haze')).toEqual({
      hero: 'abrams',
      tier: 8,
      patchTs: 1_700_000_000,
      build: 'spirit',
      enemies: ['seven', 'haze'],
    });
  });

  it('ignores malformed numbers and unknown build values', () => {
    expect(decodeUrlState('?rank=abc&patch=-5&build=hybrid')).toEqual({});
  });

  it('drops empty enemy entries', () => {
    expect(decodeUrlState('?vs=seven,,haze,')).toEqual({ enemies: ['seven', 'haze'] });
  });

  it('returns an empty object for an empty query', () => {
    expect(decodeUrlState('')).toEqual({});
  });
});

describe('encode/decode round-trip', () => {
  it('survives a round trip for representative states', () => {
    const states: UrlState[] = [
      { hero: 'grey-talon', tier: 11 },
      { hero: 'vyper', tier: 6, build: 'gun', enemies: ['seven'] },
      { hero: 'mo-krill', tier: 0, patchTs: 1_699_999_999, build: 'spirit', enemies: ['haze', 'wraith'] },
      { hero: 'paradox', tier: 8, backfill: false },
      { hero: 'paradox', band: { lo: 5, hi: 7 } },
    ];
    for (const s of states) {
      expect(decodeUrlState(encodeUrlState(s))).toEqual(s);
    }
  });
});
