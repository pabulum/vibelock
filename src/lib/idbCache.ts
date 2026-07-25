// A durable cache for analytics responses, in IndexedDB.
//
// The query cache already treats an analytics response as stable for the whole session
// (staleTime: Infinity), but it lives in memory — so a reload, a return visit, or a shared link
// opened twice re-pays the full fan-out: ~3 MB and ~10s for one hero at one rank on one patch. This
// makes that stability survive the tab.
//
// Deliberately NOT persistQueryClient (which is what queryClient.ts uses for the small asset
// queries): that dehydrates the *entire* cache to one record on a throttle, which is fine for a few
// hundred KB of heroes and items and pathological for tens of MB of flow payloads. This is per-URL
// instead — one record per response, read on miss, written on success, evicted least-recently-used
// when the store outgrows its budget.
//
// Everything here fails soft. No IndexedDB (private mode, a locked-down profile), a quota refusal,
// a corrupt store — all of it degrades to "no persistent cache", which is exactly today's
// behaviour. Nothing in the app awaits a write.

const DB_NAME = "vibelock-analytics";
const STORE = "responses";
// Bump to invalidate every stored response — e.g. when a Valibot schema starts reading a field the
// stored bodies were projected without.
const VERSION = 1;

/** How long a stored response may stand in for a fresh one. Analytics endpoints recompute as
 * matches accumulate, so this is a "same sitting" window rather than a correctness bound; the
 * patch/rank/window are all in the URL, so a *different* slice is a different key, never a stale
 * hit. */
const TTL_MS = 6 * 60 * 60 * 1000;

/** Budget for the whole store. Roughly a dozen hero/rank/patch cells at observed payload sizes —
 * enough to make "flick between my heroes" free without treating the user's disk as ours. */
const MAX_BYTES = 40 * 1024 * 1024;

interface Entry {
  url: string;
  body: unknown;
  bytes: number;
  /** When it was written — the TTL is measured from here. */
  at: number;
  /** When it was last read — eviction order. */
  used: number;
}

let enabled = true;
let dbPromise: Promise<IDBDatabase | null> | null = null;

/** Turn the persistent layer off. The browser smoke tests call this for the same reason they clear
 * localStorage: a run must exercise the fetch path, not a previous run's copy. */
export function setAnalyticsCacheEnabled(on: boolean): void {
  enabled = on;
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      // A version bump drops the old store wholesale: the records are a cache, never a source of
      // truth, so re-fetching is always the correct migration.
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE, { keyPath: "url" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore | null {
  try {
    return db.transaction(STORE, mode).objectStore(STORE);
  } catch {
    return null;
  }
}

/** The stored response for `url`, or undefined on a miss, an expired entry, or any failure. */
export async function cacheGet(url: string): Promise<unknown | undefined> {
  if (!enabled) return undefined;
  const db = await openDb();
  if (!db) return undefined;
  const entry = await new Promise<Entry | undefined>((resolve) => {
    const store = tx(db, "readonly");
    if (!store) return resolve(undefined);
    const req = store.get(url);
    req.onsuccess = () => resolve(req.result as Entry | undefined);
    req.onerror = () => resolve(undefined);
  });
  if (!entry) return undefined;
  if (Date.now() - entry.at > TTL_MS) {
    void del(url);
    return undefined;
  }
  // Touch for LRU. Fire-and-forget: a lost touch only costs eviction accuracy.
  void touch(db, entry);
  return entry.body;
}

/** Store a response. Fire-and-forget by design — no caller waits for the disk. */
export function cachePut(url: string, body: unknown, bytes: number): void {
  if (!enabled) return;
  void (async () => {
    const db = await openDb();
    if (!db) return;
    const store = tx(db, "readwrite");
    if (!store) return;
    const now = Date.now();
    try {
      store.put({ url, body, bytes, at: now, used: now } satisfies Entry);
    } catch {
      return; // structured-clone refusal, quota, whatever — the fetch path still worked
    }
    void evict(db);
  })();
}

function touch(db: IDBDatabase, entry: Entry): Promise<void> {
  return new Promise((resolve) => {
    const store = tx(db, "readwrite");
    if (!store) return resolve();
    try {
      store.put({ ...entry, used: Date.now() });
    } catch {
      /* ignore */
    }
    resolve();
  });
}

function del(url: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve) => {
        const store = db && tx(db, "readwrite");
        if (store) store.delete(url);
        resolve();
      }),
  );
}

/** Drop least-recently-used entries until the store is back inside its budget. */
function evict(db: IDBDatabase): Promise<void> {
  return new Promise((resolve) => {
    const store = tx(db, "readonly");
    if (!store) return resolve();
    const req = store.getAll();
    req.onerror = () => resolve();
    req.onsuccess = () => {
      const all = (req.result as Entry[]) ?? [];
      let total = all.reduce((a, e) => a + e.bytes, 0);
      if (total <= MAX_BYTES) return resolve();
      const write = tx(db, "readwrite");
      if (!write) return resolve();
      for (const e of [...all].sort((a, b) => a.used - b.used)) {
        if (total <= MAX_BYTES) break;
        write.delete(e.url);
        total -= e.bytes;
      }
      resolve();
    };
  });
}
