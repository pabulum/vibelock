// Injects generated builds into a player's Deadlock build cache (`cached_hero_builds.kv3`) entirely
// in the browser — no backend, no upload of save files to a server.
//
// The cache is KV3 *v5 binary* (block-compressed); lib/kv3 reads it and re-emits the tree as *text*
// KV3 with our builds' protobuf blobs (see {@link encodeHeroBuild}) in the `Favorites` bucket. The
// game reads text fine (verified in-game) and re-saves binary on next launch, so it round-trips.
// (This used to run the Python `keyvalues3` reader under Pyodide — ~12 MB from three CDNs on first
// use; kv3.test.ts pins the TS port byte-for-byte against that implementation.)

import { parseKv3, encodeTextKv3 } from "./kv3";
import { isOurBuildFor, readHeroBuildInfo } from "./heroBuildExport";

/** What an injection did, so the panel can say "updated 3" rather than implying it added them. */
export interface InjectResult {
  bytes: Uint8Array;
  /** Our previous build for that hero, overwritten in place. */
  replaced: number;
  /** Heroes we had no build for yet. */
  added: number;
}

/**
 * Inject one build into a cache file's `Favorites`, returning the modified file as text-KV3 bytes.
 * `fileBytes` is the user's `cached_hero_builds.kv3`; `buildBlob` is {@link encodeHeroBuild}'s
 * output. Pure data-in/data-out — the caller handles picking/writing the file.
 */
export function injectBuildIntoCache(
  fileBytes: Uint8Array,
  buildBlob: Uint8Array,
): Uint8Array {
  return injectBuildsIntoCache(fileBytes, [buildBlob]).bytes;
}

/**
 * Inject several builds in one pass — one per hero you queue with, written in a single edit.
 *
 * This has to be one call rather than a loop over {@link injectBuildIntoCache}: that function reads
 * *binary* KV3 and emits *text*, so feeding its output back in would fail on the second build.
 *
 * Each incoming build REPLACES our previous build for the same hero, in place, keeping its position
 * in the list. Appending unconditionally is what the first version did, and it meant every re-export
 * left another "Vibelock — Paradox" behind for the player to delete by hand — after four sessions the
 * in-game browser is mostly stale copies of one build. Identity is hero id plus our name prefix
 * (lib/heroBuildExport), so a rank or archetype change still replaces, and builds the player made
 * themselves are never touched. An entry we can't parse is left exactly where it is.
 */
export function injectBuildsIntoCache(
  fileBytes: Uint8Array,
  buildBlobs: Uint8Array[],
): InjectResult {
  const root = parseKv3(fileBytes);
  const favorites = root instanceof Map ? root.get("Favorites") : undefined;
  if (!Array.isArray(favorites))
    throw new Error(
      "No Favorites list in this file — is it really cached_hero_builds.kv3?",
    );

  // Read the existing list once. `null` for anything that isn't a parseable envelope of ours, which
  // covers the player's own builds and any entry shaped in a way we don't recognise.
  const existing = favorites.map((entry) =>
    entry instanceof Uint8Array ? readHeroBuildInfo(entry) : null,
  );

  let replaced = 0;
  let added = 0;
  for (const blob of buildBlobs) {
    const info = readHeroBuildInfo(blob);
    // BOTH sides have to be ours before anything is overwritten. Testing only the existing entry
    // would let a blob that isn't a Vibelock build displace one that is, purely because they share a
    // hero. (A blob we just encoded and can't read back is a bug rather than an odd user file — but
    // the build is still worth writing, so it falls through to appending rather than being dropped.)
    const at =
      info === null || !isOurBuildFor(info, info.heroId)
        ? -1
        : existing.findIndex((e) => isOurBuildFor(e, info.heroId));
    if (at >= 0) {
      favorites[at] = blob;
      existing[at] = info;
      replaced++;
    } else {
      favorites.push(blob);
      existing.push(info);
      added++;
    }
  }
  return {
    bytes: new TextEncoder().encode(encodeTextKv3(root)),
    replaced,
    added,
  };
}
