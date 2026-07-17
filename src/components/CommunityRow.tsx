// A community-build row in the "Community check" panel, with its on-hover build preview.

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  our,
  ourIds,
  items,
  abilities,
  ourMaxOrder,
  slotOrder,
  agree = false,
}: {
  tag: string;
  rb: RankedCommunityBuild;
  our: { coreCount: number; situCount: number };
  ourIds: Set<number>;
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
            `${rb.shared} of your ${our.coreCount} core picks are in their ${coreSize}-item core.` +
            (our.situCount > 0
              ? ` Flex: ${rb.situShared} of your ${our.situCount} situational picks appear in their situational list (${total - coreSize} items) — secondary, not ranked.`
              : "")
          }
        >
          core {rb.shared}/{our.coreCount}
          {our.situCount > 0 && ` · flex ${rb.situShared}/${our.situCount}`}
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
          ourIds={ourIds}
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

// On-hover preview of a community build's items (slot-colored icons, our shared picks
// highlighted). Portaled + anchored like the item card so the row can't clip it, and
// kept off the default view so the page stays glanceable.
function BuildPreview({
  build,
  items,
  ourIds,
  abilities,
  ourMaxOrder,
  slotOrder,
  anchor,
  anchorName,
  sticky = false,
}: {
  build: CommunityBuild;
  items: Map<number, Item>;
  ourIds: Set<number>;
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

  const theirSet = new Set(build.itemIds);
  // Their items, shared-with-ours first so the overlap reads at a glance.
  const resolved = build.itemIds
    .map((id) => items.get(id))
    .filter((i): i is Item => !!i)
    .sort(
      (a, b) =>
        Number(ourIds.has(b.id)) - Number(ourIds.has(a.id)) ||
        a.slot.localeCompare(b.slot) ||
        a.cost - b.cost,
    );
  // Items we recommend that this build doesn't list at all.
  const missing = [...ourIds]
    .filter((id) => !theirSet.has(id))
    .map((id) => items.get(id))
    .filter((i): i is Item => !!i)
    .sort((a, b) => a.slot.localeCompare(b.slot) || a.cost - b.cost);
  const shared = ourIds.size - missing.length;

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

  const icon = (i: Item, cls: string) => (
    <span
      key={i.id}
      className={`bp-item ${cls}`}
      title={i.name}
      style={{ borderColor: SLOT_COLORS[i.slot] ?? SLOT_COLORS.unknown }}
    >
      {i.image ? <img src={i.image} alt="" loading="lazy" /> : null}
    </span>
  );

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
      <div className="bp-grid">
        {resolved.map((i) => icon(i, ourIds.has(i.id) ? "shared" : ""))}
      </div>
      {missing.length > 0 && (
        <>
          <div className="bp-sub">Only in our build ({missing.length})</div>
          <div className="bp-grid">
            {missing.map((i) => icon(i, "missing"))}
          </div>
        </>
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
      <div className="bp-foot">
        {shared} of your {ourIds.size} picks shared
        {missing.length > 0 ? ` · ${missing.length} only in ours` : ""}
      </div>
    </div>
  );

  // Native popovers render in the top layer from wherever they sit in the tree — no portal
  // needed (and staying in the tree keeps them inside the row for the touch-dismiss check).
  return SUPPORTS_ANCHOR ? card : createPortal(card, document.body);
}
