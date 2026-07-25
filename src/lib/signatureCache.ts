// Remembers which items were a hero's archetype signatures last time, so the flows conditioned on
// them can be fetched *alongside* the base flow instead of strictly after it.
//
// Why this exists: pickSignatures reads the signature items out of the base flow response, so the
// two archetype flows can't be requested until it lands. Measured, that's the dominant cost of a
// hero switch — a ~3s base round trip, then a ~6s pair of conditioned round trips, ~64% of the wall
// clock spent waiting on a dependency that is almost always predictable.
//
// It is predictable because a signature is just "the most-bought T3+ weapon / spirit item for this
// hero", which barely moves. Measured across two heroes: identical across patches, and identical
// across ranks for one of them but not the other (Infernus swaps both between Archon+ and Eternus).
// So the key is hero + rank band, and the guess is *verified* against the real pickSignatures once
// the base flow arrives — a miss costs two wasted requests and falls back to exactly today's path,
// never a wrong build.

import type { Signatures } from "./archetypes";

const KEY = "vibelock-signatures";
/** Keep the map small and bounded; entries are two ints, so this is a few KB at most. */
const MAX_ENTRIES = 400;

type Stored = Record<string, [gun: number | null, spirit: number | null]>;

function cellKey(
  heroId: number,
  minBadge: number,
  maxBadge: number | undefined,
): string {
  return `${heroId}:${minBadge}:${maxBadge ?? ""}`;
}

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Stored) : {};
  } catch {
    return {}; // unavailable or corrupt — the guess is optional, never load-bearing
  }
}

/** The signatures this hero/rank had last time, or null if we've never resolved it. */
export function guessSignatures(
  heroId: number,
  minBadge: number,
  maxBadge?: number,
): Signatures | null {
  const hit = read()[cellKey(heroId, minBadge, maxBadge)];
  if (!hit) return null;
  return { gun: hit[0] ?? undefined, spirit: hit[1] ?? undefined };
}

/** Record what the base flow actually resolved to, for next time. */
export function rememberSignatures(
  heroId: number,
  minBadge: number,
  maxBadge: number | undefined,
  sig: Signatures,
): void {
  try {
    const all = read();
    all[cellKey(heroId, minBadge, maxBadge)] = [
      sig.gun ?? null,
      sig.spirit ?? null,
    ];
    // Cheap bound: once it's oversized, drop the oldest insertions (object key order).
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES)))
      delete all[k];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage full or unavailable — we just guess again next time */
  }
}

/** Did the guess hold? Both slots must match: a half-right guess still needs the other flow, and
 * mixing a guessed flow with a freshly-fetched one is where a subtly wrong build would come from. */
export function signaturesMatch(a: Signatures | null, b: Signatures): boolean {
  return !!a && a.gun === b.gun && a.spirit === b.spirit;
}
