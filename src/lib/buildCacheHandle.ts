// Remembering WHICH file is the player's Deadlock build cache, so exporting is a click.
//
// The export itself was never the slow part — picking the file was. `cached_hero_builds.kv3` lives
// six folders deep under a numeric Steam id, and the old flow re-opened a file dialog there on
// every single export. That is the whole reason the feature goes unused: the cost is paid per use
// and it dwarfs the benefit.
//
// A FileSystemFileHandle is structured-clonable, so Chromium can hand the same file back across
// sessions with no dialog at all — subject to a permission re-grant, which a button click supplies.
//
// Deliberately its own tiny database rather than a row in lib/idbCache: that store is the analytics
// response cache, and the crash screen's "clear cached data" empties it. Forgetting the user's
// chosen file because a query payload went bad would be a bad trade.
//
// Everything fails soft. No IndexedDB, no File System Access API, a revoked permission, a moved
// file — every one of them degrades to "pick the file", which is exactly the old behaviour.

const DB_NAME = "vibelock-buildfile";
const STORE = "handles";
const KEY = "cached_hero_builds";
const VERSION = 1;

/** The File System Access bits we call. Not in the default TS DOM lib — `queryPermission` and
 * `requestPermission` are Chromium extensions to FileSystemHandle rather than standard — so we
 * type exactly what we use, the same way ExportPanel types its picker. */
export interface BuildFileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
  }>;
  queryPermission?(opts: {
    mode: "read" | "readwrite";
  }): Promise<PermissionState>;
  requestPermission?(opts: {
    mode: "read" | "readwrite";
  }): Promise<PermissionState>;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Keep this file as the player's build cache. Fire-and-forget: a failed write just means the next
 * export asks again. */
export async function rememberBuildFile(
  handle: BuildFileHandle,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(handle, KEY);
  } catch {
    /* a handle this browser can't clone — the picker path still works */
  }
}

/** The remembered file, or null. Does NOT check permission — see {@link ensureWritable}, which has
 * to run inside a user gesture and so belongs at the click, not at load. */
export async function recallBuildFile(): Promise<BuildFileHandle | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as BuildFileHandle) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function forgetBuildFile(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    db.transaction(STORE, "readwrite").objectStore(STORE).delete(KEY);
  } catch {
    /* nothing to do — the caller re-picks */
  }
}

/**
 * Whether we may write to `handle` right now, asking the user if the grant has lapsed.
 *
 * MUST be called from a user gesture: `requestPermission` shows a browser prompt and Chromium
 * rejects it outside one. That is why the export button calls this rather than the panel doing it
 * on mount — a silent prompt-on-open would be denied and would burn the remembered handle.
 *
 * A browser without these methods (they're non-standard) is treated as granted: it either lets the
 * write through or throws on `createWritable`, and the caller handles that the same way.
 */
export async function ensureWritable(
  handle: BuildFileHandle,
): Promise<boolean> {
  try {
    if (!handle.queryPermission || !handle.requestPermission) return true;
    const opts = { mode: "readwrite" } as const;
    if ((await handle.queryPermission(opts)) === "granted") return true;
    return (await handle.requestPermission(opts)) === "granted";
  } catch {
    return false;
  }
}
