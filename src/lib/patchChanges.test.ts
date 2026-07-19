import { describe, expect, it } from "vitest";
import { touchedItems } from "./patchChanges";
import type { Item } from "../types";

const item = (id: number, name: string): Item =>
  ({ id, name, tier: 1, cost: 0, componentIds: [] }) as unknown as Item;

const items = new Map<number, Item>(
  [
    item(1, "Toxic Bullets"),
    item(2, "Extra Health"),
    item(3, "Scourge"),
    item(4, "Bullet Lifesteal"),
    item(5, "upgrade_clip_size_fixed"), // class-name leftover, never in notes
    item(6, "Mystic Shot"),
  ].map((i) => [i.id, i]),
);

const notes = `[ Weapon Items ]
- Toxic Bullets: Bleed damage increased from 1.7% to 1.9%
- Scourge: Max Health DPS reduced from 3.5% to 2.6%
- Mystic Shot: Cooldown increased from 8s to 9s
Rift Troopers spawn with 100% extra health and damage
- Haze: Smoke Bomb T3 increased from +40% Bullet Lifesteal to +50%`;

describe("touchedItems", () => {
  it("tags items that are the subject of a change line", () => {
    const t = touchedItems(notes, items);
    expect(t.has(1)).toBe(true); // Toxic Bullets
    expect(t.has(3)).toBe(true); // Scourge
    expect(t.has(6)).toBe(true); // Mystic Shot
  });

  it("does not tag items only mentioned mid-sentence (prose / hero changes)", () => {
    const t = touchedItems(notes, items);
    expect(t.has(2)).toBe(false); // "extra health" in Rift Trooper prose, not a subject
    expect(t.has(4)).toBe(false); // Bullet Lifesteal inside a Haze ability line
  });

  it("flattens html/bbcode and handles empty notes", () => {
    expect([...touchedItems("<div>- Scourge: nerfed</div>", items)]).toEqual([3]);
    expect(touchedItems("", items).size).toBe(0);
  });
});
