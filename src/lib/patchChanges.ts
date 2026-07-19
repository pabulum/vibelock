// The set of buildable items a patch's notes explicitly changed — the causal companion to the
// win-rate / adoption movers in lib/patchMovers, which see that an item MOVED but not whether the
// patch is *why*. A mover that's also in this set is a confident causal mover; a mover absent from
// it more likely rode a meta shift around it (a confound to distrust).
//
// Deliberately conservative — high precision over recall — because a *false* causal tag is worse
// than a miss, and (per the WPA-era spike) the buff/nerf *direction* barely predicts the win-rate
// outcome, so the only signal worth extracting is "touched at all". We therefore count an item only
// when it is the SUBJECT of a change line ("- Toxic Bullets: …" or a "[ … ]" header), never a
// mid-sentence mention: "Rift Troopers spawn with 100% extra health" must not tag Extra Health, and
// "Haze: Smoke Bomb now grants +50% Bullet Lifesteal" is a hero change, not a Bullet Lifesteal one.
//
// Text source is the Steam-feed notes carried on the selected Patch (see api/deadlock.ts). bbcode/
// html is flattened to plain lines first.
import type { Item } from "../types";

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(li|p|div|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/gi, " ");
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Ids of the items whose own stats this patch's notes change, as bullet/header subjects. */
export function touchedItems(
  notes: string,
  items: Map<number, Item>,
): Set<number> {
  const out = new Set<number>();
  if (!notes) return out;
  const lines = stripHtml(notes)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // Match the name only at the start of a line, after optional bullet markers / bracket, and only
  // as a whole token. Class-name leftovers (e.g. "upgrade_clip_size_fixed") never appear in notes.
  const subjects = [...items.values()]
    .filter((i) => i.name && !/^[a-z_]+$/.test(i.name))
    .map((i) => ({
      id: i.id,
      re: new RegExp(`^[-*\\s\\[]*${esc(i.name)}(?=[^\\w]|$)`, "i"),
    }));
  for (const line of lines)
    for (const s of subjects) if (s.re.test(line)) out.add(s.id);
  return out;
}
