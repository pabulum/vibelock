// The generator-verdict card: why an item is (or isn't) in the current build, rendered from the
// pure ItemVerdict data (lib/buildgen/verdict). A ModalShell dialog, deliberately palette-agnostic
// — anything that can name an item and a verdict can open one (the command palette's "why isn't X
// here" is just the first caller).

import type { ItemVerdict, VerdictStats } from "../lib/buildGenerator";
import type { Item } from "../types";
import { SLOT_COLORS } from "./colors";
import { ModalShell } from "./ModalShell";

const pt = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}pt`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** The verdict headline + explanation, per gate. Kept as data so the card body stays one shape. */
function verdictCopy(v: ItemVerdict, itemName: string): { head: string; body: string } {
  switch (v.kind) {
    case "in-build":
      return {
        head:
          v.where === "core"
            ? `It is here — a core pick in ${v.phaseLabel}.`
            : v.where === "situational"
              ? `It is here — a situational option in ${v.phaseLabel}.`
              : "It is here — on the overtime shopping list.",
        body: "Nothing was gated; use the palette's jump to find its row.",
      };
    case "no-data":
      return {
        head: "No data — players at this rank and patch don't buy it on this hero.",
        body: "The generator can only rank what the population actually plays; an item nobody buys has no win-rate evidence to score.",
      };
    case "sample-floor":
      return {
        head: `Sample floor — only ${v.players.toLocaleString()} buyers, below the ${v.floor.toLocaleString()}-player support floor.`,
        body: "Too few players buy it in any phase to read a win rate that isn't noise, so it's excluded before scoring rather than ranked on a coin-flip number.",
      };
    case "either-or":
      return {
        head: `Either/or with ${v.winner.name} — players buy one or the other, and ${v.winner.name} holds the shared slot.`,
        body:
          `The two are same-slot, comparable-cost staples that demonstrably aren't bought together` +
          (v.overlap !== undefined
            ? ` (only ${Math.round(v.overlap * 100)}% of the smaller camp buys both)`
            : "") +
          `, so they contest one core slot. ${v.winner.name} wins ${pct(v.winnerWr)} vs ${itemName}'s ${pct(v.stats.adjustedWinRate)}; unseating an incumbent takes a significant edge, not a nominal one.`,
      };
    case "popular-but-losing":
      return {
        head: `Popular but losing — its buyers run ~${(v.contrast * 100).toFixed(1)}pt behind the players who skip it.`,
        body: "A staple's observable edge is compressed by its own popularity, so the generator judges the implied buyer-vs-non-buyer contrast instead — and here it's significantly negative, which revokes the automatic core seat popularity would otherwise grant.",
      };
    case "below-baseline":
      return {
        head: `Below baseline — ${pt(v.stats.adjustedWinRate - v.stats.baseline)} marginal win rate vs the hero's average.`,
        body: "The fill would rather leave a slot empty than seat a pick whose buyers win less than the hero's baseline: the category share is a soft bias, not a quota, and a losing pick never fills it.",
      };
    case "lost-slot":
      return {
        head: v.beatenBy
          ? `Lost the slot contest — ${v.beatenBy.name} outranked it for the last ${v.stats.phaseLabel} slot.`
          : `Lost the slot contest — ${v.stats.phaseLabel}'s slots went to higher-ranked picks.`,
        body:
          `It clears every gate (support, win rate, no substitute conflict) but the phase seats a fixed number of items, ranked by the shrunk, cost-aware win-rate edge` +
          (v.beatenBy && v.beatenByWr !== undefined
            ? ` — and ${v.beatenBy.name} (${pct(v.beatenByWr)}) still scores ahead of it`
            : "") +
          ". A patch or rank where its edge firms up would seat it.",
      };
  }
}

/** The one-line evidence strip under the headline (hidden for membership/no-data verdicts). */
function statsOf(v: ItemVerdict): VerdictStats | null {
  return v.kind === "in-build" || v.kind === "no-data" ? null : v.stats;
}

export function VerdictCard({
  item,
  verdict,
  onClose,
}: {
  item: Item;
  verdict: ItemVerdict;
  onClose: () => void;
}) {
  const { head, body } = verdictCopy(verdict, item.name);
  const stats = statsOf(verdict);
  const color = SLOT_COLORS[item.slot] ?? SLOT_COLORS.unknown;
  return (
    <ModalShell
      className="verdict"
      label={`Why isn't ${item.name} in the build?`}
      title={
        <span className="verdict-title">
          <span className="verdict-icon" style={{ background: color }}>
            {item.image ? <img src={item.image} alt="" /> : null}
          </span>
          Why isn&rsquo;t {item.name} here?
        </span>
      }
      onClose={onClose}
    >
      <p className="verdict-head">{head}</p>
      {stats && (
        <div className="verdict-stats">
          <span title="The phase the verdict was judged in — where most of its buyers buy it.">
            {stats.phaseLabel}
          </span>
          <span title="Fraction of players still buying in that phase who pick it.">
            {Math.round(stats.pickRate * 100)}% pick
          </span>
          <span title="Adjusted win rate vs the hero's baseline.">
            {pct(stats.adjustedWinRate)} WR ({pt(stats.adjustedWinRate - stats.baseline)})
          </span>
          <span title="What that edge is worth after shrinking for sample size — the number the ranking actually used.">
            {pt(stats.lcbEdge)} shrunk
          </span>
          <span title="Decided games behind the win rate.">
            n={Math.round(stats.decided).toLocaleString()}
          </span>
        </div>
      )}
      <p className="verdict-body">{body}</p>
    </ModalShell>
  );
}
