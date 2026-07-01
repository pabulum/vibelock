import { describe, expect, it } from "vitest";
import type {
  BuildItem,
  BuildPhase,
  GeneratedBuild,
  ImbueTarget,
  Item,
} from "../types";
import {
  buildExportCategories,
  encodeHeroBuild,
  itemAnnotation,
} from "./heroBuildExport";

// ---- a tiny protobuf reader, just to assert the encoder's output structure ----
type Field = { f: number; wt: number; v: number | Uint8Array };
function parse(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = () => {
    let r = 0,
      s = 0,
      x: number;
    do {
      x = b[i++];
      r += (x & 0x7f) * 2 ** s;
      s += 7;
    } while (x & 0x80);
    return r;
  };
  while (i < b.length) {
    const tag = varint();
    const f = Math.floor(tag / 8),
      wt = tag % 8;
    if (wt === 0) out.push({ f, wt, v: varint() });
    else if (wt === 2) {
      const len = varint();
      out.push({ f, wt, v: b.subarray(i, i + len) });
      i += len;
    } else if (wt === 5) {
      out.push({
        f,
        wt,
        v: new DataView(b.buffer, b.byteOffset + i, 4).getFloat32(0, true),
      });
      i += 4;
    } else throw new Error(`unsupported wire type ${wt}`);
  }
  return out;
}
const sub = (fields: Field[], f: number) =>
  parse(fields.find((x) => x.f === f)!.v as Uint8Array);
const all = (fields: Field[], f: number) => fields.filter((x) => x.f === f);

// Decode one CurrencyChange { 1: ability_id, 2: currency_type, 3: delta(int32) } with a BigInt
// varint reader so the negative `delta` (a 10-byte two's-complement int32) survives — the float
// reader in parse() loses the high bits past 2^53.
function currencyChange(bytes: Uint8Array): {
  abilityId: number;
  type: number;
  delta: number;
} {
  let i = 0;
  const vb = () => {
    let r = 0n,
      s = 0n,
      x: number;
    do {
      x = bytes[i++];
      r |= BigInt(x & 0x7f) << s;
      s += 7n;
    } while (x & 0x80);
    return r;
  };
  const out: Record<number, bigint> = {};
  while (i < bytes.length) {
    const f = Number(vb() >> 3n); // all three fields are wire type 0
    out[f] = vb();
  }
  return {
    abilityId: Number(out[1]),
    type: Number(out[2]),
    delta: Number(BigInt.asIntN(32, out[3])),
  };
}
const str = (fields: Field[], f: number) =>
  new TextDecoder().decode(fields.find((x) => x.f === f)!.v as Uint8Array);
const num = (fields: Field[], f: number) =>
  fields.find((x) => x.f === f)!.v as number;

// ---- fixtures ----
const item = (id: number): Item => ({
  id,
  name: `Item ${id}`,
  tier: 1,
  cost: 500,
  slot: "weapon",
  componentIds: [],
});
const bi = (id: number): BuildItem => ({
  item: item(id),
  role: "value",
  pickRate: 0.5,
  adjustedWinRate: 0.52,
  rawWinRate: 0.52,
  sample: 100,
  decided: 100,
  avgNetWorthAtBuy: 0,
  why: "",
});
const phase = (
  column: number,
  label: string,
  core: number[],
  situational: number[] = [],
): BuildPhase => ({
  column,
  label,
  timeLabel: `${label} window`,
  targetItems: core.length,
  itemsBought: core.length,
  soulBudget: 0,
  coreSouls: 0,
  categorySouls: { weapon: 0, vitality: 0, spirit: 0 },
  core: core.map(bi),
  situational: situational.map(bi),
});
const build = (): GeneratedBuild => ({
  hero: { id: 12, name: "Kelvin", signatureClasses: [] },
  rankLabel: "Eternus",
  population: { matches: 1000, avgDurationS: 1980, baselineWinRate: 0.5 },
  phases: [phase(0, "Lane", [10, 11], [11, 30]), phase(1, "Mid", [20], [31])],
  standingSlots: 3,
  overtimeBuys: [bi(40), bi(20)], // 20 is already core → should be dropped from Overtime
});

const ids = (cats: ReturnType<typeof buildExportCategories>, name: string) =>
  cats.find((c) => c.name === name)?.mods.map((m) => m.itemId) ?? [];

describe("buildExportCategories", () => {
  it("interleaves each phase: core then that phase’s optional swaps, then Overtime", () => {
    const cats = buildExportCategories(build());
    expect(cats.map((c) => c.name)).toEqual([
      "Lane",
      "Lane · swaps",
      "Mid",
      "Mid · swaps",
      "Overtime",
    ]);
    expect(ids(cats, "Lane")).toEqual([10, 11]);
    expect(cats[0].optional).toBeUndefined(); // core category
    expect(cats[0].description).toBeTruthy(); // every category gets an always-visible note
    expect(cats[1]).toMatchObject({ name: "Lane · swaps", optional: true });
  });

  it("splits situational picks by phase and de-dupes against core / earlier rows", () => {
    const cats = buildExportCategories(build());
    expect(ids(cats, "Lane · swaps")).toEqual([30]); // 11 dropped (core)
    expect(ids(cats, "Mid · swaps")).toEqual([31]);
    expect(ids(cats, "Overtime")).toEqual([40]); // 20 dropped (already core)
  });

  it("drops a situational pick that is core in a later phase (core beats situational)", () => {
    // item 31 is situational in Lane but core in Mid — should appear only in Mid
    const b: GeneratedBuild = {
      ...build(),
      phases: [phase(0, "Lane", [10], [31]), phase(1, "Mid", [31], [])],
      overtimeBuys: [],
    };
    const cats = buildExportCategories(b);
    expect(ids(cats, "Lane · swaps")).not.toContain(31);
    expect(ids(cats, "Mid")).toContain(31);
  });

  it("drops a situational pick that is core in an earlier phase (core beats situational)", () => {
    // item 10 is core in Lane but also appears as situational in Mid
    const b: GeneratedBuild = {
      ...build(),
      phases: [phase(0, "Lane", [10], []), phase(1, "Mid", [20], [10])],
      overtimeBuys: [],
    };
    const cats = buildExportCategories(b);
    expect(ids(cats, "Mid · swaps")).not.toContain(10);
    expect(ids(cats, "Lane")).toContain(10);
  });

  it("annotates every mod with the pick’s edge vs the hero average", () => {
    const cats = buildExportCategories(build());
    for (const cat of cats)
      for (const m of cat.mods)
        expect(m.annotation).toContain("+2.0 pts vs hero avg"); // 52% − 50%
  });

  it("omits the Overtime category when includeOvertime is false", () => {
    const cats = buildExportCategories(build(), false);
    expect(cats.map((c) => c.name)).not.toContain("Overtime");
  });

  it("gives every category identical coords so the browser lays them out by list order", () => {
    const bytes = encodeHeroBuild(build(), { name: "x" });
    const hb = parse(parse(bytes).find((x) => x.f === 1)!.v as Uint8Array);
    const cats = all(sub(hb, 10), 1).map((c) => parse(c.v as Uint8Array));
    const xs = cats.map((c) => c.find((f) => f.f === 4)!.v as number);
    const ys = cats.map((c) => c.find((f) => f.f === 5)!.v as number);
    expect(new Set(xs).size).toBe(1); // every category shares one x…
    expect(new Set(ys).size).toBe(1); // …and one y
  });
});

describe("encodeHeroBuild", () => {
  it("encodes a CMsgHeroBuild envelope with hero id, name, timestamps, and categories", () => {
    const ts = 1781884165;
    const bytes = encodeHeroBuild(build(), {
      name: "Vibelock — Kelvin",
      description: "test",
      timestamp: ts,
    });

    const env = parse(bytes);
    expect(env.find((x) => x.f === 2)).toBeTruthy(); // envelope metadata present
    const hb = sub(env, 1);

    expect(num(hb, 2)).toBe(12); // hero id
    expect(str(hb, 5)).toBe("Vibelock — Kelvin");
    expect(str(hb, 6)).toBe("test");
    expect(num(hb, 4)).toBe(ts); // last_updated — the "[OUTDATED]" fix
    expect(num(hb, 13)).toBe(ts); // published

    const cats = all(sub(hb, 10), 1).map((c) => parse(c.v as Uint8Array));
    expect(cats.map((c) => str(c, 2))).toEqual([
      "Lane",
      "Lane · swaps",
      "Mid",
      "Mid · swaps",
      "Overtime",
    ]);

    const lane = cats[0];
    expect(all(lane, 1).map((m) => num(parse(m.v as Uint8Array), 1))).toEqual([
      10, 11,
    ]); // mod item ids
    expect(lane.find((x) => x.f === 6)).toBeUndefined(); // core category: not optional
    expect(str(lane, 3)).toBeTruthy(); // category description (always-visible note)

    expect(num(cats[1], 6)).toBe(1); // "Lane · swaps" flagged optional
  });

  it("stamps the author id (f3) so the owner can edit/delete it in-game", () => {
    const hb = parse(
      parse(encodeHeroBuild(build(), { name: "x", authorId: 48664091 })).find(
        (x) => x.f === 1,
      )!.v as Uint8Array,
    );
    expect(num(hb, 3)).toBe(48664091);
  });

  it('defaults the timestamp to now so a fresh export is not "[OUTDATED]"', () => {
    const before = Math.floor(Date.now() / 1000);
    const hb = parse(
      parse(encodeHeroBuild(build(), { name: "x" })).find((x) => x.f === 1)!
        .v as Uint8Array,
    );
    expect(num(hb, 4)).toBeGreaterThanOrEqual(before);
  });

  it("encodes each mod’s annotation (f2) and any imbue target (f5)", () => {
    const imbues = new Map<number, ImbueTarget>([
      [
        10,
        {
          ability: { id: 715762406, name: "Frost Nova" },
          colorIndex: 0,
          share: 0.8,
          sample: 12,
        },
      ],
    ]);
    const bytes = encodeHeroBuild(build(), { name: "x", imbues });
    const hb = parse(parse(bytes).find((x) => x.f === 1)!.v as Uint8Array);
    const lane = parse(all(sub(hb, 10), 1)[0].v as Uint8Array);
    const mods = all(lane, 1).map((m) => parse(m.v as Uint8Array));

    expect(str(mods[0], 2)).toContain("+2.0 pts vs hero avg"); // annotation on item 10
    expect(str(mods[0], 2)).toContain("imbue → Frost Nova");
    expect(num(mods[0], 5)).toBe(715762406); // imbue_target_ability_id applied in-game
    expect(mods[1].find((x) => x.f === 5)).toBeUndefined(); // item 11 has no imbue target
  });
});

describe("itemAnnotation", () => {
  const baseline = 0.5;

  it("carries the app’s row tags: win-state, core-by, swap-for, transient note", () => {
    const b: BuildItem = {
      ...bi(10),
      rawWinRate: 0.58, // raw ≫ adjusted (0.52) → win more
      coreLater: "20–30 min",
      coreRush: false,
      swapFor: { id: 11, name: "Burst Fire" },
      transientReason: "builds into Burst Fire",
      buildsToward: { id: 12, name: "Ricochet" }, // suppressed — transient already says where it goes
    };
    const a = itemAnnotation(b, baseline);
    expect(a).toContain("win more");
    expect(a).toContain("core by 20–30 min — buy later");
    expect(a).toContain("swap for Burst Fire");
    expect(a).toContain("builds into Burst Fire");
    expect(a).not.toContain("most build toward");
  });

  it("marks rush-if-ahead picks and comeback picks", () => {
    const b: BuildItem = {
      ...bi(10),
      rawWinRate: 0.48,
      coreLater: "Mid",
      coreRush: true,
    };
    const a = itemAnnotation(b, baseline); // adjusted 0.52 ≫ raw 0.48 → comeback
    expect(a).toContain("comeback");
    expect(a).toContain("core by Mid — rush if ahead");
  });

  it("does not dress up a filler pick as a value pick", () => {
    const a = itemAnnotation({ ...bi(10), role: "filler" }, baseline);
    expect(a).toContain("not a value pick");
    expect(a.replace("not a value pick", "")).not.toContain("value pick");
  });

  it("stays single-line (no real in-game annotation contains a newline)", () => {
    const busy: BuildItem = {
      ...bi(10),
      rawWinRate: 0.58,
      coreLater: "Mid",
      coreRush: true,
      swapFor: { id: 11, name: "Burst Fire" },
      compEdge: 0.02,
    };
    expect(itemAnnotation(busy, baseline, "Frost Nova")).not.toContain("\n");
  });

  it("skips the effect text (already on the in-game card) but keeps a custom rationale", () => {
    const withEffect = { ...bi(10), why: "+30% Weapon Damage" };
    withEffect.item = { ...withEffect.item, effect: "+30% Weapon Damage" };
    expect(itemAnnotation(withEffect, baseline)).not.toContain(
      "+30% Weapon Damage",
    );

    const custom = {
      ...bi(10),
      why: "optional lane sustain — most players grab one",
    };
    expect(itemAnnotation(custom, baseline)).toContain("optional lane sustain");
  });

  it("flags comp strengths and weaknesses when a comp was selected", () => {
    expect(itemAnnotation({ ...bi(10), compEdge: 0.042 }, baseline)).toContain(
      "answers the selected comp (+4.2 pts)",
    );
    expect(
      itemAnnotation(
        { ...bi(10), compEdge: -0.031, weakVsComp: true },
        baseline,
      ),
    ).toContain("weak into the selected comp (-3.1 pts)");
  });
});

describe("skill order (ability_order)", () => {
  // Pull details.2 → ability_order's repeated currency_changes (field 1) out of an encoded build.
  const changesFor = (skillOrder?: number[]) => {
    const bytes = encodeHeroBuild(build(), { name: "x", skillOrder });
    const hb = parse(parse(bytes).find((x) => x.f === 1)!.v as Uint8Array);
    const details = sub(hb, 10);
    const ao = details.find((x) => x.f === 2);
    if (!ao) return null;
    return all(parse(ao.v as Uint8Array), 1).map((c) =>
      currencyChange(c.v as Uint8Array),
    );
  };

  it("omits ability_order entirely when no skill order is given", () => {
    expect(changesFor(undefined)).toBeNull();
    expect(changesFor([])).toBeNull();
  });

  it("encodes each point as an unlock then 1/2/5-cost upgrades, in order", () => {
    // ability 100 invested 4×, ability 200 once — interleaved as the order points were spent.
    const cc = changesFor([100, 200, 100, 100, 100])!;
    expect(cc.map((c) => c.abilityId)).toEqual([100, 200, 100, 100, 100]);
    expect(cc.map((c) => c.type)).toEqual([2, 2, 1, 1, 1]); // first point in each = unlock (type 2)
    expect(cc.map((c) => c.delta)).toEqual([-1, -1, -1, -2, -5]); // 100's four levels cost 1,1,2,5
  });

  it("drops investments past an ability’s 4th point (only four levels exist)", () => {
    const cc = changesFor([7, 7, 7, 7, 7, 7])!; // 6 points in one ability → only 4 survive
    expect(cc).toHaveLength(4);
    expect(cc.map((c) => c.delta)).toEqual([-1, -1, -2, -5]);
  });
});
