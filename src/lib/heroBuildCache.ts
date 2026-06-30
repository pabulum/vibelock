// Injects a generated build into a player's Deadlock build cache (`cached_hero_builds.kv3`) entirely
// in the browser — no backend, no upload of save files to a server.
//
// The cache is KV3 *v5 binary* (block-compressed), which there's no robust JS reader for; the proven
// reader is the pure-Python `keyvalues3`. So we run it under Pyodide (CPython in WASM), lazy-loaded
// from the CDN only when the export panel is first used. We read the user's file, append our build's
// protobuf blob (see {@link encodeHeroBuild}) to its `Favorites` bucket, and re-emit as *text* KV3 —
// the game reads text fine (verified in-game) and re-saves binary on next launch, so it round-trips.
//
// Trade-off (see README / export panel): this loads ~10 MB of Pyodide + wheels on first use and needs
// a CSP that allows the CDN + `wasm-unsafe-eval`. A future "diet" would port just the v5 *reader* to
// TS (the text writer is trivial), dropping Pyodide entirely.

const PYODIDE_VERSION = '314.0.1';
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

// Minimal shape of the bits of Pyodide we touch (the package ships its own types, but it's loaded
// dynamically from the CDN, so we type the surface we use rather than depend on the npm package).
interface PyodideFS {
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
}
interface PyMicropip {
  install(pkg: string): Promise<void>;
}
interface Pyodide {
  FS: PyodideFS;
  runPython(code: string): unknown;
  pyimport(name: string): PyMicropip;
  loadPackage(name: string): Promise<void>;
}
interface PyodideModule {
  loadPyodide(opts: { indexURL: string }): Promise<Pyodide>;
}

let runtime: Promise<Pyodide> | null = null;

/** Lazy-load Pyodide (from the CDN) and install `keyvalues3`. Cached, so the ~10 MB load happens
 * once per session. `onProgress` reports the coarse phase for the panel's status line. */
export function loadKv3Runtime(onProgress?: (phase: string) => void): Promise<Pyodide> {
  if (!runtime) {
    runtime = (async () => {
      onProgress?.('Loading the KV3 engine (~10 MB, first time only)…');
      const mod: PyodideModule = await import(/* @vite-ignore */ `${PYODIDE_CDN}pyodide.mjs`);
      const py = await mod.loadPyodide({ indexURL: PYODIDE_CDN });
      onProgress?.('Loading the build-file reader…');
      await py.loadPackage('micropip');
      await py.pyimport('micropip').install('keyvalues3');
      return py;
    })().catch((e) => {
      runtime = null; // let a later attempt retry rather than wedge on a transient failure
      throw e;
    });
  }
  return runtime;
}

// Read the cache, append our build blob to Favorites, write it back as text KV3. `f.format` is reset
// to FORMAT_GENERIC because reading a v5 ("binarynew") file leaves it as a bare int, which the text
// writer chokes on; the text encoding is what the game accepts.
const GLUE = `
import keyvalues3 as kv3
def _inject(in_path, blob_path, out_path):
    f = kv3.read(in_path)
    f.format = kv3.FORMAT_GENERIC
    with open(blob_path, 'rb') as fh:
        blob = fh.read()
    f.value['Favorites'].append(blob)
    kv3.write(f, out_path, encoding=kv3.ENCODING_TEXT)
`;

/**
 * Inject one build into a cache file's `Favorites`, returning the modified file as text-KV3 bytes.
 * `fileBytes` is the user's `cached_hero_builds.kv3`; `buildBlob` is {@link encodeHeroBuild}'s output.
 * Pure data-in/data-out — the caller handles picking/writing the file.
 */
export async function injectBuildIntoCache(
  fileBytes: Uint8Array,
  buildBlob: Uint8Array,
  onProgress?: (phase: string) => void,
): Promise<Uint8Array> {
  const py = await loadKv3Runtime(onProgress);
  onProgress?.('Adding your build…');
  py.FS.writeFile('/in.kv3', fileBytes);
  py.FS.writeFile('/build.bin', buildBlob);
  py.runPython(GLUE);
  py.runPython(`_inject('/in.kv3', '/build.bin', '/out.kv3')`);
  return py.FS.readFile('/out.kv3').slice(); // copy out of the WASM heap
}
