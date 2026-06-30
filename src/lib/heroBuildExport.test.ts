import { describe, expect, it } from 'vitest';
import type { BuildItem, BuildPhase, GeneratedBuild, Item } from '../types';
import { buildExportCategories, encodeHeroBuild } from './heroBuildExport';

// ---- a tiny protobuf reader, just to assert the encoder's output structure ----
type Field = { f: number; wt: number; v: number | Uint8Array };
function parse(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = () => {
    let r = 0, s = 0, x: number;
    do {
      x = b[i++];
      r += (x & 0x7f) * 2 ** s;
      s += 7;
    } while (x & 0x80);
    return r;
  };
  while (i < b.length) {
    const tag = varint();
    const f = Math.floor(tag / 8), wt = tag % 8;
    if (wt === 0) out.push({ f, wt, v: varint() });
    else if (wt === 2) {
      const len = varint();
      out.push({ f, wt, v: b.subarray(i, i + len) });
      i += len;
    } else if (wt === 5) {
      out.push({ f, wt, v: new DataView(b.buffer, b.byteOffset + i, 4).getFloat32(0, true) });
      i += 4;
    } else throw new Error(`unsupported wire type ${wt}`);
  }
  return out;
}
const sub = (fields: Field[], f: number) => parse(fields.find((x) => x.f === f)!.v as Uint8Array);
const all = (fields: Field[], f: number) => fields.filter((x) => x.f === f);
const str = (fields: Field[], f: number) => new TextDecoder().decode(fields.find((x) => x.f === f)!.v as Uint8Array);
const num = (fields: Field[], f: number) => fields.find((x) => x.f === f)!.v as number;

// ---- fixtures ----
const item = (id: number): Item => ({ id, name: `Item ${id}`, tier: 1, cost: 500, slot: 'weapon', componentIds: [] });
const bi = (id: number): BuildItem => ({
  item: item(id), role: 'value', pickRate: 0.5, adjustedWinRate: 0.52, rawWinRate: 0.52,
  sample: 100, decided: 100, avgNetWorthAtBuy: 0, why: '',
});
const phase = (column: number, label: string, core: number[], situational: number[] = []): BuildPhase => ({
  column, label, timeLabel: `${label} window`, targetItems: core.length, itemsBought: core.length, soulBudget: 0,
  coreSouls: 0, categorySouls: { weapon: 0, vitality: 0, spirit: 0 },
  core: core.map(bi), situational: situational.map(bi),
});
const build = (): GeneratedBuild => ({
  hero: { id: 12, name: 'Kelvin', signatureClasses: [] },
  rankLabel: 'Eternus',
  population: { matches: 1000, avgDurationS: 1980, baselineWinRate: 0.5 },
  phases: [phase(0, 'Lane', [10, 11], [11, 30]), phase(1, 'Mid', [20], [31])],
  standingSlots: 3,
  overtimeBuys: [bi(40), bi(20)], // 20 is already core → should be dropped from Overtime
});

describe('buildExportCategories', () => {
  it('interleaves each phase: core then that phase’s optional swaps, then Overtime', () => {
    const cats = buildExportCategories(build());
    expect(cats.map((c) => c.name)).toEqual([
      'Lane',
      'Lane · swaps',
      'Mid',
      'Mid · swaps',
      'Overtime',
    ]);
    expect(cats[0]).toMatchObject({ name: 'Lane', itemIds: [10, 11] });
    expect(cats[0].optional).toBeUndefined(); // core category
    expect(cats[0].description).toBeTruthy(); // every category gets an always-visible note
    expect(cats[1]).toMatchObject({ name: 'Lane · swaps', optional: true });
  });

  it('splits situational picks by phase and de-dupes against core / earlier rows', () => {
    const cats = buildExportCategories(build());
    expect(cats.find((c) => c.name === 'Lane · swaps')!.itemIds).toEqual([30]); // 11 dropped (core)
    expect(cats.find((c) => c.name === 'Mid · swaps')!.itemIds).toEqual([31]);
    expect(cats.find((c) => c.name === 'Overtime')!.itemIds).toEqual([40]); // 20 dropped (already core)
  });

  it('omits the Overtime category when includeOvertime is false', () => {
    const cats = buildExportCategories(build(), false);
    expect(cats.map((c) => c.name)).not.toContain('Overtime');
  });

  it('gives every category identical coords so the browser lays them out by list order', () => {
    const bytes = encodeHeroBuild(build(), { name: 'x' });
    const hb = parse(parse(bytes).find((x) => x.f === 1)!.v as Uint8Array);
    const cats = all(sub(hb, 10), 1).map((c) => parse(c.v as Uint8Array));
    const xs = cats.map((c) => c.find((f) => f.f === 4)!.v as number);
    const ys = cats.map((c) => c.find((f) => f.f === 5)!.v as number);
    expect(new Set(xs).size).toBe(1); // every category shares one x…
    expect(new Set(ys).size).toBe(1); // …and one y
  });
});

describe('encodeHeroBuild', () => {
  it('encodes a CMsgHeroBuild envelope with hero id, name, timestamps, and categories', () => {
    const ts = 1781884165;
    const bytes = encodeHeroBuild(build(), { name: 'Vibelock — Kelvin', description: 'test', timestamp: ts });

    const env = parse(bytes);
    expect(env.find((x) => x.f === 2)).toBeTruthy(); // envelope metadata present
    const hb = sub(env, 1);

    expect(num(hb, 2)).toBe(12); // hero id
    expect(str(hb, 5)).toBe('Vibelock — Kelvin');
    expect(str(hb, 6)).toBe('test');
    expect(num(hb, 4)).toBe(ts); // last_updated — the "[OUTDATED]" fix
    expect(num(hb, 13)).toBe(ts); // published

    const cats = all(sub(hb, 10), 1).map((c) => parse(c.v as Uint8Array));
    expect(cats.map((c) => str(c, 2))).toEqual([
      'Lane',
      'Lane · swaps',
      'Mid',
      'Mid · swaps',
      'Overtime',
    ]);

    const lane = cats[0];
    expect(all(lane, 1).map((m) => num(parse(m.v as Uint8Array), 1))).toEqual([10, 11]); // mod item ids
    expect(lane.find((x) => x.f === 6)).toBeUndefined(); // core category: not optional
    expect(str(lane, 3)).toBeTruthy(); // category description (always-visible note)

    expect(num(cats[1], 6)).toBe(1); // "Lane · swaps" flagged optional
  });

  it('stamps the author id (f3) so the owner can edit/delete it in-game', () => {
    const hb = parse(
      parse(encodeHeroBuild(build(), { name: 'x', authorId: 48664091 })).find((x) => x.f === 1)!
        .v as Uint8Array,
    );
    expect(num(hb, 3)).toBe(48664091);
  });

  it('defaults the timestamp to now so a fresh export is not "[OUTDATED]"', () => {
    const before = Math.floor(Date.now() / 1000);
    const hb = parse(parse(encodeHeroBuild(build(), { name: 'x' })).find((x) => x.f === 1)!.v as Uint8Array);
    expect(num(hb, 4)).toBeGreaterThanOrEqual(before);
  });
});
