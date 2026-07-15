// The page's smaller display components: brand mark, loading state, skill order grid,
// per-phase tempo lines, category bar, overtime column, counter picker, matchup chips.

import { useMemo, useState, type Ref } from "react";
import { type LabWinState, type PhaseTempo } from "../lib/buildGenerator";
import type {
  Ability,
  BuildItem,
  GeneratedBuild,
  Hero,
  ImbueTarget,
  Item,
  ItemCounters,
  Matchup,
  SkillBuild,
} from "../types";
import { ABILITY_COLORS, SLOT_COLORS } from "./colors";
import { CounterQuickAdd } from "./CounterQuickAdd";
import { ItemRow } from "./ItemRow";

// The brand mark: a diamond gem that shows a real item icon (masked to the diamond
// silhouette so any source icon reads as one cohesive logo). The icon is derived from
// `seed`, so it changes only when the user takes an action (new hero/rank/patch/style)
// — no timer ticking away. Falls back to a static ◆ until the items asset loads.
// Doubles as the (static, bobbing) spinner in <LoadingState>.
export function ShuffleMark({
  items,
  size = 36,
  seed = "",
}: {
  items: Map<number, Item> | null;
  size?: number;
  seed?: string;
}) {
  const pool = useMemo(
    () => (items ? [...items.values()].filter((i) => i.image) : []),
    [items],
  );
  // A per-mount salt so the same selection doesn't always map to the same icon across
  // reloads, while staying stable within a session.
  const salt = useState(() => Math.random().toString(36).slice(2))[0];

  const item = pool.length ? pool[hashIndex(seed + salt, pool.length)] : null;
  return (
    <span className="shufmark" style={{ width: size, height: size }}>
      {item?.image ? (
        <img key={item.id} src={item.image} alt="" />
      ) : (
        <span className="shufmark-fallback">◆</span>
      )}
    </span>
  );
}

/** Stable FNV-1a hash of a string into [0, mod) — used to pick the brand icon. */
function hashIndex(s: string, mod: number): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % mod;
}

// First-paint / cold-query state: the shuffling mark, gently bobbing, over a label.
// Replaces the old "Loading build…" / "refreshing…" text so loading reads as one thing.
export function LoadingState({
  items,
  label,
}: {
  items: Map<number, Item> | null;
  label: string;
}) {
  return (
    <div className="loadstate">
      <ShuffleMark items={items} size={46} />
      <span className="loadlabel">{label}</span>
    </div>
  );
}

// Shown when no skill order clears the sample threshold (high rank + narrow patch). We
// render this instead of nothing so the panel never silently disappears.
export function SkillEmpty() {
  return (
    <section className="skills">
      <h2>
        Skill order <span className="sub">not enough games on this filter</span>
      </h2>
      <p className="empty">
        No upgrade order has a confident sample here — even in the pre-patch
        window. Try a lower rank floor.
      </p>
    </section>
  );
}

/** The per-phase tempo lines: one for when you're ahead of the soul pace — pull a later-core pick
 * forward — and one for when you're behind — favor resilient picks over snowbally ones. Renders only the
 * lines that have picks, and nothing at all when there's no signal. */
export function PhaseTempoLines({ tempo }: { tempo: PhaseTempo | null }) {
  if (!tempo) return null;
  const { rush, lean, hold } = tempo;
  const chip = (b: BuildItem) => (
    <span
      key={b.item.id}
      className="tchip"
      style={{ borderColor: SLOT_COLORS[b.item.slot] ?? SLOT_COLORS.unknown }}
    >
      {b.item.name}
    </span>
  );
  return (
    <div className="tempo">
      {rush.length > 0 && (
        <div
          className="tline ahead"
          title="Ahead of the soul pace? Pull these later-core picks forward now instead of adding a situational."
        >
          <span className="tlbl">▲ ahead</span>
          <span className="tact">rush</span>
          {rush.map(chip)}
        </div>
      )}
      {(lean.length > 0 || hold.length > 0) && (
        <div
          className="tline behind"
          title="Behind the soul pace? Favor the picks that hold up from behind; the win-more picks need a lead to pay off."
        >
          <span className="tlbl">▼ behind</span>
          {lean.length > 0 && (
            <>
              <span className="tact">favor</span>
              {lean.map(chip)}
            </>
          )}
          {hold.length > 0 && (
            <>
              <span className="tact risky">risky</span>
              {hold.map(chip)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// A thin stacked bar of the souls this phase's build invests per category — the
// "soul investment" split, so a weapon-leaning build that still buys defense reads
// at a glance and the greens aren't lost among the orange/purple.
export function CategoryBar({
  split,
}: {
  split: Record<"weapon" | "vitality" | "spirit", number>;
}) {
  const total = split.weapon + split.vitality + split.spirit;
  if (total <= 0) return null;
  const segs: Array<["weapon" | "vitality" | "spirit", string]> = [
    ["weapon", "Weapon"],
    ["vitality", "Vitality"],
    ["spirit", "Spirit"],
  ];
  return (
    <div className="catbar" title="Souls this build invests per category">
      {segs.map(([slot, label]) => {
        const souls = split[slot];
        if (souls <= 0) return null;
        const exact = (souls / total) * 100;
        const pct = Math.round(exact);
        return (
          <span
            key={slot}
            className="catseg"
            style={{ width: `${exact}%`, background: SLOT_COLORS[slot] }}
            title={`${label}: ${souls.toLocaleString()} souls (${exact.toFixed(1)}%)`}
          >
            {exact >= 8 ? `${pct}%` : ""}
          </span>
        );
      })}
    </div>
  );
}

// The overtime column — for games that drag past 30 min with the build already full. Rendered as
// the natural continuation of the Lane→Late columns, but it's not a time slice and not one ranked
// list: at that point slots (not souls) are the constraint, so it reads as a *swap* — which standing
// low-tier slots to free (weakest first), the T3+ upgrades most players default into (adoption-
// admitted, like a phase core), and then the situational picks whose late edge is real but
// conditional on the game (their counter portraits carry the "when"). Items the build already
// commits to are filtered at generation — they're owned by now. Reuses ItemRow so each buy still
// carries its win-rate delta, counter portraits, and imbue/learn-more tags.
export function OvertimeColumn({
  build,
  items,
  counterByItem,
  enemiesById,
  imbueByItem,
  labOf,
}: {
  build: GeneratedBuild;
  items: Map<number, Item> | null;
  counterByItem: Map<number, ItemCounters>;
  enemiesById: Map<number, Hero>;
  imbueByItem: Map<number, ImbueTarget>;
  /** Roster-wide purchase context per item id (wp-stats bake) — see ItemRow's `lab`. */
  labOf?: (itemId: number) => LabWinState | undefined;
}) {
  const buys = build.overtimeBuys;
  if (!buys.length) return null;
  const staples = buys.filter((b) => b.role === "universal");
  const situational = buys.filter((b) => b.role !== "universal");
  const sell = build.overtimeSell;
  const row = (b: BuildItem, muted = false) => (
    <ItemRow
      key={b.item.id}
      b={b}
      items={items}
      baseline={build.population.baselineWinRate}
      counter={counterByItem.get(b.item.id)}
      enemiesById={enemiesById}
      imbue={imbueByItem.get(b.item.id)}
      lab={labOf?.(b.item.id)}
      muted={muted}
    />
  );
  return (
    <section className="phase overtime">
      <h2>
        Overtime buys <span className="time">build full · 30+ min</span>
      </h2>
      <div className="budget">
        Slots are the constraint now, not souls — free your weakest slots for
        what wins late.
      </div>
      {sell.length > 0 && (
        <div
          className="ot-sell"
          title="Your cheapest standing picks, weakest first — the slots to free when an overtime buy needs room."
        >
          Sell first: {sell.map((b) => b.item.name).join(" · ")}
        </div>
      )}
      {staples.length > 0 && (
        <>
          <h3 className="grouphdr core">Default upgrades</h3>
          {staples.map((b) => row(b))}
        </>
      )}
      {situational.length > 0 && (
        <>
          <h3
            className={`grouphdr situational ${staples.length === 0 ? "core" : ""}`}
          >
            If the game calls for it
          </h3>
          {situational.map((b) => row(b, true))}
        </>
      )}
    </section>
  );
}

export function CounterPicker({
  heroes,
  enemies,
  onAdd,
  onRemove,
}: {
  heroes: Hero[];
  enemies: number[];
  onAdd: (id: number) => void;
  onRemove: (id: number) => void;
}) {
  return (
    <div className="enemies">
      <span className="lbl">Counters vs</span>
      {enemies.map((id) => {
        const h = heroes.find((x) => x.id === id);
        return (
          <button
            className="chip"
            key={id}
            onClick={() => onRemove(id)}
            title="remove"
          >
            {h?.name ?? id} ✕
          </button>
        );
      })}
      {/* Fast path: type-and-Enter with fuzzy autocomplete (lib/fuzzy). */}
      <CounterQuickAdd heroes={heroes} enemies={enemies} onAdd={onAdd} />
      {/* Classic path: the exhaustive dropdown, kept alongside for browsing. */}
      <select
        value=""
        onChange={(e) => {
          if (e.target.value) onAdd(Number(e.target.value));
        }}
      >
        <option value="">+ add enemy…</option>
        {heroes
          .filter((h) => !enemies.includes(h.id))
          .map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
      </select>
    </div>
  );
}

export function SkillOrder({
  skill,
  abilities,
  slotOrder,
  settleRef,
}: {
  skill: SkillBuild;
  abilities: Map<number, Ability>;
  slotOrder: number[];
  settleRef?: Ref<HTMLElement>;
}) {
  // Rows in in-game slot order; fall back to upgrade order if slots are unknown.
  const present = new Set(skill.order);
  const rows = (slotOrder.length ? slotOrder : skill.maxPriority).filter((id) =>
    present.has(id),
  );
  const colorOf = (id: number) =>
    ABILITY_COLORS[rows.indexOf(id) % ABILITY_COLORS.length];
  const maxLabel = ["max 1st", "max 2nd", "max 3rd", "max 4th"];

  return (
    <section className="skills" ref={settleRef}>
      <h2>
        Skill order{" "}
        <span className="sub">
          the standard order · n={skill.sample.toLocaleString()} players
          {skill.lowSample && <span className="warn"> · ⚠ thin sample</span>}
        </span>
      </h2>
      <div
        className="skill-grid"
        style={{ ["--steps" as string]: skill.order.length }}
      >
        {rows.map((id) => {
          const a = abilities.get(id);
          const color = colorOf(id);
          const ri = skill.maxPriority.indexOf(id);
          return (
            <div className="skill-row" key={id}>
              <div className="srow-label" style={{ borderColor: color }}>
                {a?.image && <img src={a.image} alt="" loading="lazy" />}
                <div className="srow-info">
                  <span className="aname">{a?.name ?? id}</span>
                  <span className="amax">
                    {maxLabel[ri] ?? `max ${ri + 1}`}
                  </span>
                </div>
              </div>
              <div className="srow-cells">
                {skill.order.map((stepId, i) => {
                  const on = stepId === id;
                  return (
                    <span
                      key={i}
                      className={`pip ${on ? "on" : ""}`}
                      style={on ? { background: color } : undefined}
                      title={on ? `point ${i + 1}` : undefined}
                    >
                      {on ? i + 1 : ""}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function MatchupChip({
  m,
  hero,
  active,
  onClick,
  tough = false,
}: {
  m: Matchup;
  hero?: Hero;
  active: boolean;
  onClick: () => void;
  tough?: boolean;
}) {
  return (
    <button
      className={`mchip ${tough ? "tough" : "fav"} ${active ? "active" : ""}`}
      onClick={onClick}
      title={`${hero?.name ?? "?"}: ${(m.winRate * 100).toFixed(0)}% win rate (${m.delta >= 0 ? "+" : ""}${(m.delta * 100).toFixed(1)} vs avg), n=${m.sample.toLocaleString()}${m.laneCsDelta < -10 ? ` · they out-farm you by ~${Math.abs(Math.round(m.laneCsDelta))} CS in lane` : ""}`}
    >
      {hero?.image && <img src={hero.image} alt="" loading="lazy" />}
      <span className="mname">{hero?.name ?? m.enemyHeroId}</span>
      <span className="mwr">{(m.winRate * 100).toFixed(0)}%</span>
      {active && <span className="madd">✓</span>}
    </button>
  );
}
