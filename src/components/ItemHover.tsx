// The item shop card popover: a row/cell wrapper that reveals the full card on hover (or tap).

import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { SLOT_COLORS } from "./colors";
import type { Hero, Item, ItemCounters, ItemRef } from "../types";
import {
  CARD_GAP,
  SUPPORTS_ANCHOR,
  usePinnablePopover,
} from "./usePinnablePopover";

// A row/cell that reveals the item's full shop card on hover (or tap, on touch). It *is* the styled
// element (className/style passed through), so there's no extra wrapper. The card is rendered in a
// portal (anchored to this element's rect) so the row can't clip it.
export function ItemHover({
  item,
  items,
  className,
  style,
  children,
  counter,
  enemiesById,
  buildsToward,
  rowId,
}: {
  item: Item;
  items: Map<number, Item> | null;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  /** When set, the hover card also shows this item's per-enemy counter breakdown. */
  counter?: ItemCounters;
  enemiesById?: Map<number, Hero>;
  /** The item this builds toward (shown as an upgrade-path line in the hover card). */
  buildsToward?: ItemRef;
  /** Marks the element as a jump target (`data-item-row`) for the palette's item jump. */
  rowId?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { anchor, handlers, sticky, anchorName } = usePinnablePopover(ref);

  return (
    <div
      ref={ref}
      className={className}
      style={SUPPORTS_ANCHOR ? { ...style, anchorName } : style}
      data-item-row={rowId}
      {...handlers}
    >
      {children}
      {anchor && (
        <ItemCard
          item={item}
          items={items}
          anchor={anchor}
          anchorName={anchorName}
          counter={counter}
          enemiesById={enemiesById}
          buildsToward={buildsToward}
          sticky={sticky}
        />
      )}
    </div>
  );
}

function ItemCard({
  item,
  items,
  anchor,
  anchorName,
  counter,
  enemiesById,
  buildsToward,
  sticky = false,
}: {
  item: Item;
  items: Map<number, Item> | null;
  anchor: DOMRect;
  /** The trigger's CSS `anchor-name`, for the native anchor-positioned path. */
  anchorName: string;
  counter?: ItemCounters;
  enemiesById?: Map<number, Hero>;
  buildsToward?: ItemRef;
  /** Tap-pinned on touch: becomes tappable/scrollable (not a pass-through tooltip) so a tall
   * card can be read and scrolled on a phone. See {@link ItemHover} and `.itemcard.sticky`. */
  sticky?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Native path: promote to the top layer on mount; unmounting dismisses it automatically.
  // Placement (side flip + viewport clamp) is entirely CSS — see `.itemcard[popover]`.
  useLayoutEffect(() => {
    if (SUPPORTS_ANCHOR) ref.current?.showPopover();
  }, []);
  // Fallback path: render off-screen first, then measure to flip left/right and clamp vertically.
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (SUPPORTS_ANCHOR || !el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const left =
      anchor.right + CARD_GAP + w <= window.innerWidth
        ? anchor.right + CARD_GAP
        : Math.max(8, anchor.left - CARD_GAP - w);
    const top = Math.max(8, Math.min(anchor.top, window.innerHeight - 8 - h));
    setPos({ left, top });
  }, [anchor]);

  const color = SLOT_COLORS[item.slot] ?? SLOT_COLORS.unknown;
  const components = item.componentIds
    .map((id) => items?.get(id)?.name)
    .filter((n): n is string => !!n);

  const card = (
    <div
      ref={ref}
      popover={SUPPORTS_ANCHOR ? "manual" : undefined}
      className={`itemcard${sticky ? " sticky" : ""}`}
      style={
        SUPPORTS_ANCHOR
          ? { positionAnchor: anchorName, borderColor: color }
          : { left: pos.left, top: pos.top, borderColor: color }
      }
    >
      <div className="ic-head" style={{ background: color }}>
        {item.image && <img src={item.image} alt="" />}
        <div className="ic-title">
          <span className="ic-name">{item.name}</span>
          <span className="ic-sub">
            T{item.tier} · {item.cost.toLocaleString()} souls
          </span>
        </div>
      </div>

      {counter && enemiesById && counter.marks.length > 0 && (
        <div className="ic-counter">
          <span className="ic-kind">Edge vs this comp</span>
          <ul>
            {counter.marks.map((m) => {
              const h = enemiesById.get(m.enemyHeroId);
              return (
                <li key={m.enemyHeroId}>
                  {h?.image && <img src={h.image} alt="" />}
                  <span className="cn">{h?.name ?? `#${m.enemyHeroId}`}</span>
                  <span className="cd">+{(m.delta * 100).toFixed(1)}</span>
                  <span className="cw">
                    {(m.winRate * 100).toFixed(0)}% WR
                    {m.lowSample ? " · thin" : ""}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="ic-note">
            Win-rate gain above the general matchup, vs each enemy.
          </p>
        </div>
      )}

      {item.card?.sections.map((s, i) => (
        <div className={`ic-sec ${s.kind}`} key={i}>
          {s.kind !== "innate" && (
            <span className="ic-kind">
              {s.kind === "active" ? "Active" : "Passive"}
            </span>
          )}
          {s.text && s.text.length > 0 && (
            <p className="ic-text">
              {s.text.map((seg, j) =>
                seg.highlight ? (
                  <strong key={j}>{seg.text}</strong>
                ) : (
                  <span key={j}>{seg.text}</span>
                ),
              )}
            </p>
          )}
          {s.stats.length > 0 && (
            <ul className="ic-stats">
              {s.stats.map((st, j) => (
                <li key={j} className={st.strong ? "strong" : undefined}>
                  <span className="v">{st.value}</span> {st.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      {!item.card && item.effect && (
        <p className="ic-text plain">{item.effect}</p>
      )}
      {components.length > 0 && (
        <div className="ic-comp">Builds from: {components.join(", ")}</div>
      )}
      {buildsToward && (
        <div className="ic-comp">Most build toward: {buildsToward.name}</div>
      )}
    </div>
  );

  // Native popovers render in the top layer from wherever they sit in the tree — no portal
  // needed (and staying in the tree keeps them inside the trigger for the touch-dismiss check).
  return SUPPORTS_ANCHOR ? card : createPortal(card, document.body);
}
