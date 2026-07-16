// The app-wide TanStack Query client + its localStorage persister. This replaces the old
// hand-rolled caches in api/deadlock.ts: the session-scoped analytics promise-cache is now the
// in-memory query cache (URL-keyed queries, staleTime Infinity = "fetch once per session"), and
// the 24h localStorage asset cache is persistQueryClient, filtered to the `assets` key prefix so
// multi-megabyte analytics payloads (item permutations, match metadata) never touch localStorage.
//
// Module-scoped (not created in a component) because api/deadlock.ts's fetchers call
// `queryClient.fetchQuery` directly — that's what dedupes two composed queries asking for the
// same underlying URL, exactly like the old URL-keyed promise cache did.

import { QueryClient } from "@tanstack/react-query";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { PersistQueryClientOptions } from "@tanstack/react-query-persist-client";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // getJson (api/deadlock.ts) does its own 429/5xx backoff with the server's retry hints,
      // and the match rate family must NEVER retry — so the query layer never retries anything.
      retry: false,
      // Analytics queries recompute server-side but are treated as stable within a session
      // (the old promise cache never expired); a dep change makes a new key, not a refetch.
      staleTime: Infinity,
      gcTime: 60 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

// The async persister is the maintained one (the sync variant is deprecated); it takes
// localStorage directly — its storage interface accepts plain synchronous returns.
// `typeof window` guard: type-only import chains from the node-side unit suites must not touch
// browser globals if a runtime import ever sneaks in.
const persister = createAsyncStoragePersister({
  storage: typeof window !== "undefined" ? window.localStorage : undefined,
  key: "vibelock-query-cache",
});

/** Persist only the processed asset queries (heroes/items/abilities/patches — the `assets` key
 * prefix set in api/deadlock.ts). They're small, change rarely (24h staleTime), and a stale copy
 * is a feature: the patches feed degrades to "last good list" when the API is down. maxAge is the
 * outer bound on how stale that fallback may get. */
export const persistOptions: Omit<PersistQueryClientOptions, "queryClient"> = {
  persister,
  maxAge: 7 * 24 * 60 * 60 * 1000,
  buster: "v1",
  dehydrateOptions: {
    shouldDehydrateQuery: (query) =>
      query.state.status === "success" && query.queryKey[0] === "assets",
  },
};
