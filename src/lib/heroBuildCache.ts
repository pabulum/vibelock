// Injects a generated build into a player's Deadlock build cache (`cached_hero_builds.kv3`) entirely
// in the browser — no backend, no upload of save files to a server.
//
// The cache is KV3 *v5 binary* (block-compressed); lib/kv3 reads it and re-emits the tree as *text*
// KV3 with our build's protobuf blob (see {@link encodeHeroBuild}) appended to the `Favorites`
// bucket. The game reads text fine (verified in-game) and re-saves binary on next launch, so it
// round-trips. (This used to run the Python `keyvalues3` reader under Pyodide — ~12 MB from three
// CDNs on first use; kv3.test.ts pins the TS port byte-for-byte against that implementation.)

import { parseBinaryKv3, encodeTextKv3 } from "./kv3";

/**
 * Inject one build into a cache file's `Favorites`, returning the modified file as text-KV3 bytes.
 * `fileBytes` is the user's `cached_hero_builds.kv3`; `buildBlob` is {@link encodeHeroBuild}'s
 * output. Pure data-in/data-out — the caller handles picking/writing the file.
 */
export function injectBuildIntoCache(
  fileBytes: Uint8Array,
  buildBlob: Uint8Array,
): Uint8Array {
  const root = parseBinaryKv3(fileBytes);
  const favorites = root instanceof Map ? root.get("Favorites") : undefined;
  if (!Array.isArray(favorites))
    throw new Error(
      "No Favorites list in this file — is it really cached_hero_builds.kv3?",
    );
  favorites.push(buildBlob);
  return new TextEncoder().encode(encodeTextKv3(root));
}
