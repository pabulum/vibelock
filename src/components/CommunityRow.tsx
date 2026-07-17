// A community-build row in the "Community check" panel, with its on-hover build preview:
// a structured, color-coded diff of that build against ours (see diffBuild in lib/communityBuilds).

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { diffBuild } from "../lib/communityBuilds";
import { maxOrder } from "../lib/skills";
import type {
  Ability,
  CommunityBuild,
  Item,
  RankedCommunityBuild,
} from "../types";
import { ABILITY_COLORS, SLOT_COLORS } from "./colors";
import {
  CARD_GAP,
  SUPPORTS_ANCHOR,
  usePinnablePopover,
} from "./usePinnablePopover";

function fmtDate(unixS: number): string {
  return unixS ? new Date(unixS * 1000).toISOString().slice(0, 10) : "—";
}

function wrColor(wr: number): string {
  if (wr >= 0.56) return "#54c66b";
  if (wr >= 0.52) return "#a6cf57";
  if (wr >= 0.48) return "#d8c14a";
  return "#d87a7a";
}

export function CommunityRow({
  tag,
  rb,
  ourCoreIds,
  ourSituIds,
  items,
  abilities,
  ourMaxOrder,
  slotOrder,
  agree = false,
}: {
  tag: string;
  rb: RankedCommunityBuild;
  ourCoreIds: number[];
  ourSituIds: number[];
  items: Map<number, Item> | null;
  abilities?: Map<number, Ability> | null;
  ourMaxOrder?: number[];
  slotOrder: number[];
  agree?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { anchor, handlers, sticky, anchorName } = usePinnablePopover(ref);
  const [copied, setCopied] = useState(false);

  const coreSize = rb.build.coreItemIds.length;
  const total = rb.build.itemIds.length;

  const copyId = () => {
    navigator.clipboard?.writeText(String(rb.build.id)).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };

  return (
    <div
      ref={ref}
      className={`crow ${agree ? "agree" : ""}`}
      style={SUPPORTS_ANCHOR ? { anchorName } : undefined}
      {...handlers}
    >
      <span className="ctag">{tag}</span>
      <span className="cname" title={rb.build.name}>
        {rb.build.name}
      </span>
      <div className="cstats">
        <span className="cwr" style={{ color: wrColor(rb.winRate) }}>
          {(rb.winRate * 100).toFixed(0)}% WR
        </span>
        <span className="cmeta">n={rb.matches.toLocaleString()}</span>
        <span
          className="cmeta"
          title={`Jaccard overlap of our core picks with their core (shared ÷ combined). Ranks “most like ours”; their core is ${coreSize} of ${total} items.`}
        >
          {(rb.similarity * 100).toFixed(0)}% match
        </span>
        <span
          className="cmeta"
          title={
            `${rb.shared} of your ${ourCoreIds.length} core picks are in their ${coreSize}-item core.` +
            (ourSituIds.length > 0
              ? ` Flex: ${rb.situShared} of your ${ourSituIds.length} situational picks appear in their situational list (${total - coreSize} items) — secondary, not ranked.`
              : "")
          }
        >
          core {rb.shared}/{ourCoreIds.length}
          {ourSituIds.length > 0 &&
            ` · flex ${rb.situShared}/${ourSituIds.length}`}
        </span>
      </div>
      <div className="cfoot">
        <span className="cmeta">updated {fmtDate(rb.build.updatedAt)}</span>
        <button
          className="cid"
          onClick={(e) => {
            e.stopPropagation(); // on touch the row toggles the preview; copying shouldn't also toggle it
            copyId();
          }}
          title="Copy build ID — paste into the in-game build search"
        >
          {copied ? "copied ✓" : `#${rb.build.id}`}
        </button>
      </div>
      {anchor && items && (
        <BuildPreview
          build={rb.build}
          items={items}
          ourCoreIds={ourCoreIds}
          ourSituIds={ourSituIds}
          abilities={abilities}
          ourMaxOrder={ourMaxOrder}
          slotOrder={slotOrder}
          anchor={anchor}
          anchorName={anchorName}
          sticky={sticky}
        />
      )}
    </div>
  );
}

// On-hover preview: the structured diff of a community build against ours, one color per verdict —
// accent = both builds run it, amber = both run it but at different commitment (▼ our core is
// situational for them, ▲ their core is situational for us), green = their core picks we skip,
// red = our picks their menu doesn't list. Their situational-only tail collapses to a count: the
// kitchen-sink menu is exactly the noise the % match already refuses to rank on. Portaled +
// anchored like the item card so the row can't clip it.
function BuildPreview({
  build,
  items,
  ourCoreIds,
  ourSituIds,
  abilities,
  ourMaxOrder,
  slotOrder,
  anchor,
  anchorName,
  sticky = false,
}: {
  build: CommunityBuild;
  items: Map<number, Item>;
  ourCoreIds: number[];
  ourSituIds: number[];
  abilities?: Map<number, Ability> | null;
  ourMaxOrder?: number[];
  slotOrder: number[];
  anchor: DOMRect;
  /** The row's CSS `anchor-name`, for the native anchor-positioned path. */
  anchorName: string;
  /** Tap-pinned on touch: makes the preview a tappable/scrollable surface (see {@link usePinnablePopover}). */
  sticky?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Native path: top-layer + CSS anchor positioning (see `.buildprev[popover]`); no measuring.
  useLayoutEffect(() => {
    if (SUPPORTS_ANCHOR) ref.current?.showPopover();
  }, []);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (SUPPORTS_ANCHOR || !el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 8 - w));
    const top =
      anchor.bottom + CARD_GAP + h <= window.innerHeight
        ? anchor.bottom + CARD_GAP
        : Math.max(8, anchor.top - CARD_GAP - h);
    setPos({ left, top });
  }, [anchor]);

  const d = diffBuild(ourCoreIds, ourSituIds, build);
  // Shop order (slot, then cost) within every bucket, core-level entries before flex.
  const rows = (ids: number[]) =>
    ids
      .map((id) => items.get(id))
      .filter((i): i is Item => !!i)
      .sort((a, b) => a.slot.localeCompare(b.slot) || a.cost - b.cost);

  const icon = (i: Item, cls: string, title: string, flag?: string) => (
    <span
      key={i.id}
      className={`bp-item ${cls}`}
      title={`${i.name} — ${title}`}
      style={{ borderColor: SLOT_COLORS[i.slot] ?? SLOT_COLORS.unknown }}
    >
      {i.image ? <img src={i.image} alt="" loading="lazy" /> : null}
      {flag && (
        <span className="bp-flag" aria-hidden="true">
          {flag}
        </span>
      )}
    </span>
  );
  const agreeCells = [
    ...rows(d.agreeCore).map((i) => icon(i, "agree", "core in both builds")),
    ...rows(d.agreeFlex).map((i) =>
      icon(i, "agree dim", "situational in both builds"),
    ),
  ];
  const differCells = [
    ...rows(d.demoted).map((i) =>
      icon(i, "differ", "core for us, situational for them", "▼"),
    ),
    ...rows(d.promoted).map((i) =>
      icon(i, "differ", "situational for us, core for them", "▲"),
    ),
  ];
  const addedCells = rows(d.added).map((i) =>
    icon(i, "added", "in their core, not in our build"),
  );
  const missingCells = [
    ...rows(d.missingCore).map((i) =>
      icon(i, "missing", "our core pick, not in their build"),
    ),
    ...rows(d.missingFlex).map((i) =>
      icon(i, "missing dim", "our situational pick, not in their build"),
    ),
  ];
  const section = (label: string, kind: string, cells: ReactNode[]) =>
    cells.length > 0 && (
      <>
        <div className={`bp-sub ${kind}`}>
          {label} ({cells.length})
        </div>
        <div className="bp-grid">{cells}</div>
      </>
    );
  const counts = [
    [agreeCells.length, "agree"],
    [differCells.length, "differ on role"],
    [addedCells.length, "theirs only"],
    [missingCells.length, "ours only"],
  ] as const;
  const summary = counts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(" · ");

  // Their skill priority (which ability is maxed 1st→last), shown only in de-biased mode
  // (when ourMaxOrder is provided) so we can mark where their order diverges from ours.
  const theirMaxOrder =
    abilities && ourMaxOrder && build.skillOrder.length
      ? maxOrder(build.skillOrder)
      : [];
  const skillColor = (id: number) => {
    const i = slotOrder.indexOf(id);
    return ABILITY_COLORS[(i >= 0 ? i : 0) % ABILITY_COLORS.length];
  };

  const card = (
    <div
      ref={ref}
      popover={SUPPORTS_ANCHOR ? "manual" : undefined}
      className={`buildprev${sticky ? " sticky" : ""}`}
      style={
        SUPPORTS_ANCHOR
          ? { positionAnchor: anchorName }
          : { left: pos.left, top: pos.top }
      }
    >
      <div className="bp-head">
        <span className="bp-name">{build.name}</span>
        <span className="bp-id">#{build.id}</span>
      </div>
      {section("In both builds", "agree", agreeCells)}
      {section("Differ on role", "differ", differCells)}
      {section("Only in their core", "added", addedCells)}
      {section("Only in ours", "missing", missingCells)}
      {d.addedFlexCount > 0 && (
        <div className="bp-tail">
          + {d.addedFlexCount} more situational option
          {d.addedFlexCount === 1 ? "" : "s"} in their menu
        </div>
      )}
      {theirMaxOrder.length > 0 && abilities && (
        <>
          <div className="bp-sub">Skill priority (maxed 1st → last)</div>
          <div className="bp-skills">
            {theirMaxOrder.map((id, rank) => {
              const a = abilities.get(id);
              const moved = ourMaxOrder
                ? ourMaxOrder.indexOf(id) !== rank
                : false;
              const ourRank = ourMaxOrder ? ourMaxOrder.indexOf(id) : -1;
              return (
                <span
                  key={id}
                  className={`bp-skill ${moved ? "moved" : ""}`}
                  style={{ borderColor: skillColor(id) }}
                  title={`${a?.name ?? id} — maxed ${rank + 1}${
                    moved && ourRank >= 0
                      ? ` (you: ${ourRank + 1})`
                      : moved
                        ? " (not in yours)"
                        : " (same as yours)"
                  }`}
                >
                  {a?.image ? (
                    <img src={a.image} alt="" loading="lazy" />
                  ) : (
                    (a?.name ?? id)
                  )}
                  <span className="bp-skrank">{rank + 1}</span>
                </span>
              );
            })}
          </div>
        </>
      )}
      <div className="bp-foot">{summary || "no items to compare"}</div>
    </div>
  );

  // Native popovers render in the top layer from wherever they sit in the tree — no portal
  // needed (and staying in the tree keeps them inside the row for the touch-dismiss check).
  return SUPPORTS_ANCHOR ? card : createPortal(card, document.body);
}
