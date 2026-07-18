// Static game assets — heroes, items, patches, abilities — as persisted queries (see
// api/deadlock.ts + queryClient.ts), plus the id-keyed lookup maps every feature reads.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  abilityListQueryOptions,
  heroesQueryOptions,
  itemListQueryOptions,
  patchesQueryOptions,
} from "../api/deadlock";
import type { Hero, Patch } from "../types";

// Stable empty fallbacks for asset queries that haven't resolved — fresh [] per render would
// re-fire every effect and memo that lists them as a dep.
const NO_HEROES: Hero[] = [];
const NO_PATCHES: Patch[] = [];

export function useAssets() {
  const heroesQ = useQuery(heroesQueryOptions);
  const itemListQ = useQuery(itemListQueryOptions);
  const patchesQ = useQuery(patchesQueryOptions);
  const abilitiesQ = useQuery(abilityListQueryOptions);
  const heroes = heroesQ.data ?? NO_HEROES;
  const patches = patchesQ.data ?? NO_PATCHES;
  const items = useMemo(
    () =>
      itemListQ.data ? new Map(itemListQ.data.map((i) => [i.id, i])) : null,
    [itemListQ.data],
  );
  const abilities = useMemo(
    () =>
      abilitiesQ.data ? new Map(abilitiesQ.data.map((a) => [a.id, a])) : null,
    [abilitiesQ.data],
  );
  // Restored-from-storage patches count as ready; only a truly cold load holds the
  // patch-windowed queries until the feed answers (or degrades to []).
  const patchesReady = !patchesQ.isPending;

  return {
    heroesQ,
    itemListQ,
    patchesQ,
    abilitiesQ,
    heroes,
    patches,
    items,
    abilities,
    patchesReady,
  };
}
