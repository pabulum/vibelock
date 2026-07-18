import { describe, expect, it } from 'vitest';
import type { Hero, Patch } from '../types';
import {
  buildPaletteCommands,
  searchPalette,
  type PaletteState,
} from './palette';

const hero = (id: number, name: string): Hero => ({
  id,
  name,
  signatureClasses: [],
});
const HEROES = [
  hero(1, 'Abrams'),
  hero(2, 'Grey Talon'),
  hero(3, 'Haze'),
  hero(4, 'Seven'),
];
const PATCHES: Patch[] = [
  { title: '07-10-2025 Update', ts: 200 },
  { title: '06-01-2025 Update', ts: 100 },
];

const state: PaletteState = {
  heroes: HEROES,
  heroId: 2,
  enemies: [4],
  patches: PATCHES,
  patchIdx: 0,
  rankSel: 11,
  bandChoice: { lo: 7, hi: 9 },
  buildItems: [
    { id: 101, name: 'Toxic Bullets' },
    { id: 102, name: 'Extra Health' },
  ],
  otherItems: [
    { id: 201, name: 'Echo Shard' },
    { id: 202, name: 'Metal Skin' },
  ],
  hasBuild: true,
  backfillOn: true,
  lineAwareOn: false,
};

describe('buildPaletteCommands (all mode)', () => {
  const cmds = buildPaletteCommands('all', state);
  const byId = new Map(cmds.map((c) => [c.id, c]));

  it('marks the current hero, rank, and patch active', () => {
    expect(byId.get('hero:2')?.active).toBe(true);
    expect(byId.get('hero:3')?.active).toBeFalsy();
    expect(byId.get('rank:11')?.active).toBe(true);
    expect(byId.get('rank:8')?.active).toBeFalsy();
    expect(byId.get('patch:0')?.active).toBe(true);
    expect(byId.get('patch:0')?.label).toContain('(latest)');
  });

  it('offers remove only for current enemies and vs only for the rest', () => {
    expect(byId.get('rm:4')?.label).toBe('remove Seven');
    expect(byId.has('vs:4')).toBe(false);
    expect(byId.get('vs:3')?.label).toBe('vs Haze');
    expect(byId.has('rm:3')).toBe(false);
  });

  it('offers the profile band when available, hides it otherwise', () => {
    expect(byId.get('rank:band')?.label).toContain('around my rank');
    const noBand = buildPaletteCommands('all', { ...state, bandChoice: null });
    expect(noBand.some((c) => c.id === 'rank:band')).toBe(false);
  });

  it('carries the right action on each command', () => {
    expect(byId.get('hero:3')?.action).toEqual({ kind: 'hero', id: 3 });
    expect(byId.get('rank:band')?.action).toEqual({
      kind: 'rank',
      sel: { lo: 7, hi: 9 },
    });
    expect(byId.get('rank:8')?.action).toEqual({ kind: 'rank', sel: 8 });
    expect(byId.get('patch:1')?.action).toEqual({ kind: 'patch', idx: 1 });
    expect(byId.get('rm:4')?.action).toEqual({ kind: 'enemy', id: 4 });
    expect(byId.get('vs:3')?.action).toEqual({ kind: 'enemy', id: 3 });
  });

  it('keeps enemy toggles open for chaining; selection commands close', () => {
    expect(byId.get('vs:3')?.keepOpen).toBe(true);
    expect(byId.get('rm:4')?.keepOpen).toBe(true);
    expect(byId.get('hero:3')?.keepOpen).toBeFalsy();
    expect(byId.get('rank:8')?.keepOpen).toBeFalsy();
  });
});

describe('buildPaletteCommands (items & actions)', () => {
  const cmds = buildPaletteCommands('all', state);
  const byId = new Map(cmds.map((c) => [c.id, c]));

  it('lists build items as jump commands and the rest as search-only why-nots', () => {
    expect(byId.get('item:101')?.label).toBe('Toxic Bullets');
    expect(byId.get('item:101')?.action).toEqual({ kind: 'jump', id: 101 });
    expect(byId.get('item:101')?.searchOnly).toBeFalsy();
    expect(byId.get('why:201')?.label).toBe("why isn't Echo Shard here");
    expect(byId.get('why:201')?.action).toEqual({ kind: 'why', id: 201 });
    expect(byId.get('why:201')?.searchOnly).toBe(true);
    // No why-not twin for an item that's already in the build.
    expect(byId.has('why:101')).toBe(false);
  });

  it('offers the in-place enemies-mode switch, kept open for chaining', () => {
    const mode = byId.get('mode:enemies');
    expect(mode?.action).toEqual({ kind: 'mode', mode: 'enemies' });
    expect(mode?.keepOpen).toBe(true);
    // Reachable by every word a player might type for it.
    for (const q of ['vs', 'counter', 'enemies'])
      expect(
        searchPalette(cmds, q).some((c) => c.id === 'mode:enemies'),
      ).toBe(true);
  });

  it('lists the header panels and generation toggles as actions', () => {
    for (const id of [
      'panel:share',
      'panel:export',
      'panel:lab',
      'panel:match',
      'panel:guide',
    ])
      expect(byId.get(id)?.group).toBe('Actions');
    expect(byId.get('toggle:backfill')?.active).toBe(true);
    expect(byId.get('toggle:backfill')?.keepOpen).toBe(true);
    expect(byId.get('toggle:lineAware')?.active).toBeFalsy();
    expect(byId.get('toggle:lineAware')?.hint).toBe('turn on');
  });

  it('drops share/export and the why-nots when no build is baked', () => {
    const bare = buildPaletteCommands('all', { ...state, hasBuild: false });
    expect(bare.some((c) => c.id === 'panel:share')).toBe(false);
    expect(bare.some((c) => c.id === 'panel:export')).toBe(false);
    expect(bare.some((c) => c.id.startsWith('why:'))).toBe(false);
    // The rest of the actions stay.
    expect(bare.some((c) => c.id === 'panel:guide')).toBe(true);
  });
});

describe('searchPalette', () => {
  const cmds = buildPaletteCommands('all', state);

  it('returns the assembly order minus search-only commands on an empty query', () => {
    const browse = searchPalette(cmds, '  ');
    expect(browse.map((c) => c.id)).toEqual(
      cmds.filter((c) => !c.searchOnly).map((c) => c.id),
    );
    expect(browse.some((c) => c.id.startsWith('why:'))).toBe(false);
  });

  it('finds a build item by bare name and a missing item via its why-not label', () => {
    expect(searchPalette(cmds, 'toxic')[0]?.id).toBe('item:101');
    expect(searchPalette(cmds, 'echo')[0]?.id).toBe('why:201');
  });

  it('lists the why-not group on its namespace word', () => {
    const whys = searchPalette(cmds, 'why');
    expect(whys.length).toBe(2);
    expect(whys.every((c) => c.id.startsWith('why:'))).toBe(true);
  });

  it('ranks the hero switch above its enemy-add twin on a bare name', () => {
    const r = searchPalette(cmds, 'haze');
    expect(r[0]?.id).toBe('hero:3');
    expect(r.some((c) => c.id === 'vs:3')).toBe(true);
  });

  it('pinpoints the enemy add via the "vs " namespace', () => {
    expect(searchPalette(cmds, 'vs ha')[0]?.id).toBe('vs:3');
  });

  it('pinpoints removals via the "remove" namespace', () => {
    expect(searchPalette(cmds, 'remove sev')[0]?.id).toBe('rm:4');
  });

  it('lists whole groups on their namespace word', () => {
    // 12 floors + the band option lead; a coincidental subsequence match (e.g. the Share
    // action) may trail in the lower fuzzy band, so only the head of the list is asserted.
    const ranks = searchPalette(cmds, 'rank');
    expect(ranks.length).toBeGreaterThanOrEqual(13);
    expect(
      ranks.slice(0, 13).every((c) => c.id.startsWith('rank:')),
    ).toBe(true);
    // Both patches match on the "Patch:" prefix; the "(latest)" suffix makes patch:0 the
    // longer label, so the shorter-name tiebreak may order it second — membership is what
    // counts. The backfill toggle (word "patch" in its label) may trail in the word band.
    const patches = searchPalette(cmds, 'patch');
    expect(
      patches
        .slice(0, 2)
        .map((c) => c.id)
        .sort(),
    ).toEqual(['patch:0', 'patch:1']);
  });

  it('matches a patch by its date fragment', () => {
    expect(searchPalette(cmds, '06-01')[0]?.id).toBe('patch:1');
  });
});

describe('buildPaletteCommands (enemies mode)', () => {
  const cmds = buildPaletteCommands('enemies', state);

  it('lists every hero as a keep-open toggle, current enemies first', () => {
    expect(cmds).toHaveLength(HEROES.length);
    expect(cmds[0]?.label).toBe('Seven');
    expect(cmds[0]?.active).toBe(true);
    expect(cmds[0]?.hint).toBe('remove enemy');
    expect(cmds.every((c) => c.keepOpen)).toBe(true);
    const haze = cmds.find((c) => c.label === 'Haze');
    expect(haze?.active).toBeFalsy();
    expect(haze?.hint).toBe('add enemy');
    expect(haze?.action).toEqual({ kind: 'enemy', id: 3 });
  });
});
