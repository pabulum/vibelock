// The build fan-out as a plain async function: everything one hero's build needs, fetched and
// assembled, with no React around it.
//
// This used to be the body of useBuildData's queryFn, which meant a build could only be produced
// for the hero currently on screen. The batch export (several of your heroes written into the game's
// build cache in one pass) needs the same work for a hero nobody is looking at, and a second
// implementation of a twelve-request fan-out with its own blend rules would drift from this one
// within a patch. So the fetching lives here and the hook is what's left: query keys, cancellation,
// and the derived state the render reads.

import {
  getHeroLadderStats,
  getItemFlowStats,
  getItemPermutationStats,
  getItemStats,
  type TimeWindow,
} from "../api/deadlock";
import { assembleArchetypes, pickSignatures } from "./archetypes";
import {
  guessSignatures,
  rememberSignatures,
  signaturesMatch,
} from "./signatureCache";
import { blendFlow } from "./patchBlend";
import { findAdoptionMovers, findPatchMovers } from "./patchMovers";
import { touchedItems } from "./patchChanges";
import { buildJointGamesLookup } from "./pairs";
import { buildSynergyLookup, singleRecordsFromFlow } from "./synergy";
import type {
  ArchetypeSet,
  Hero,
  HeroLadderStat,
  Item,
  ItemStat,
} from "../types";
import type { AdoptionMover, PatchMover } from "./patchMovers";
import type { ItemFlowStats } from "../types";

/** The rank + patch slice a build is generated from, plus the generator's options. */
export interface BuildSlice {
  minBadge: number;
  maxBadge?: number;
  dataWindow: TimeWindow;
  priorWin: TimeWindow;
  /** The movers' comparator window (lib/patchWindows) — as much time before the patch as it has
   * run for. Separate from `priorWin`, which is the blend's 30-day borrow. */
  moversWin: TimeWindow;
  canBackfill: boolean;
  lineAware: boolean;
  /** Notes body of the selected patch, for the movers' causal tag (lib/patchChanges). */
  patchNotes?: string;
}

export interface BuildSetResult {
  set: ArchetypeSet;
  movers: PatchMover[] | null;
  adoption: AdoptionMover[] | null;
  flows: {
    all: ItemFlowStats;
    gun: ItemFlowStats | undefined;
    spirit: ItemFlowStats | undefined;
  };
  /** Share of the build's win-rate evidence borrowed from the pre-patch window, or null with
   * backfill off. ~0.85 the day after a patch, fading to ~0 as it matures. */
  backfillShare: number | null;
}

/**
 * Fetch and assemble one hero's archetype set. Every request rides the shared URL cache in
 * api/deadlock, so a hero already on screen (or already hovered — see lib/prefetch) costs nothing
 * to ask for again.
 */
export async function fetchBuildSet(opts: {
  hero: Hero;
  items: Map<number, Item>;
  rankLabel: string;
  slice: BuildSlice;
  signal?: AbortSignal;
}): Promise<BuildSetResult> {
  const { hero: h, items: itemMap, rankLabel, slice, signal } = opts;
  const {
    minBadge,
    maxBadge,
    dataWindow,
    priorWin,
    moversWin,
    canBackfill,
    lineAware,
    patchNotes,
  } = slice;

  // With backfill on (default), every flow is fetched twice — the selected patch and the month
  // before it — and blended (lib/patchBlend): the pre-patch window backfills a young patch as a
  // capped, drift-discounted prior, so a day-one build is complete instead of starved by the
  // support/significance gates. The blend self-anneals, so on a mature patch the prior
  // contributes ~nothing. The fresh fetch drops the server-side min_matches floor (default 100)
  // to 10 — on day one most nodes are below 100 matches, and the client-side gates run on the
  // blended effective sample anyway. Backfill off = the selected window raw, single fetch.
  const flowFor = (includeItemIds?: number[]) =>
    canBackfill
      ? Promise.all([
          getItemFlowStats({
            heroId: h.id,
            minBadge,
            maxBadge,
            ...dataWindow,
            minMatches: 10,
            includeItemIds,
            signal,
          }),
          getItemFlowStats({
            heroId: h.id,
            minBadge,
            maxBadge,
            ...priorWin,
            includeItemIds,
            signal,
          }),
        ]).then(([f, q]) => blendFlow(f, q))
      : getItemFlowStats({
          heroId: h.id,
          minBadge,
          maxBadge,
          ...dataWindow,
          includeItemIds,
          signal,
        }).then((f) => ({
          flow: f,
          borrowedShare: 0,
          patchK: 0,
          freshGames: f.baseline.matches,
          priorGames: 0,
        }));

  // Speculative archetype flows. The conditioned flows below normally can't start until the base
  // flow lands (their include_item_ids come out of it), which measured as ~64% of a hero switch
  // spent on a strictly serial second round trip. Signatures barely move for a given hero and rank,
  // so fire last-known ones NOW, in parallel with everything else, and verify against the real pick
  // once the base flow arrives (lib/signatureCache). A miss just falls through to the original
  // fetch — two wasted requests, never a wrong build.
  const guess = guessSignatures(h.id, minBadge, maxBadge);
  const guessed = guess
    ? {
        gun: guess.gun ? flowFor([guess.gun]) : undefined,
        spirit: guess.spirit ? flowFor([guess.spirit]) : undefined,
      }
    : null;
  // A guess that turns out wrong must not surface as an unhandled rejection.
  guessed?.gun?.catch(() => {});
  guessed?.spirit?.catch(() => {});

  // Base population + buy times (for buy-order) + item-pair permutation stats, in parallel. The
  // permutation payload is large but overlaps the flow fetches below; a failure is non-fatal (the
  // build just ranks on win rate alone and the synergy panel hides). Buy/sell times come from both
  // windows too: per item, prefer the fresh average once it has a steady sample, else keep the
  // pre-patch one (timing barely drifts across patches; ordering stability wins). Permutation stats
  // span both windows in ONE fetch — synergy is a centered, shrunk tiebreak, so the mixed window is
  // fine and the payload is too big to double.
  const [
    baseBlend,
    statsFresh,
    statsPrior,
    statsPrev,
    ladderFresh,
    ladderPrev,
    permRows,
  ] = await Promise.all([
    flowFor(),
    getItemStats({
      heroId: h.id,
      minBadge,
      maxBadge,
      ...dataWindow,
      ...(canBackfill ? { minMatches: 5 } : {}),
      signal,
    }),
    canBackfill
      ? getItemStats({
          heroId: h.id,
          minBadge,
          maxBadge,
          ...priorWin,
          signal,
        })
      : Promise.resolve([] as ItemStat[]),
    // The movers' comparator window + the hero's own record in both windows. These are the movers'
    // three extra requests: the blend's 30-day prior can't answer "did this patch change it" (it's
    // a monthly mean), and without the hero's per-window baseline a hero nerf reads as its entire
    // item pool moving. The two ladder payloads are one row per hero — the cost that matters here
    // is the item-stats slice.
    canBackfill
      ? getItemStats({
          heroId: h.id,
          minBadge,
          maxBadge,
          ...moversWin,
          minMatches: 5,
          signal,
        })
      : Promise.resolve([] as ItemStat[]),
    canBackfill
      ? getHeroLadderStats({ minBadge, maxBadge, ...dataWindow, signal })
      : Promise.resolve([] as HeroLadderStat[]),
    canBackfill
      ? getHeroLadderStats({ minBadge, maxBadge, ...moversWin, signal })
      : Promise.resolve([] as HeroLadderStat[]),
    getItemPermutationStats({
      heroId: h.id,
      minBadge,
      maxBadge,
      signal,
      ...(canBackfill
        ? {
            minUnixTimestamp: priorWin.minUnixTimestamp,
            maxUnixTimestamp: dataWindow.maxUnixTimestamp,
          }
        : dataWindow),
    }).catch(() => null),
  ]);
  const base = baseBlend.flow;
  // Items the patch's notes actually changed — the causal tag that tells a real patch mover from
  // one riding a meta shift (lib/patchChanges). Null when the feed carried no notes.
  const touched =
    canBackfill && patchNotes ? touchedItems(patchNotes, itemMap) : null;
  // The hero's own record in each movers window, from one endpoint so the two are comparable.
  // Rates only, never the match counts: on short historical windows this endpoint's counts disagree
  // with item-stats and flow-stats (which agree with each other) by as much as 60%, while its win
  // rates track them to within a few tenths of a point. See lib/patchMovers for what dividing by
  // the wrong count does to a pick rate.
  const heroRecord = (rows: HeroLadderStat[]) => {
    const row = rows.find((r) => r.hero_id === h.id);
    const decided = row ? row.wins + row.losses : 0;
    return { rate: decided > 0 ? row!.wins / decided : 0, decided };
  };
  const heroFresh = heroRecord(ladderFresh);
  const heroPrev = heroRecord(ladderPrev);
  const heroWindows = {
    freshRate: heroFresh.rate,
    freshDecided: heroFresh.decided,
    prevRate: heroPrev.rate,
    prevDecided: heroPrev.decided,
  };
  // Movers compare the RAW windows (blending them first would test the prior against itself), and
  // every item is measured against the hero's shift over the same pair — an item "moved" this patch
  // only if it moved relative to its hero (see lib/patchMovers).
  const movers = canBackfill
    ? findPatchMovers(statsFresh, statsPrev, itemMap, heroWindows).map((m) => ({
        ...m,
        changed: touched?.has(m.item.id) ?? false,
      }))
    : null;
  const BUY_TIME_MIN_MATCHES = 40;
  const timeStats = new Map(statsPrior.map((s) => [s.item_id, s]));
  for (const s of statsFresh)
    if (s.matches >= BUY_TIME_MIN_MATCHES || !timeStats.has(s.item_id))
      timeStats.set(s.item_id, s);
  const buyTimes = new Map(
    [...timeStats.values()].map((s) => [s.item_id, s.avg_buy_time_s]),
  );
  const sellTimes = new Map(
    [...timeStats.values()].map((s) => [s.item_id, s.avg_sell_time_s]),
  );

  // Pairwise synergy lookup: centered + shrunk interaction between item ids, from the
  // unconditioned pairs + singles. Passed into the generator so discretionary core picks lean
  // toward items that reinforce the build; absent pairs ⇒ the build ranks on win rate alone.
  const decided = base.baseline.wins + base.baseline.losses;
  const baseline = decided > 0 ? base.baseline.wins / decided : 0.5;
  // Adoption movers read the same matched pair: items the player base is moving toward this patch
  // (rising pick rate), split into breakouts (rising *and* winning) and hype (rising but not paying
  // off). The post-patch game count comes from the raw fresh flow — item-stats and flow-stats
  // agree, and the comparator window is sized off the payloads themselves. The win-edge baseline is
  // the fresh window's, not the blend's: a blended baseline mixes in the pre-patch month, so an
  // edge against it compares a post-patch win rate to a partly pre-patch reference.
  const adoption = canBackfill
    ? findAdoptionMovers(
        statsFresh,
        statsPrev,
        baseBlend.freshGames,
        heroFresh.rate,
        itemMap,
      ).map((a) => ({ ...a, changed: touched?.has(a.item.id) ?? false }))
    : null;
  const synergyOf = permRows
    ? buildSynergyLookup(permRows, singleRecordsFromFlow(base), baseline)
    : undefined;
  // Same payload, plainer lens: measured joint-purchase counts, for the generator's substitute /
  // most-build-into / swap decisions (see lib/pairs.ts).
  const jointGamesOf = permRows ? buildJointGamesLookup(permRows) : undefined;

  // Condition on each archetype's signature item. The gun/spirit overlap (for the flex/hybrid
  // decision) is read out of the gun flow itself, so no extra query.
  const sig = pickSignatures(base, itemMap);
  // The guess held ⇒ those flows have had a head start and are already in flight or home. It didn't
  // ⇒ fetch the right ones now, exactly as before.
  const hit = signaturesMatch(guess, sig);
  rememberSignatures(h.id, minBadge, maxBadge, sig);
  const [gunBlend, spiritBlend] = await Promise.all([
    hit && guessed?.gun
      ? guessed.gun
      : sig.gun
        ? flowFor([sig.gun])
        : Promise.resolve(undefined),
    hit && guessed?.spirit
      ? guessed.spirit
      : sig.spirit
        ? flowFor([sig.spirit])
        : Promise.resolve(undefined),
  ]);
  const gun = gunBlend?.flow;
  const spirit = spiritBlend?.flow;

  const set = assembleArchetypes(
    h,
    rankLabel,
    itemMap,
    buyTimes,
    sellTimes,
    { all: base, gun, spirit },
    sig,
    { synergyOf, jointGamesOf, lineAware },
  );
  return {
    set,
    movers,
    adoption,
    flows: { all: base, gun, spirit },
    backfillShare: canBackfill ? baseBlend.borrowedShare : null,
  };
}
