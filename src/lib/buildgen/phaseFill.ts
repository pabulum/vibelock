// Phase fill: turning one flow column into a phase's core + situational picks under the item/soul
// budget — the category-ratio slot allocation, the substitute (shared-slot) logic, the need pick,
// and the situational list assembly. buildPhase is the engine generateBuild runs once per column.

import type {
  BuildItem,
  BuildPhase,
  BuildRole,
  Item,
  ItemFlowStats,
  NeedKind,
  PairGames,
  SlotType,
} from "../../types";
import { significantlyHigher } from "../stats";
import {
  EB_DEFAULT_K,
  FILL_WR_FLOOR,
  MIN_SUPPORT_ABS,
  MIN_SUPPORT_FRAC,
  SYNERGY_WEIGHT,
  UNIVERSAL_PICK,
  buyerContrast,
  buyersLoseSignificantly,
  coreWrScore,
  costPowerForSlots,
  isValuePick,
  lowerConfidenceWinRate,
  meritWr,
} from "./scoring";
import { toCandidate, unreliableAdjustedNodes } from "./candidates";
import {
  DOWNPAYMENT_WEIGHT,
  buildsFromAny,
  componentsConsumedByOwned,
  marginalCost,
  type LineModel,
} from "./lines";
import { categorySouls } from "./slotEconomy";

export const PHASE_META = [
  { label: "Lane", timeLabel: "0–9 min" },
  { label: "Early mid", timeLabel: "9–20 min" },
  { label: "Mid", timeLabel: "20–30 min" },
  { label: "Late", timeLabel: "30+ min" },
];

// --- Tuning knobs (top of module on purpose; no math needed to adjust) ---
const CO_OCCUR_MIN = 1; // two comparable-cost every-game picks in a slot are assumed to co-occur
// only when their pick rates sum past this (inclusion–exclusion: pA+pB−1 players must buy both);
// below it they can be bought by disjoint players — substitutes — so only one holds a core slot.
// This is the worst-case FALLBACK; when permutation pair data is available (jointGamesOf), the
// substitute call is made from the MEASURED overlap instead — see SUBSTITUTE_OVERLAP_MAX.
export const SUBSTITUTE_OVERLAP_MAX = 0.4; // measured co-buy rate — joint games over the smaller item's
// total — below which two same-slot staples are substitutes (one shared core slot), not co-buys.
// Calibrated on Paradox @ Emissary+ (2026-07): true substitutes Monster ∧ High-Velocity Rounds
// measure 24%, the ambiguous Headshot ∧ Monster Rounds 38%, while genuine co-buys run 60–87%
// (Echo Shard ∧ Superior Duration 87%) — 0.4 sits in the empirical gap.
export const PAIR_MIN_N = 500; // both items need this many whole-game decided samples before a missing/
// tiny pair row may be read as "genuinely not bought together" rather than "no data".
const SUBSTITUTE_WR_EDGE = 0.01; // which of two substitutes holds the shared slot: the core fill
// seats by pick rate, so the more *popular* one gets there first and holds it by default. But
// popularity among comparable substitutes is mostly habit, not correctness — so the other takes the
// slot instead when it wins at least this much more (adjusted WR). A real edge beats habit; noise
// doesn't unseat a clear favorite. (Paradox lane: High-Velocity Rounds' ~2pt edge over the more-
// popular Monster Rounds flips it into core, and Monster Rounds becomes its swap.)
const SOUL_SLACK = 1.15; // allow 15% over the soul budget before stopping
export const SITUATIONAL_MAX = 5;
const COMEBACK_GAP = 0.035; // adj−raw this big ⇒ a reactive "hold up when behind" pick
const COMEBACK_RESERVE = 2; // situational slots held for the best comeback picks (vs damage)

// --- Need-aware situational pick (see NeedKind) ---
// A need like sustain is bought by most players but split across substitutes (Extra Regen /
// Restorative Shot / Healing Rite), so no single item clears the pick-rate core bar; and it's
// usually win-rate *neutral* (buyers and non-buyers win alike — it's QOL, not an edge), so it
// also misses the situational value gate. The honest home is therefore neither: we surface the
// plurality item as a **conditional situational pick** ("most players grab one") when the need
// is near-universal, one item clearly leads it, and it isn't a trap (buyers don't underperform).
// We never force it into *core* — a genuine every-game sustain item (Abrams' Extra Regen, 94%)
// already clears the pick bar on its own and lands in core through the normal fill.
const NEED_DEMAND_FLOOR = 0.55; // Σ of a need's member pick rates this high ⇒ a near-universal need
const NEED_PLURALITY = 0.4; // ...and its lead item must own ≥40% of that demand to name one
const NEED_MAX_TIER = 2; // ...and we only count cheap *pickups* (≤T2): a T3+ item that happens to
// heal (Headhunter, Leech) is a scaling buy, not the reactive sustain a player grabs to hold a lane
const NEED_MAX_WR_DROP = 0.03; // ...and skip it if buyers win this far below baseline (a trap, not QOL)

// Categories we budget across, in fill order. Weapon is filled last on purpose: it's
// the plurality buy most phases, so giving the reactively-bought categories (greens,
// then spirit) first claim on the budget stops weapon from starving them of a slot.
const FILL_ORDER: Array<"weapon" | "vitality" | "spirit"> = [
  "vitality",
  "spirit",
  "weapon",
];

// End of each phase's time window (seconds): Lane 0–9, Early mid 9–20, Mid 20–30, Late 30+. Used to
// reject re-homing a cheap placeholder into a phase it's typically already sold within (see buildPhase).
const PHASE_END_S = [540, 1200, 1800, Number.POSITIVE_INFINITY];

/** Options for {@link generateBuild}. */
export interface BuildOptions {
  /** Guarantee a slot for the plurality answer to a near-universal need (default true). */
  needs?: boolean;
  /**
   * Pairwise item synergy (#5/#6): `(a, b) → centered, shrunk synergy` between two item ids, from
   * {@link buildSynergyLookup} in lib/synergy.ts. When present, a discretionary pick's core ranking gets a
   * bonus for its net synergy with the already-committed build (see {@link SYNERGY_WEIGHT}), so the build
   * leans toward items that reinforce each other — not just independently-good items. Omit to rank on win
   * rate alone (the build is unchanged from before synergy existed).
   */
  synergyOf?: (a: number, b: number) => number;
  /**
   * Unordered joint decided-game count between two item ids, from {@link buildJointGamesLookup} in
   * lib/pairs.ts (same permutation payload the synergy lookup reads). Unlocks *measured* co-occurrence:
   * the substitute call reads the real overlap instead of the pick-rate worst-case bound, transient
   * labels distinguish "most build into X" from "often sold", and the swap pairing skips items that
   * demonstrably co-occur. Omit to keep the previous heuristics.
   */
  jointGamesOf?: (a: number, b: number) => number;
  /**
   * Line-aware generation (experimental toggle). When true, the **survivorship shrink** kicks in: an
   * upgrade's *admission* win rate (used only for the seatable / value gates, never for display or for
   * ordering) is pulled toward its component's broader win rate, weighted by how many of the component's
   * buyers actually reach the upgrade (λ = pickUpgrade / pickComponent). A deep upgrade few players reach —
   * its raw WR inflated by selection (Headhunter, Weighted Shots) — is discounted below the bar and kept out
   * of core; a mainstream upgrade nearly everyone continues into (Fortitude, Opening Rounds) is trusted and
   * keeps its slot. The shrink deliberately does *not* touch ranking order — doing so demoted good upgrades
   * below their own universal components (see coreWrScore). The **down-payment** half then nudges a component
   * up the early-phase ranking when it builds into an upgrade the build commits to later (gated by a
   * two-pass commitment check; see {@link DOWNPAYMENT_WEIGHT}). Off by default — the build is byte-for-byte
   * unchanged.
   */
  lineAware?: boolean;
}

const COST_BAND = 1.6; // a "swap" only makes sense between items of comparable cost
export function withinCostBand(a: number, b: number): boolean {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return lo > 0 && hi / lo <= COST_BAND;
}

/**
 * The same-slot, comparable-cost every-game pick already in `core` that `c` does *not* co-occur
 * with (its substitute), or undefined. With pair data ({@link PairGames}) co-occurrence is
 * *measured*: the overlap coefficient — joint games over the smaller item's total — must fall
 * under {@link SUBSTITUTE_OVERLAP_MAX} (Paradox lane: Monster ∧ High-Velocity Rounds share 24% of
 * the smaller camp — one slot; Echo Shard ∧ Superior Duration share 87% — both are core). Without
 * pair data (or on thin samples) it falls back to the inclusion–exclusion worst-case bound: two
 * picks must overlap once their pick rates sum past {@link CO_OCCUR_MIN}; below that they *can*
 * be disjoint camps, so the build shouldn't assert both as every-game core. Scoped to comparable
 * cost because the test only discriminates among same-role alternatives — across tiers any two
 * moderately-popular picks "could be disjoint", which would wrongly bench scaling items (Opening
 * Rounds, Headhunter) that are bought *alongside* the cheap stat-sticks, not instead of them.
 */
export function substituteRival(
  c: BuildItem,
  core: BuildItem[],
  pairGames?: PairGames,
): BuildItem | undefined {
  if (c.pickRate < UNIVERSAL_PICK) return undefined;
  return core.find((b) => {
    if (
      b.item.slot !== c.item.slot ||
      b.pickRate < UNIVERSAL_PICK ||
      !withinCostBand(b.item.cost, c.item.cost)
    )
      return false;
    const pg = pairGames?.(b.item.id, c.item.id);
    if (pg && Math.min(pg.totalA, pg.totalB) >= PAIR_MIN_N)
      return pg.joint / Math.min(pg.totalA, pg.totalB) < SUBSTITUTE_OVERLAP_MAX;
    return b.pickRate + c.pickRate < CO_OCCUR_MIN;
  });
}

export function buildPhase(
  col: number,
  flow: ItemFlowStats,
  items: Map<number, Item>,
  baselineWinRate: number,
  buyTimes: Map<number, number>,
  sellTimes: Map<number, number>,
  opts: BuildOptions,
  primaryCol: Map<number, number>,
  owned: Set<number>,
  claimed: Set<number>,
  k: number,
  pairGames?: PairGames,
  lineModel?: LineModel,
  committedCore?: Map<number, number>,
): BuildPhase {
  // reached_per_column is the correct denominator for an unlocked query: players
  // who were still buying in this phase.
  const reached = flow.reached_per_column[col] || flow.baseline.matches || 1;
  const minSupport = Math.max(MIN_SUPPORT_ABS, MIN_SUPPORT_FRAC * reached);

  const unreliable = unreliableAdjustedNodes(flow);
  const candidates = flow.nodes
    .filter((n) => n.column === col)
    .map((n) => toCandidate(n, reached, items, unreliable))
    .filter((c): c is BuildItem => c !== null && c.sample >= minSupport);

  // Line-aware survivorship shrink: pull an upgrade's *ranking* WR toward its component's broader WR
  // (display keeps adjustedWinRate). λ near 1 (everyone continues) ⇒ no shrink; small λ ⇒ big pull.
  if (lineModel)
    for (const c of candidates) {
      const sh = lineModel.shrinkOf.get(c.item.id);
      if (sh)
        c.rankWinRate = sh.compWr + sh.lambda * (c.adjustedWinRate - sh.compWr);
    }

  // An upgrade of a component bought in an earlier phase costs only its marginal here — credit that
  // both for our spend and for the population budget, so the bar compares like with like. A component
  // already absorbed by an earlier upgrade (`claimed`) is gone, so it can't discount a second one.
  const ownedBefore = (id: number) => owned.has(id) && !claimed.has(id);

  const buys = candidates.reduce((a, c) => a + c.sample, 0);
  const targetItems = Math.max(1, Math.round(buys / reached));
  // Fill ceiling — what we're allowed to spend, using our build's own earlier picks for the component
  // discount (internally consistent with coreSouls, which also credits what we actually own).
  const soulBudget =
    candidates.reduce(
      (a, c) => a + c.sample * marginalCost(c.item, ownedBefore, items),
      0,
    ) / reached;

  // Displayed budget — a *build-independent* population reference, so flipping a toggle changes our
  // recommendation (coreSouls), never this denominator. It's the average souls a player at this rank
  // spends in the phase: each candidate's pick-mass × its population marginal cost, where a component is
  // credited by how much of the population already owns it (its cumulative pick rate across earlier
  // phases), not by our specific picks. That's what fixes the residual wobble — `ownedBefore` above made
  // the old number drift ~1–2% with our selection. coreSouls is shown against this as-is: under it for a
  // leaner-than-average build, occasionally a touch over when we front-load (the fill allows SOUL_SLACK).
  const ownedShareBefore = new Map<number, number>();
  for (const n of flow.nodes) {
    if (n.column >= col) continue;
    const rc = flow.reached_per_column[n.column] || flow.baseline.matches || 1; // that column's own denominator
    ownedShareBefore.set(
      n.item_id,
      Math.min(1, (ownedShareBefore.get(n.item_id) ?? 0) + n.players / rc),
    );
  }
  const popMarginal = (it: Item): number =>
    Math.max(
      0,
      it.cost -
        it.componentIds.reduce(
          (s, cid) =>
            s + (items.get(cid)?.cost ?? 0) * (ownedShareBefore.get(cid) ?? 0),
          0,
        ),
    );
  const popSoulBudget =
    candidates.reduce((a, c) => a + c.sample * popMarginal(c.item), 0) /
    reached;

  // Bias the phase's items across weapon/vitality/spirit toward the proportion real players of this
  // hero *buy* in each category (count share, not soul share — slots are bodies, so an expensive
  // category shouldn't claim extra slots just because its items cost more). Kept as a *fractional*
  // target (0.6 of a spirit slot, not a forced 1) — the fill below treats it as a pull, not a quota,
  // so a thin category only takes a slot when it has a pick worth building. Without any category
  // bias the build is category-blind: defensive greens are bought reactively, miss the pick/WR
  // gates, and the budget goes entirely to weapon/spirit — e.g. zero greens in lane.
  const share = categoryCountShare(candidates);
  const fracTarget: Record<"weapon" | "vitality" | "spirit", number> = {
    weapon: share.weapon * targetItems,
    vitality: share.vitality * targetItems,
    spirit: share.spirit * targetItems,
  };

  const chosen = new Set<number>();
  const core: BuildItem[] = [];
  const swaps: BuildItem[] = []; // every-game picks held out of core as substitutes (see substituteRival)
  const benchedIds = new Set<number>(); // their upgrade lines are off-limits for filling core (see buildsFromAny)
  let coreSouls = 0;
  // Components already spent building an earlier-phase pick (e.g. Mid bought the upgrade Escalating
  // Exposure — Late must not then offer its component Mystic Vulnerability as its own pick; you can't
  // buy a component standalone once its upgrade is owned). owned-only, not `chosen`: a same-phase
  // component+upgrade pair is handled later by dropSamePhaseComponents, which still wants both rows to
  // exist so it can fold one into the other.
  const consumedByOwned = componentsConsumedByOwned(owned, items);

  // The components `c` would absorb: in the build already (earlier phase `owned`, or earlier this
  // phase `chosen`) and not yet consumed by another upgrade (`claimed`). Returns the ids so the caller
  // can mark them claimed once `c` actually seats — that's what stops a shared component (Sprint Boots)
  // from discounting two upgrades. Each is consumed at most once; the second upgrade pays full.
  const absorbs = (c: BuildItem): number[] =>
    c.item.componentIds.filter(
      (id) => (owned.has(id) || chosen.has(id)) && !claimed.has(id),
    );
  const costAfter = (c: BuildItem, absorb: number[]): number =>
    Math.max(
      0,
      c.item.cost - absorb.reduce((s, id) => s + (items.get(id)?.cost ?? 0), 0),
    );

  // Try to seat one candidate in core. Returns true only when it actually took a slot (so the caller
  // decrements its quota); a soul/line/phase miss or a benched substitute returns false.
  const tryAddCore = (c: BuildItem): boolean => {
    // Already bought in an earlier phase: it holds its slot there, you don't re-buy it. Seating it
    // again only for dedupeAcrossPhases to strip it back out is what left later phases short of their
    // item target with budget to spare — skip it so this slot goes to a genuinely new pick.
    if (
      chosen.has(c.item.id) ||
      benchedIds.has(c.item.id) ||
      owned.has(c.item.id)
    )
      return false;
    // Don't seat a component of an upgrade already owned from an *earlier* phase — you can't buy it
    // standalone anymore (Deadlock only lets you buy a component before its upgrade, never after), so
    // offering it here would recommend an impossible purchase (Escalating Exposure core in Mid ⇒ its
    // component Mystic Vulnerability must not resurface as its own pick in Late).
    if (consumedByOwned.has(c.item.id)) return false;
    // Don't seat a component whose upgrade is already in this phase's core — buying the upgrade already
    // includes it, so it would just fold away (dropSamePhaseComponents) and waste the slot. Skip it so
    // the slot goes to a genuinely new item (Victor early-mid: skip Sprint Boots once Enduring Speed is
    // in, so Healing Booster gets the slot instead of the build silently coming up an item short).
    const cidSet = new Set([c.item.id]);
    if (core.some((b) => buildsFromAny(b.item, cidSet, items))) return false;
    // Don't re-home a cheap placeholder into a phase it's typically sold *within*. An item whose primary
    // (most-bought) phase is earlier but that lost its slot there is otherwise allowed to resurface in a
    // later phase (see the primaryCol check below) — but if it's a cheap item the population sells before
    // this phase even ends, that resurfacing is a buy-then-sell, not a real pick for the phase. (Kelvin
    // Emissary: Extra Regen, a lane-sustain bought ~5min / sold ~13min, drifting into Early mid. At
    // Eternus it stays in Lane.) Limited to T1 + an earlier primary phase, matching markTransient's
    // assumption that a cheap early-sold item is a placeholder, not a kept pick with a noisy sell time.
    const sellT = sellTimes.get(c.item.id);
    if (
      c.item.tier <= 1 &&
      (primaryCol.get(c.item.id) ?? col) < col &&
      sellT !== undefined &&
      sellT > 0 &&
      sellT <= PHASE_END_S[col]
    )
      return false;
    const absorb = absorbs(c);
    const cost = costAfter(c, absorb);
    if (coreSouls + cost > soulBudget * SOUL_SLACK) return false; // a cheaper pick may still fit
    // Don't fill a slot with the upgrade of an item we've already benched as a swap — that's the same
    // line (Opening Rounds builds from High-Velocity Rounds), so it'd put the upgrade in core and the
    // component as its swap. Skip it; the slot stays open for a genuinely different item.
    if (buildsFromAny(c.item, benchedIds, items)) return false;
    // Skip items whose primary phase is *later* — dedupeAcrossPhases keeps them there, so placing one
    // in this earlier slot just leaves it empty (they still surface as a situational, "core by Mid").
    // Items primary in an earlier phase are allowed through: if they didn't win a slot there they'd
    // otherwise vanish, and a later phase is a fine home for them.
    if ((primaryCol.get(c.item.id) ?? col) > col) return false;
    // Substitution guard: this every-game pick is an alternative to one already in core (a same-slot,
    // comparable-cost pick it doesn't co-occur with) — you buy one or the other, so the two share a
    // single slot. The rival got there first only because the fill seats by pick rate; that makes the
    // more *popular* substitute the default holder. Pick rate is the right gate for "is this core-
    // worthy", but the wrong tiebreak for "which of two substitutes do I commit to" — there win rate
    // decides. So when this pick wins meaningfully more games it evicts the rival and takes the slot;
    // otherwise the rival keeps it. Either way the loser becomes the winner's swap and its upgrade
    // line stays out of core (benchedIds), and we return false: the slot was already counted when the
    // rival first took it, so this is a *replacement*, not a new item (the phase keeps its count, and
    // a different co-occurring item still fills the next slot).
    const rival = substituteRival(c, core, pairGames);
    if (rival) {
      // Only unseat the incumbent when this pick is *significantly* better, not just nominally — a 1pt
      // edge between two stat-sticks each over a few hundred games is a coin-flip, and shouldn't flip a
      // core slot. significantlyHigher requires the gap to clear SUBSTITUTE_WR_EDGE *and* the combined
      // sampling noise of both picks.
      if (
        significantlyHigher(
          c.adjustedWinRate,
          c.decided,
          rival.adjustedWinRate,
          rival.decided,
          SUBSTITUTE_WR_EDGE,
        )
      ) {
        core.splice(core.indexOf(rival), 1);
        coreSouls -= rival.item.cost; // a substitute is a stat-stick with no in-build component to net out
        chosen.delete(rival.item.id);
        core.push({ ...c, role: "universal" }); // a substitute is by definition over the pick bar
        coreSouls += cost;
        chosen.add(c.item.id);
        absorb.forEach((id) => claimed.add(id));
        swaps.push({ ...rival, role: "situational", swapForId: c.item.id });
        benchedIds.add(rival.item.id);
      } else {
        swaps.push({ ...c, role: "situational", swapForId: rival.item.id });
        benchedIds.add(c.item.id);
      }
      return false;
    }
    // Mirror the bucket logic in categoryPriority: a quota-filling pick that beats neither the
    // pick-rate bar nor the value gate is `filler`, not a `value` pick.
    const role: BuildRole =
      c.pickRate >= UNIVERSAL_PICK
        ? "universal"
        : isValuePick(c, baselineWinRate)
          ? "value"
          : "filler";
    core.push({ ...c, role });
    coreSouls += cost;
    chosen.add(c.item.id);
    absorb.forEach((id) => claimed.add(id));
    return true;
  };

  // Fill core toward the item target, biased to the category ratio but never forcing a loser in.
  // Each category has its own best-first list (categoryPriority: universals, then value staples, then
  // the rest by pick). "Worth building" = a universal (everyone-builds) pick, or a discretionary pick
  // that isn't a clear loser (FILL_WR_FLOOR) — a popular-but-bad item never holds a slot.
  // Efficiency weight for this phase from how many standing slots are already committed (owned, minus
  // components an upgrade absorbed — those don't hold a permanent slot). Empty build ⇒ souls bind ⇒ favor
  // soul-efficiency; near the slot cap ⇒ slots bind ⇒ per-slot win rate (the big carries) decides.
  let committedSlots = 0;
  for (const id of owned) if (!claimed.has(id)) committedSlots++;
  const costPower = costPowerForSlots(committedSlots);
  // Per-candidate *rank bonus* = the already-weighted additive edge added in coreWrScore. Two parts:
  //  - Synergy: SYNERGY_WEIGHT × net (centered, shrunk) pairwise synergy with items committed in earlier
  //    phases (`owned`). Against `owned` (not within-phase) because the rankers sort upfront; captures the
  //    dominant cross-phase synergy, zero in Lane and when no synergy data was supplied. See SYNERGY_WEIGHT.
  //  - Down-payment (line-aware): DOWNPAYMENT_WEIGHT × a component's best-upgrade upside, but only when that
  //    upgrade lives in a *later* phase — so buying the component early (Lane/EM) is rewarded for building
  //    into a later winner, over a dead-end stat-stick of equal WR. See DOWNPAYMENT_WEIGHT.
  const ownedIds = [...owned];
  const rankBonus = new Map<number, number>();
  if (opts.synergyOf && ownedIds.length) {
    const syn = opts.synergyOf;
    for (const c of candidates)
      rankBonus.set(
        c.item.id,
        SYNERGY_WEIGHT * ownedIds.reduce((s, o) => s + syn(c.item.id, o), 0),
      );
  }
  // Down-payment (pass 2 only — committedCore is set): reward a component for building into an upgrade the
  // build *actually commits to* in a later phase (best such upside). The commitment gate is what stops the
  // over-fire a naive one-pass showed (promoting a component for an upgrade that never seats). Off in pass 1
  // (committedCore undefined) and when the toggle is off.
  if (lineModel && committedCore)
    for (const c of candidates) {
      const ups = lineModel.downpaymentOf.get(c.item.id);
      if (!ups) continue;
      let best = 0;
      for (const u of ups) {
        const committedAt = committedCore.get(u.upgradeId);
        if (committedAt !== undefined && committedAt > col && u.upside > best)
          best = u.upside;
      }
      if (best > 0)
        rankBonus.set(
          c.item.id,
          (rankBonus.get(c.item.id) ?? 0) + DOWNPAYMENT_WEIGHT * best,
        );
    }
  const pools: Record<"weapon" | "vitality" | "spirit", BuildItem[]> = {
    weapon: categoryPriority(
      candidates,
      "weapon",
      baselineWinRate,
      chosen,
      costPower,
      k,
      rankBonus,
    ),
    vitality: categoryPriority(
      candidates,
      "vitality",
      baselineWinRate,
      chosen,
      costPower,
      k,
      rankBonus,
    ),
    spirit: categoryPriority(
      candidates,
      "spirit",
      baselineWinRate,
      chosen,
      costPower,
      k,
      rankBonus,
    ),
  };
  const cursor: Record<"weapon" | "vitality" | "spirit", number> = {
    weapon: 0,
    vitality: 0,
    spirit: 0,
  };
  const allocated: Record<"weapon" | "vitality" | "spirit", number> = {
    weapon: 0,
    vitality: 0,
    spirit: 0,
  };
  // Deliberately *not* significance-gated (unlike the value/substitute/counter gates in #3). This is a
  // risk-averse break-even floor, not a "is this a real edge" claim: we'd rather a category sit a slot out
  // than fill it with a losing pick, even one whose loss isn't yet statistically confirmed. Adding
  // significance here would loosen it the wrong way — re-admitting not-quite-significant losers (a thin
  // −1.5pt spirit pick) into core, the exact thing FILL_WR_FLOOR exists to keep out.
  const seatable = (c: BuildItem) =>
    (c.pickRate >= UNIVERSAL_PICK &&
      !buyersLoseSignificantly(c, baselineWinRate)) ||
    meritWr(c) >= baselineWinRate - FILL_WR_FLOOR;
  // The category's next candidate worth trying — skipping ones already taken, benched, or losing —
  // or undefined once it's spent. Advances the cursor past the skips it walks over.
  const peek = (
    slot: "weapon" | "vitality" | "spirit",
  ): BuildItem | undefined => {
    while (cursor[slot] < pools[slot].length) {
      const c = pools[slot][cursor[slot]];
      if (
        chosen.has(c.item.id) ||
        benchedIds.has(c.item.id) ||
        owned.has(c.item.id) ||
        !seatable(c)
      ) {
        cursor[slot]++;
        continue;
      }
      return c;
    }
    return undefined;
  };

  // Phase A — award only *whole* slots the ratio genuinely earns. A category gets the next slot when
  // it's owed at least half an item (deficit ≥ ½) and has a pick worth building, most-owed first. A
  // fractional tail under half a slot earns nothing here: that's what stops a thin category from
  // *minting* a slot for a weak pick (Paradox lane spirit is ~0.4 of a slot — it gets none, instead
  // of rounding up and dragging in Extra Spirit / Mystic Burst). Its share is left for Phase B.
  const RATIO_SLOT = 0.5;
  for (;;) {
    if (core.length >= targetItems) break;
    let pick: "weapon" | "vitality" | "spirit" | undefined;
    let bestDeficit = RATIO_SLOT;
    for (const slot of FILL_ORDER) {
      if (!peek(slot)) continue; // no pick worth building in this category — it sits out
      const deficit = fracTarget[slot] - allocated[slot];
      if (deficit >= bestDeficit) {
        bestDeficit = deficit;
        pick = slot;
      }
    }
    if (!pick) break;
    const c = peek(pick)!;
    cursor[pick]++; // consume it whether or not it seats (a soul/line miss mustn't re-loop forever)
    if (tryAddCore(c)) allocated[pick]++;
  }

  // Phase B — top up to the item count with the most-bought remaining pick worth building, of *any*
  // category: the fractional tails Phase A left on the table, plus any slot a substitute emptied. The
  // ratio already shaped the whole slots, so the leftover goes by commonality, not category — and
  // it's still merit-gated (seatable), so the padding is a real pick a player would buy, not a loser
  // dragged in to hit the number. A phase with nothing worth building simply runs short.
  if (core.length < targetItems) {
    const rest = candidates
      .filter(
        (c) =>
          !chosen.has(c.item.id) &&
          !benchedIds.has(c.item.id) &&
          !owned.has(c.item.id) &&
          seatable(c),
      )
      .sort(
        (a, b) =>
          coreWrScore(
            b,
            baselineWinRate,
            costPower,
            k,
            rankBonus.get(b.item.id) ?? 0,
          ) -
          coreWrScore(
            a,
            baselineWinRate,
            costPower,
            k,
            rankBonus.get(a.item.id) ?? 0,
          ),
      );
    for (const c of rest) {
      if (core.length >= targetItems) break;
      tryAddCore(c);
    }
  }

  // Situational: the best leftover value picks across every category — but reserve a couple
  // of slots for the strongest "comeback" picks (adj ≫ raw: reactive items that hold up when
  // behind). Sorting purely by win rate lets raw damage items crowd those out, so a real
  // late-game stabilizer (e.g. Fortitude) never surfaces. Reserve first, then fill by WR.
  const swapIds = new Set(swaps.map((s) => s.item.id));
  // Rank situational picks by the lower confidence bound, so a thin-sample shiny WR doesn't lead the list
  // over a proven value pick (#2), plus the same synergy bonus as the core (#5/#6) — but measured against
  // the *full* committed build (earlier phases + this phase's core), so an option that reinforces what
  // you're building ranks above an equally-rated isolated one. The eligibility gate below is the
  // significance-aware value test (#3): a pick must *confidently* beat baseline by VALUE_EDGE to be offered.
  const synOf = opts.synergyOf;
  const committedNow = synOf ? [...owned, ...chosen] : [];
  const rankWr = (c: BuildItem) => {
    // Raw WR for *ordering* (see coreWrScore); the line shrink only gates eligibility (isValuePick below).
    const lcb = lowerConfidenceWinRate(
      c.adjustedWinRate,
      c.decided,
      baselineWinRate,
      k,
    );
    if (!synOf || !committedNow.length) return lcb;
    return (
      lcb +
      SYNERGY_WEIGHT * committedNow.reduce((s, o) => s + synOf(c.item.id, o), 0)
    );
  };
  const eligible = candidates
    .filter(
      (c) =>
        !chosen.has(c.item.id) &&
        !owned.has(c.item.id) && // bought in an earlier phase already — don't re-surface it as optional
        !swapIds.has(c.item.id) &&
        !consumedByOwned.has(c.item.id) && // its upgrade is already owned — can't buy it standalone anymore
        !buildsFromAny(c.item, benchedIds, items) && // an upgrade of a swap is that swap's line, not its own pick
        isValuePick(c, baselineWinRate),
    )
    .sort((a, b) => rankWr(b) - rankWr(a));
  const reserved = eligible
    .filter((c) => c.adjustedWinRate - c.rawWinRate >= COMEBACK_GAP)
    .slice(0, COMEBACK_RESERVE);
  const reservedIds = new Set(reserved.map((c) => c.item.id));
  // Substitution swaps lead the list (they're the explicit alternative to a core pick); the
  // strongest value/comeback leftovers fill whatever cap is left.
  const value = [
    ...reserved,
    ...eligible.filter((c) => !reservedIds.has(c.item.id)),
  ]
    .slice(0, Math.max(0, SITUATIONAL_MAX - swaps.length))
    .sort((a, b) => rankWr(b) - rankWr(a))
    .map<BuildItem>((c) => ({ ...c, role: "situational" }));
  const situational = [...swaps, ...value];

  // Conditional need pick: when a near-universal, win-rate-neutral need (sustain) is split across
  // substitutes so its lead item missed both the core and the value gates above, surface that
  // item here as a flagged optional pickup — "most players grab one; no win-rate cost" — rather
  // than forcing it into the every-game core. Skipped when it's already in the build.
  if (opts.needs !== false) {
    const need = dominantNeed(candidates, "sustain", baselineWinRate);
    if (
      need &&
      !chosen.has(need.item.id) &&
      !owned.has(need.item.id) &&
      !consumedByOwned.has(need.item.id) &&
      !situational.some((s) => s.item.id === need.item.id)
    ) {
      situational.unshift({
        ...need,
        role: "need",
        why: "optional lane sustain — most players grab one",
      });
      if (situational.length > SITUATIONAL_MAX) situational.pop(); // keep the cap; drops the weakest WR pick
    }
  }

  // A demoted universal (popular pick whose buyers verifiably lose — see buyersLoseSignificantly)
  // still deserves a ROW: a third of the lobby buys it, so silently omitting it reads as an
  // oversight, not a recommendation. Surface it as an optional pick with an honest why, so the
  // build *explains* the absence.
  for (const c of candidates) {
    if (situational.length >= SITUATIONAL_MAX) break;
    if (
      c.pickRate < UNIVERSAL_PICK ||
      !buyersLoseSignificantly(c, baselineWinRate)
    )
      continue;
    if (
      chosen.has(c.item.id) ||
      owned.has(c.item.id) ||
      consumedByOwned.has(c.item.id) ||
      situational.some((s) => s.item.id === c.item.id)
    )
      continue;
    const gap = (buyerContrast(c, baselineWinRate) * 100).toFixed(1);
    situational.push({
      ...c,
      role: "filler",
      why: `${Math.round(c.pickRate * 100)}% of players buy this, but they run ~${gap}pt behind the ones who don't — skip it at this rank`,
    });
  }

  // Enrich: the value gate alone (a *significant* edge over baseline) can leave a thin 1–2 line list,
  // hiding common picks a player would still want to see. Round the list out toward the cap with the
  // most-bought remaining picks — but only ones that at least *break even* (adjusted WR ≥ baseline −
  // FILL_WR_FLOOR, the same "worth building" floor the core fill uses). A clearly-below-baseline pick
  // is not a choice worth offering, no matter how popular: padding the list with it (Abrams lane:
  // Mystic Expansion, 30% pick / −2pt) just overloads the player with an option that loses, so we let
  // the list run short instead. This is the win-rate floor without seatable's universal-pickrate
  // bypass — "everyone builds it" earns a *core* slot, not a free pass into the optional list. Kept
  // picks are labelled honestly (`value` only if they actually clear the edge, else `filler` for a
  // win-rate-neutral pickup, so the chip doesn't oversell it). Loosen FILL_WR_FLOOR to re-admit
  // near-baseline pickups here and in core together.
  if (situational.length < SITUATIONAL_MAX) {
    const shown = new Set([...core, ...situational].map((b) => b.item.id));
    for (const c of [...candidates].sort((a, b) => b.pickRate - a.pickRate)) {
      if (situational.length >= SITUATIONAL_MAX) break;
      if (
        shown.has(c.item.id) ||
        benchedIds.has(c.item.id) ||
        owned.has(c.item.id) ||
        consumedByOwned.has(c.item.id) // its upgrade is already owned — can't buy it standalone anymore
      )
        continue;
      if (meritWr(c) < baselineWinRate - FILL_WR_FLOOR) continue; // don't pad with a losing pick
      if (buildsFromAny(c.item, benchedIds, items)) continue; // an upgrade of a swap is that swap's line
      const role: BuildRole = isValuePick(c, baselineWinRate)
        ? "value"
        : "filler";
      situational.push({ ...c, role });
      shown.add(c.item.id);
    }
  }

  const buyTime = (b: BuildItem) =>
    buyTimes.get(b.item.id) ?? Number.POSITIVE_INFINITY;
  // The "why" is what the item does — the WR/pick numbers are already on the row — unless a pick
  // set its own rationale (the conditional need note above), which we keep. Also stamp each item's
  // buy time so a later comp re-rank can re-sort a phase into buy order without the buyTimes map.
  const withWhy = (b: BuildItem) => ({
    ...b,
    why: b.why || b.item.effect || "",
    buyTimeS: buyTimes.get(b.item.id),
  });

  return {
    column: col,
    label: PHASE_META[col].label,
    timeLabel: PHASE_META[col].timeLabel,
    targetItems,
    itemsBought: 0, // finalized by countItemsBought once cross-phase core membership is settled
    soulBudget: popSoulBudget,
    coreSouls,
    categorySouls: categorySouls(core),
    // Order by buy time so top-to-bottom reads as buy order.
    core: core.sort((a, b) => buyTime(a) - buyTime(b)).map(withWhy),
    situational: situational.map(withWhy), // already strongest-first by win rate
  };
}

/**
 * Fraction of phase *buys* real players put into each category (weapon/vitality/spirit) — by player
 * count, not souls, because the fill spends this on *slots* (bodies), and a slot is a slot whether it
 * holds an 800 stat-stick or a 6.2k carry. Weighting by souls would hand an expensive category extra
 * slots on top of the extra souls each slot already costs (Paradox mid: spirit is ~62% of buys but
 * ~64% of souls — soul-weighting tips its 2.5 slots to 3 and zeroes the greens the real build keeps).
 * The returned shares are a *soft* bias for the fill, which decides per slot whether a thin category
 * actually has a pick worth building before honoring its share.
 */
function categoryCountShare(candidates: BuildItem[]): Record<SlotType, number> {
  const buys: Record<SlotType, number> = {
    weapon: 0,
    vitality: 0,
    spirit: 0,
    unknown: 0,
  };
  let total = 0;
  for (const c of candidates) {
    buys[c.item.slot] += c.sample;
    total += c.sample;
  }
  if (total > 0)
    for (const k of Object.keys(buys) as SlotType[]) buys[k] /= total;
  return buys;
}

/**
 * The single item to surface for a cross-slot need this phase, or undefined to stay quiet.
 * Fires only when the need is near-universal by *summed* member pick (a union proxy: the items
 * are substitutes, so few players buy two) yet its lead item is below the core pick bar (so the
 * normal fill would drop it), clearly leads the need (so naming one item isn't arbitrary), and
 * isn't a trap (its buyers don't win well below baseline). When the lead is already a core pick,
 * the demand is split with no clear leader, or it's a loser, returns undefined — the value/
 * pick-rate fill handles it (or, honestly, nothing should be surfaced).
 */
function dominantNeed(
  candidates: BuildItem[],
  need: NeedKind,
  baselineWinRate: number,
): BuildItem | undefined {
  const members = candidates.filter(
    (c) => c.item.need === need && c.item.tier <= NEED_MAX_TIER,
  );
  if (members.length === 0) return undefined;
  const demand = members.reduce((a, c) => a + c.pickRate, 0);
  if (demand < NEED_DEMAND_FLOOR) return undefined; // not a near-universal need for this hero
  const lead = members.reduce((best, c) =>
    c.pickRate > best.pickRate ? c : best,
  );
  if (lead.pickRate >= UNIVERSAL_PICK) return undefined; // already a core pick — don't relabel it
  if (lead.pickRate < NEED_PLURALITY * demand) return undefined; // genuinely split — don't name one
  if (lead.rawWinRate < baselineWinRate - NEED_MAX_WR_DROP) return undefined; // a trap, not QOL
  return lead;
}

/**
 * One category's candidates, best-first for filling *core* slots. Genuine universals (everyone-builds
 * staples) lead, ordered by pick rate — they're mandatory regardless. Below them the discretionary picks
 * (value staples, then the rest) order by efficiency-aware shrunk adjusted win rate plus a synergy bonus
 * ({@link coreWrScore}), so the build tilts toward what wins *and* what reinforces the committed core; the
 * sample shrink keeps a 6%-pick shiny-WR item from stealing a slot from the proven staple everyone buys.
 * Niche high-WR picks still surface in `situational`. `rankBonus` maps item id → its already-weighted
 * additive edge bonus (synergy + line-aware down-payment).
 */
function categoryPriority(
  candidates: BuildItem[],
  slot: SlotType,
  baselineWinRate: number,
  chosen: Set<number>,
  costPower = 0,
  k = EB_DEFAULT_K,
  rankBonus: Map<number, number> = new Map(),
): BuildItem[] {
  const pool = candidates.filter((c) => c.item.slot === slot);
  const byPick = (a: BuildItem, b: BuildItem) => b.pickRate - a.pickRate;
  // Discretionary picks (staples + rest) order by efficiency-aware shrunk adjusted WR + rank bonus.
  // Universals stay by pick rate — they're mandatory regardless.
  const byDiscretionary = (a: BuildItem, b: BuildItem) =>
    coreWrScore(
      b,
      baselineWinRate,
      costPower,
      k,
      rankBonus.get(b.item.id) ?? 0,
    ) -
    coreWrScore(
      a,
      baselineWinRate,
      costPower,
      k,
      rankBonus.get(a.item.id) ?? 0,
    );
  const universal = pool
    .filter((c) => c.pickRate >= UNIVERSAL_PICK)
    .sort(byPick);
  const staples = pool
    .filter(
      (c) => c.pickRate < UNIVERSAL_PICK && isValuePick(c, baselineWinRate),
    )
    .sort(byDiscretionary);
  const rest = pool
    .filter((c) => !universal.includes(c) && !staples.includes(c))
    .sort(byDiscretionary);

  const ordered: BuildItem[] = [];
  const seen = new Set<number>(chosen);
  for (const c of [...universal, ...staples, ...rest]) {
    if (seen.has(c.item.id)) continue;
    seen.add(c.item.id);
    ordered.push(c);
  }
  return ordered;
}
