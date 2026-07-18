// A build/item row (and the counter-add variant): win-rate delta vs baseline, pick rate,
// sample, plus the tag line (counter bubbles, imbue target, swap/rush clues, win-state).

import {
  classifyWinState,
  WIN_STATE_GAP,
  type LabWinState,
} from "../lib/buildGenerator";
import type { AdoptionMover } from "../lib/patchMovers";
import type {
  BuildItem,
  CounterMark,
  Hero,
  ImbueTarget,
  Item,
  ItemCounters,
  ItemRef,
} from "../types";
import { ABILITY_COLORS, SLOT_COLORS } from "./colors";
import { ItemHover } from "./ItemHover";

const pct = (x: number) => `${Math.round(x * 100)}%`;

const ROLE_BADGES: Record<BuildItem["role"], { label: string; title: string }> =
  {
    universal: {
      label: "CORE",
      title: "Staple — most players buy this every game",
    },
    value: {
      label: "VALUE",
      title: "Wins above the hero's average for its cost",
    },
    situational: {
      label: "VALUE",
      title: "Wins above the hero's average for its cost",
    },
    filler: {
      label: "FILLER",
      title: "Fills the phase budget — not a value pick",
    },
    need: { label: "SUSTAIN", title: "Covers the build's sustain gap" }, // the only NeedKind we classify
  };

/** Transient picks don't hold a standing slot — the badge says *how* each one leaves. */
const TRANSIENT_BADGES: Record<
  NonNullable<BuildItem["transientKind"]>,
  { label: string; title: string }
> = {
  part: {
    label: "PART",
    title: "A component — it upgrades into a later pick, refunding its cost",
  },
  sold: {
    label: "SELL",
    title: "Sell-fodder — when your slots fill up, this is what goes",
  },
};

function badgeFor(b: BuildItem): { label: string; title: string; cls: string } {
  if (b.transient) {
    const kind = b.transientKind ?? "sold";
    return { ...TRANSIENT_BADGES[kind], cls: kind };
  }
  return { ...ROLE_BADGES[b.role], cls: b.role };
}

/** Win rate as a signed delta vs the hero baseline (e.g. "+7.2", "−0.7"). */
function fmtDelta(d: number): string {
  const v = d * 100;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
}

/** Color a WR delta: centered on the baseline, so 0 reads neutral, not "bad". */
function deltaColor(d: number): string {
  if (d >= 0.04) return "#54c66b";
  if (d >= 0.02) return "#a6cf57";
  if (d >= -0.02) return "#d8c14a";
  return "#d87a7a";
}

/** One compact bubble: a single enemy's portrait + this item's edge vs that enemy. */
function CounterBubble({ mark, hero }: { mark: CounterMark; hero?: Hero }) {
  return (
    <span
      className={`cbubble ${mark.lowSample ? "low" : ""}`}
      title={`vs ${hero?.name ?? "?"}: +${(mark.delta * 100).toFixed(1)} win rate${mark.lowSample ? " (thin sample)" : ""}`}
    >
      {hero?.image && <img src={hero.image} alt={hero.name} loading="lazy" />}+
      {(mark.delta * 100).toFixed(1)}
    </span>
  );
}

/** The row's third line: counter bubbles (one per enemy), a weak-vs-comp flag, and any
 * transient note — or, when there's nothing comp-related to say, the item's effect text. */
function ItemTags({
  reason,
  reasonKind,
  counter,
  enemiesById,
  imbue,
  weakEdge,
  swapFor,
  swapLabel = "swap for",
  coreLater,
  coreRush,
  rawWr,
  adjWr,
  baseline,
  lab,
}: {
  reason?: string | null;
  /** Transient kind behind `reason`, so the note's tint matches the row's PART/SELL chip. */
  reasonKind?: BuildItem["transientKind"];
  counter?: ItemCounters;
  enemiesById?: Map<number, Hero>;
  /** For an imbue-type item: the ability most authors imbue it onto (a "→ ability" chip). */
  imbue?: ImbueTarget;
  weakEdge?: number;
  swapFor?: ItemRef;
  /** Wording for the swap tag — "swap for" (situational) vs "in for" (drop this for a counter). */
  swapLabel?: string;
  /** Phase label where this situational pick becomes core — shown as a "core by X" tag. */
  coreLater?: string;
  /** Whether rushing it early is supported by its win rate — gates the "rush if ahead" suffix. */
  coreRush?: boolean;
  /** Raw + adjusted win rate; their gap reveals a "win more" (raw≫adj) or "comeback" (adj≫raw) pick. */
  rawWr?: number;
  adjWr?: number;
  /** Hero baseline WR — a win-more/comeback tag only makes sense on a pick that's at least viable. */
  baseline?: number;
  /** Roster-wide purchase context from the nightly wp-stats bake — backs the tag when the
   * hero-conditional gap is quiet, and enriches the tooltip either way. */
  lab?: LabWinState;
}) {
  const bubbles = counter && enemiesById ? counter.marks : [];
  // raw ≫ adj ⇒ the win rate leans on already being ahead ("win more"); adj ≫ raw ⇒ it holds up even when
  // bought behind ("comeback"). Same classifier the per-phase tempo block uses, so the row tag and the
  // tempo lists never disagree about a pick's character. Lab evidence (measured win probability at the
  // moment of purchase, roster-wide) fills in when the hero-conditional gap is within noise.
  const state =
    rawWr !== undefined && adjWr !== undefined && baseline !== undefined
      ? classifyWinState(rawWr, adjWr, baseline, lab)
      : undefined;
  // Which evidence produced the tag decides what the tooltip cites.
  const gapBased =
    state !== undefined &&
    Math.abs((rawWr ?? 0) - (adjWr ?? 0)) >= WIN_STATE_GAP;
  const hasTags =
    !!reason ||
    bubbles.length > 0 ||
    !!imbue ||
    weakEdge !== undefined ||
    !!swapFor ||
    !!coreLater ||
    !!state;
  if (!hasTags) return null;
  return (
    <div className="tags">
      {reason && (
        <span className={`reason ${reasonKind ? `reason-${reasonKind}` : ""}`}>
          {reason}
        </span>
      )}
      {imbue && (
        <span
          className="rel imbue"
          style={
            imbue.colorIndex >= 0
              ? { borderColor: ABILITY_COLORS[imbue.colorIndex] }
              : undefined
          }
          title={`${Math.round(imbue.share * 100)}% of the ${imbue.sample} community builds that set a target imbue this onto ${imbue.ability.name}`}
        >
          {imbue.ability.image && (
            <img src={imbue.ability.image} alt="" loading="lazy" />
          )}
          imbue → {imbue.ability.name}
        </span>
      )}
      {bubbles.map((m) => (
        <CounterBubble
          key={m.enemyHeroId}
          mark={m}
          hero={enemiesById!.get(m.enemyHeroId)}
        />
      ))}
      {weakEdge !== undefined && (
        <span className="weakcomp" title="Weak into the selected comp">
          ▼ {fmtDelta(weakEdge)}
        </span>
      )}
      {coreLater && (
        <span
          className="rel rush"
          title={
            coreRush
              ? `Core by ${coreLater} — buy early if you're ahead`
              : `Core by ${coreLater} — but it does worse bought this early, so don't rush it`
          }
        >
          core by {coreLater}
          {coreRush ? " · rush if ahead" : " · buy later"}
        </span>
      )}
      {swapFor && (
        <span className="rel swap" title={`${swapLabel} ${swapFor.name}`}>
          {swapLabel} {swapFor.name}
        </span>
      )}
      {state && (
        <span
          className={`statetag ${state}`}
          title={
            gapBased
              ? state === "winmore"
                ? `Win-more: raw ${pct(rawWr!)} ≫ adjusted ${pct(adjWr!)} — its win rate leans on already being ahead${lab ? ` (roster-wide it's bought at ${pct(lab.wpBuy)} win probability)` : ""}`
                : `Comeback: adjusted ${pct(adjWr!)} ≫ raw ${pct(rawWr!)} — holds up even when bought behind${lab ? ` (roster-wide it's bought at ${pct(lab.wpBuy)} win probability)` : ""}`
              : state === "winmore"
                ? `Win-more: across the roster it's bought when already winning (${pct(lab!.wpBuy)} win probability at purchase) and buyers finish ${Math.abs(lab!.excess * 100).toFixed(1)}pt below that — the win rate is flattered by when it's bought`
                : `Comeback: across the roster it's bought from behind (${pct(lab!.wpBuy)} win probability at purchase) and buyers still finish ${(lab!.excess * 100).toFixed(1)}pt above that — it holds up bought behind`
          }
        >
          {state === "winmore" ? "win more" : "comeback"}
        </span>
      )}
    </div>
  );
}

/** The item's cost. A component-chained upgrade is charged *marginally* — net of components already
 * in the build, which Deadlock refunds into the upgrade — so the rows sum to the phase's soul budget.
 * When that discount applies, show the marginal price with the full sticker struck through. */
function CostTag({ b }: { b: BuildItem }) {
  const eff = b.effectiveCost ?? b.item.cost;
  if (eff >= b.item.cost)
    return <span className="cost">{b.item.cost.toLocaleString()}</span>;
  const saved = b.item.cost - eff;
  return (
    <span
      className="cost discounted"
      title={`${eff.toLocaleString()} now — ${saved.toLocaleString()} of components already in your build refund into it (full ${b.item.cost.toLocaleString()})`}
    >
      <span className="cost-full">{b.item.cost.toLocaleString()}</span>
      {eff.toLocaleString()}
    </span>
  );
}

export function ItemRow({
  b,
  items,
  baseline,
  counter,
  enemiesById,
  imbue,
  trending,
  muted = false,
  lab,
}: {
  b: BuildItem;
  items: Map<number, Item> | null;
  /** Hero+rank baseline win rate; item WR is shown as a delta against it. */
  baseline: number;
  /** If this pick also gains win rate vs the selected comp, its per-enemy counter marks. */
  counter?: ItemCounters;
  /** Selected enemies by id, for resolving the counter chip's portraits. */
  enemiesById?: Map<number, Hero>;
  /** For an imbue-type item: the ability most authors imbue it onto. */
  imbue?: ImbueTarget;
  /** Set when this item is a current breakout (rising + winning this patch) — shows a 🔥 marker. */
  trending?: AdoptionMover;
  muted?: boolean;
  /** This item's roster-wide purchase context from the nightly wp-stats bake (win probability at
   * buy + outcome vs it) — second evidence source for the win-more/comeback tag. */
  lab?: LabWinState;
}) {
  const color = SLOT_COLORS[b.item.slot] ?? SLOT_COLORS.unknown;
  const reason = b.transient && b.transientReason ? b.transientReason : null;
  const badge = badgeFor(b);
  return (
    <ItemHover
      item={b.item}
      items={items}
      className={`item ${muted ? "muted" : ""} ${b.transient ? "transient" : ""}`}
      style={{ borderLeftColor: color }}
      counter={counter}
      enemiesById={enemiesById}
      buildsToward={b.buildsToward}
      rowId={b.item.id}
    >
      <div className="icon" style={{ background: color }}>
        {b.item.image ? <img src={b.item.image} alt="" loading="lazy" /> : null}
      </div>
      <div className="body">
        <div className="line1">
          <span className="name">
            {!muted && (
              <span className={`role role-${badge.cls}`} title={badge.title}>
                {badge.label}
              </span>
            )}
            {b.item.name}
            {trending && (
              <span
                className="trendtag"
                title={`Trending up this patch — pick rate ${Math.round(trending.pickPrev * 100)}% → ${Math.round(trending.pickNew * 100)}% (+${(trending.pickDelta * 100).toFixed(0)}pt), winning ${(trending.winRate * 100).toFixed(0)}% over ${trending.nNew.toLocaleString()} games. Emerging meta — get ahead of it.`}
              >
                🔥
              </span>
            )}
          </span>
          <CostTag b={b} />
        </div>
        <div className="line2">
          <span
            className="wr"
            style={{ color: deltaColor(b.adjustedWinRate - baseline) }}
            title={`${(b.adjustedWinRate * 100).toFixed(1)}% adjusted WR · hero avg ${(baseline * 100).toFixed(1)}%`}
          >
            {fmtDelta(b.adjustedWinRate - baseline)}
            <span className="wrabs">
              {(b.adjustedWinRate * 100).toFixed(0)}%
            </span>
          </span>
          <span className="pick">{(b.pickRate * 100).toFixed(0)}% pick</span>
          <span className="n">n={b.sample.toLocaleString()}</span>
        </div>
        <ItemTags
          reason={reason}
          reasonKind={b.transientKind}
          counter={counter}
          enemiesById={enemiesById}
          imbue={imbue}
          weakEdge={!counter && b.weakVsComp ? b.compEdge : undefined}
          swapFor={b.swapFor}
          coreLater={b.coreLater}
          coreRush={b.coreRush}
          rawWr={b.rawWinRate}
          adjWr={b.adjustedWinRate}
          baseline={baseline}
          lab={lab}
        />
      </div>
    </ItemHover>
  );
}

/** A counter pick not already in the build, folded into its phase's swaps list. Headline
 * number is the raw per-enemy delta (item-stats has no adjusted rate). */
export function CounterAddRow({
  c,
  items,
  enemiesById,
  swapFor,
}: {
  c: ItemCounters;
  items: Map<number, Item> | null;
  enemiesById: Map<number, Hero>;
  /** The core pick to drop to fit this counter in (same slot, weakest for the comp). */
  swapFor?: ItemRef;
}) {
  const color = SLOT_COLORS[c.item.slot] ?? SLOT_COLORS.unknown;
  const top = c.marks[0];
  return (
    <ItemHover
      item={c.item}
      items={items}
      className="item muted counter-add"
      style={{ borderLeftColor: color }}
      counter={c}
      enemiesById={enemiesById}
    >
      <div className="icon" style={{ background: color }}>
        {c.item.image ? <img src={c.item.image} alt="" loading="lazy" /> : null}
      </div>
      <div className="body">
        <div className="line1">
          <span className="name">{c.item.name}</span>
          <span className="cost">{c.item.cost.toLocaleString()}</span>
        </div>
        <div className="line2">
          <span className="wr" style={{ color: deltaColor(top.delta) }}>
            +{(top.delta * 100).toFixed(1)}
            <span className="wrabs">{(top.winRate * 100).toFixed(0)}%</span>
          </span>
          <span className="pick">counters comp</span>
          <span className={`n ${top.lowSample ? "low" : ""}`}>
            n={top.sample.toLocaleString()}
            {top.lowSample ? " ⚠" : ""}
          </span>
        </div>
        <ItemTags
          counter={c}
          enemiesById={enemiesById}
          swapFor={swapFor}
          swapLabel="in for"
        />
      </div>
    </ItemHover>
  );
}
