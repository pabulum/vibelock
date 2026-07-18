// The build itself: one column per time phase (core "Build" + "Situational swaps" + folded-in
// counter picks) then the overtime buy-list column. Each row is an ItemRow carrying its win-rate
// delta, counter portraits, and imbue/lab tags.
import "./PhaseColumns.css";
import type { Ref } from "react";
import { phaseTempo, type LabWinState } from "../lib/buildGenerator";
import type { WpStats } from "../api/wpStats";
import { CounterAddRow, ItemRow } from "../components/ItemRow";
import { CategoryBar, OvertimeColumn, PhaseTempoLines } from "../components/panels";
import type {
  BuildItem,
  BuildPhase,
  GeneratedBuild,
  Hero,
  ImbueTarget,
  Item,
  ItemCounters,
  ItemRef,
} from "../types";
import type { AdoptionMover } from "../lib/patchMovers";

const COUNTER_ADDS_PER_PHASE = 3; // cap on counter-only picks folded into a phase's swaps

// Midpoint of each flow column's fixed time window (Lane 0–9, Early mid 9–20, Mid 20–30, 30+) —
// where the phase's "typical lead ≈ X% win" note reads the baked WP surface.
const PHASE_MID_S = [270, 870, 1500, 2100];

/** What a typical (one-sigma) team soul lead is worth at this phase's midpoint, from the Lab's
 * win-probability model: the per-phase answer to "do leads even matter yet?". Null when the
 * surface has no bin for the time (shouldn't happen — bins cover 0–∞). */
function leadNote(
  wp: WpStats,
  col: number,
): { souls: number; pct: number } | null {
  const t = PHASE_MID_S[col] ?? PHASE_MID_S[PHASE_MID_S.length - 1];
  const bin = wp.wpModel.find(
    (b) => t >= b.fromS && (b.toS === null || t < b.toS),
  );
  if (!bin) return null;
  return {
    souls: bin.sigma,
    pct: Math.round(100 / (1 + Math.exp(-(bin.w0 + bin.w1)))),
  };
}

/** Compact souls figure for the lead note: 1199 → "1.2k", 12304 → "12k". */
function fmtSouls(s: number): string {
  return s >= 10000 ? `${Math.round(s / 1000)}k` : `${(s / 1000).toFixed(1)}k`;
}

/** The core pick a counter item should swap in for: the weakest same-slot core item for this
 * comp (lowest comp-aware score) — the one to drop to make room. */
function swapTargetFor(
  phase: BuildPhase,
  c: ItemCounters,
  baseline: number,
): ItemRef | undefined {
  // Only a non-staple core pick is a fair thing to drop for an experimental counter.
  const slotCore = phase.core.filter(
    (b) => b.item.slot === c.item.slot && b.role !== "universal",
  );
  if (!slotCore.length) return undefined;
  const sc = (b: BuildItem) => (b.compEdge ?? 0) + (b.adjustedWinRate - baseline);
  const worst = slotCore.reduce((w, b) => (sc(b) < sc(w) ? b : w));
  return { id: worst.item.id, name: worst.item.name };
}

export function PhaseColumns(props: {
  shownBuild: GeneratedBuild;
  items: Map<number, Item> | null;
  counterByItem: Map<number, ItemCounters>;
  countersByPhase: Map<string, ItemCounters[]>;
  buildItemIds: Set<number>;
  enemiesById: Map<number, Hero>;
  imbueByItem: Map<number, ImbueTarget>;
  trendingByItem: Map<number, AdoptionMover>;
  wpStats: WpStats | null;
  labOf: ((itemId: number) => LabWinState | undefined) | undefined;
  buildRef: Ref<HTMLElement>;
}) {
  const {
    shownBuild,
    items,
    counterByItem,
    countersByPhase,
    buildItemIds,
    enemiesById,
    imbueByItem,
    trendingByItem,
    wpStats,
    labOf,
    buildRef,
  } = props;

  return (
    <main className="phases" ref={buildRef}>
      {shownBuild.phases.map((phase) => {
        // Strong counter picks that file under this phase but aren't already in the build
        // get mixed into the situational list (capped); ones already shown get a portrait
        // tag in place instead, so nothing is duplicated and the page doesn't sprout
        // separate counter sections.
        const counterAdds = (countersByPhase.get(phase.label) ?? [])
          .filter((c) => !buildItemIds.has(c.item.id))
          .slice(0, COUNTER_ADDS_PER_PHASE);
        const lead = wpStats ? leadNote(wpStats, phase.column) : null;
        return (
          <section
            className="phase"
            key={phase.column}
            // Named per column so a hero/rank switch cross-fades each column independently
            // inside the view transition (see switchTransition).
            style={{ viewTransitionName: `phase-${phase.column}` }}
          >
            <h2>
              {phase.label} <span className="time">{phase.timeLabel}</span>
            </h2>
            <div className="budget">
              {phase.itemsBought}/{phase.targetItems} items ·{" "}
              {Math.round(phase.coreSouls).toLocaleString()} /{" "}
              {Math.round(phase.soulBudget).toLocaleString()} souls
              {lead && (
                <span
                  className="wpnote"
                  title={`From the Lab's win-probability model (refit nightly): mid-phase, a team up ${lead.souls.toLocaleString()} souls — a typical lead for this stage — wins ~${lead.pct}% of its games. Leads barely convert in lane and peak past 25 minutes: the higher this number, the more a lead is worth protecting.`}
                >
                  {" "}
                  · {fmtSouls(lead.souls)} lead ≈ {lead.pct}% win
                </span>
              )}
            </div>
            <CategoryBar split={phase.categorySouls} />

            <PhaseTempoLines
              tempo={phaseTempo(
                phase,
                shownBuild.population.baselineWinRate,
                labOf,
              )}
            />

            <h3 className="grouphdr core">Build</h3>
            {phase.core.length ? (
              phase.core.map((b) => (
                <ItemRow
                  key={b.item.id}
                  b={b}
                  items={items}
                  baseline={shownBuild.population.baselineWinRate}
                  counter={counterByItem.get(b.item.id)}
                  enemiesById={enemiesById}
                  imbue={imbueByItem.get(b.item.id)}
                  trending={trendingByItem.get(b.item.id)}
                  lab={labOf?.(b.item.id)}
                />
              ))
            ) : (
              <p className="empty">No clear staple here.</p>
            )}

            <h3 className="grouphdr situational">Situational swaps</h3>
            {phase.situational.map((b) => (
              <ItemRow
                key={b.item.id}
                b={b}
                items={items}
                baseline={shownBuild.population.baselineWinRate}
                counter={counterByItem.get(b.item.id)}
                enemiesById={enemiesById}
                imbue={imbueByItem.get(b.item.id)}
                trending={trendingByItem.get(b.item.id)}
                lab={labOf?.(b.item.id)}
                muted
              />
            ))}
            {counterAdds.map((c) => (
              <CounterAddRow
                key={c.item.id}
                c={c}
                items={items}
                enemiesById={enemiesById}
                swapFor={swapTargetFor(
                  phase,
                  c,
                  shownBuild.population.baselineWinRate,
                )}
              />
            ))}
            {phase.situational.length === 0 && counterAdds.length === 0 && (
              <p className="empty">—</p>
            )}
          </section>
        );
      })}
      <OvertimeColumn
        build={shownBuild}
        items={items}
        counterByItem={counterByItem}
        enemiesById={enemiesById}
        imbueByItem={imbueByItem}
        labOf={labOf}
      />
    </main>
  );
}
