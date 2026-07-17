// Share card: a 1200×630 PNG summary of the current build, rendered client-side on a canvas so
// it can be copied straight into Discord (static hosting — there's no server to render one).
//
// Split in two layers on purpose:
//   - shareCardModel / shareLinks are pure (unit-tested in shareCard.test.ts): they reduce the
//     generated build + selection labels to exactly what the card shows, and build the URLs the
//     Share button hands out.
//   - drawShareCard is the impure canvas painter. Fail-soft throughout: any icon that won't load
//     (network, CORS) becomes a lettered placeholder tile, so the card always renders.

import type { BuildItem, GeneratedBuild, SlotType } from "../types";
import { SLOT_COLORS } from "../components/colors";
import { encodeUrlState, type UrlState } from "./urlState";

/** One item row on the card. `delta` is adjustedWinRate − hero baseline (the same ± the app rows
 * show); `transient` dims the row (a part/sell pick doesn't hold a slot). */
export interface ShareCardItem {
  name: string;
  image?: string;
  delta: number;
  slot: SlotType;
  transient?: boolean;
}

export interface ShareCardPhase {
  label: string;
  timeLabel: string;
  items: ShareCardItem[];
  /** Core picks that didn't fit the column's row budget. */
  more: number;
}

/** A fundamentals chip: the player's typical value + goodness percentile (higher = better). */
export interface ShareFundamental {
  label: string;
  value: string;
  percentile: number;
}

export interface ShareCardModel {
  heroName: string;
  heroImage?: string;
  /** Flex-hero build style ("Gun build"), omitted for mono heroes. */
  archLabel?: string;
  /** "Eternus · Update 2026-07-10 · 12,345 matches · avg WR 51%" */
  subtitle: string;
  /** "vs Seven, Haze" when a comp is selected. */
  enemiesLabel?: string;
  phases: ShareCardPhase[];
  /** Linked-profile fundamentals, when the sharer opted in. */
  fundamentals?: ShareFundamental[];
  /** Printed in the footer next to the wordmark, e.g. "pabulum.github.io/vibelock". */
  siteLabel: string;
}

/** Rows a phase column can fit before it overflows into "+N more". */
export const CARD_PHASE_ROWS = 6;

const toCardItem = (b: BuildItem, baseline: number): ShareCardItem => ({
  name: b.item.name,
  image: b.item.image,
  delta: b.adjustedWinRate - baseline,
  slot: b.item.slot,
  transient: b.transient,
});

/** Reduce the build the user is looking at (post comp re-rank) to the card's content. */
export function shareCardModel(
  build: GeneratedBuild,
  opts: {
    heroName: string;
    heroImage?: string;
    archLabel?: string;
    patchLabel: string;
    enemyNames?: string[];
    fundamentals?: ShareFundamental[];
    siteLabel: string;
  },
): ShareCardModel {
  const baseline = build.population.baselineWinRate;
  return {
    heroName: opts.heroName,
    heroImage: opts.heroImage,
    archLabel: opts.archLabel,
    subtitle: [
      build.rankLabel,
      opts.patchLabel,
      `${build.population.matches.toLocaleString("en-US")} matches`,
      `avg WR ${(baseline * 100).toFixed(0)}%`,
    ].join(" · "),
    enemiesLabel: opts.enemyNames?.length
      ? `vs ${opts.enemyNames.join(", ")}`
      : undefined,
    phases: build.phases.map((p) => ({
      label: p.label,
      timeLabel: p.timeLabel,
      items: p.core
        .slice(0, CARD_PHASE_ROWS)
        .map((b) => toCardItem(b, baseline)),
      more: Math.max(0, p.core.length - CARD_PHASE_ROWS),
    })),
    fundamentals: opts.fundamentals?.length ? opts.fundamentals : undefined,
    siteLabel: opts.siteLabel,
  };
}

/** The URLs the Share button can hand out for the current selection. `app` always works; `shim`
 * (the og/<hero>.html page baked at deploy — see scripts/bake-og-cards.mjs) is what unfurls with
 * a hero-specific card in Discord, and only exists when the hero was known at deploy time — the
 * caller checks the baked manifest before preferring it. Both carry the full query string; the
 * shim's inline script forwards it into the app so the link reproduces the exact selection. */
export function shareLinks(
  state: UrlState,
  origin: string,
  base: string,
): { app: string; shim?: string } {
  const q = encodeUrlState(state);
  return {
    app: `${origin}${base}${q}`,
    shim: state.hero ? `${origin}${base}og/${state.hero}.html${q}` : undefined,
  };
}

// ---- Canvas painter ----

/** CSS-pixel card size (the OG standard); drawn at 2× for a crisp Discord paste. */
export const CARD_W = 1200;
export const CARD_H = 630;
const SCALE = 2;

// The app's palette (App.css tokens), inlined: a canvas can't read CSS custom properties.
const BG = "#0f1216";
const PANEL = "#171b21";
const PANEL2 = "#1d222a";
const LINE = "#2a313b";
const TEXT = "#e6e9ee";
const MUTED = "#98a2b3";
const ACCENT = "#6fb1ff";

const FONT = "'Space Grotesk', system-ui, sans-serif";
const BODY = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** Same thresholds as ItemRow's deltaColor — the card and the app must tell one story. */
function deltaColor(d: number): string {
  if (d >= 0.04) return "#54c66b";
  if (d >= 0.02) return "#a6cf57";
  if (d >= -0.02) return "#d8c14a";
  return "#d87a7a";
}

function fmtDelta(d: number): string {
  const v = d * 100;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
}

function percentileColor(p: number): string {
  if (p >= 67) return "#54c66b";
  if (p >= 34) return "#d8c14a";
  return "#d87a7a";
}

/** Load an image CORS-clean for canvas use, or null to draw the placeholder instead. The asset
 * CDN varies on Origin and the page's plain <img> tags prime the HTTP cache with no-CORS
 * responses, so (exactly like lib/heroAccent) a marker param gives the canvas copy its own cache
 * entry that carries the ACAO header. */
function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    let src = url;
    try {
      const u = new URL(url);
      u.searchParams.set("vl-card", "1");
      src = u.href;
    } catch {
      // relative/odd URL — try it as-is
    }
    img.onerror = () => resolve(null);
    img.onload = () => resolve(img);
    img.src = src;
  });
}

function ellipsize(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW)
    t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

function rounded(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Cover-fit `img` into the given rounded box (portraits aren't square). */
function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.save();
  rounded(ctx, x, y, w, h, r);
  ctx.clip();
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

/** A lettered tile standing in for an icon that didn't load, tinted by item slot. */
function drawPlaceholder(
  ctx: CanvasRenderingContext2D,
  name: string,
  slot: SlotType,
  x: number,
  y: number,
  size: number,
) {
  rounded(ctx, x, y, size, size, 6);
  ctx.fillStyle = PANEL2;
  ctx.fill();
  ctx.strokeStyle = SLOT_COLORS[slot] ?? LINE;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = MUTED;
  ctx.font = `600 ${size * 0.5}px ${BODY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(name.charAt(0).toUpperCase(), x + size / 2, y + size / 2 + 1);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

/**
 * Paint the card and resolve with the finished canvas (1200×630 CSS px at 2×). Icon/portrait
 * loads run first so the paint itself is synchronous; any failures degrade to placeholders.
 */
export async function drawShareCard(
  model: ShareCardModel,
): Promise<HTMLCanvasElement> {
  // Make sure the wordmark font is usable on the canvas before measuring/painting; ignore
  // failures (the system fallback still reads fine).
  try {
    await Promise.all([
      document.fonts.load(`700 46px ${FONT}`),
      document.fonts.load(`700 21px ${FONT}`),
    ]);
  } catch {
    // font loading is best-effort
  }

  const urls = new Set<string>();
  if (model.heroImage) urls.add(model.heroImage);
  for (const p of model.phases)
    for (const it of p.items) if (it.image) urls.add(it.image);
  const loaded = new Map<string, HTMLImageElement | null>(
    await Promise.all(
      [...urls].map(
        async (u) => [u, await loadImage(u)] as [string, HTMLImageElement | null],
      ),
    ),
  );

  const canvas = document.createElement("canvas");
  canvas.width = CARD_W * SCALE;
  canvas.height = CARD_H * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.scale(SCALE, SCALE);

  // Background + a whisper of accent along the top edge.
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  const glow = ctx.createLinearGradient(0, 0, 0, 130);
  glow.addColorStop(0, "rgba(111, 177, 255, 0.10)");
  glow.addColorStop(1, "rgba(111, 177, 255, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, CARD_W, 130);

  const PAD = 36;

  // ---- Header: portrait, name (+ style), selection line ----
  const face = model.heroImage ? loaded.get(model.heroImage) : null;
  const FACE = 92;
  let tx = PAD;
  if (face) {
    drawCover(ctx, face, PAD, 30, FACE, FACE, 12);
    rounded(ctx, PAD, 30, FACE, FACE, 12);
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    tx = PAD + FACE + 22;
  }
  ctx.fillStyle = TEXT;
  ctx.font = `700 46px ${FONT}`;
  ctx.fillText(model.heroName, tx, 74);
  if (model.archLabel) {
    const nameW = ctx.measureText(model.heroName).width;
    ctx.font = `600 17px ${BODY}`;
    const w = ctx.measureText(model.archLabel).width;
    const bx = tx + nameW + 16;
    rounded(ctx, bx, 52, w + 20, 28, 14);
    ctx.fillStyle = "rgba(111, 177, 255, 0.14)";
    ctx.fill();
    ctx.fillStyle = ACCENT;
    ctx.fillText(model.archLabel, bx + 10, 71);
  }
  ctx.fillStyle = MUTED;
  ctx.font = `400 17px ${BODY}`;
  let sub = model.subtitle;
  if (model.enemiesLabel) sub += `  ·  ${model.enemiesLabel}`;
  ctx.fillText(ellipsize(ctx, sub, CARD_W - tx - PAD), tx, 104);

  // ---- Phase columns ----
  const hasFun = !!model.fundamentals;
  const colsTop = 142;
  const colsBottom = hasFun ? 508 : 566;
  const GAP = 14;
  const n = Math.max(1, model.phases.length);
  const colW = (CARD_W - PAD * 2 - GAP * (n - 1)) / n;

  model.phases.forEach((phase, i) => {
    const x = PAD + i * (colW + GAP);
    rounded(ctx, x, colsTop, colW, colsBottom - colsTop, 12);
    ctx.fillStyle = PANEL;
    ctx.fill();
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1;
    ctx.stroke();

    const ix = x + 16;
    ctx.fillStyle = TEXT;
    ctx.font = `700 21px ${FONT}`;
    ctx.fillText(phase.label, ix, colsTop + 32);
    ctx.fillStyle = MUTED;
    ctx.font = `400 13px ${BODY}`;
    ctx.textAlign = "right";
    ctx.fillText(phase.timeLabel, x + colW - 16, colsTop + 32);
    ctx.textAlign = "left";
    ctx.strokeStyle = LINE;
    ctx.beginPath();
    ctx.moveTo(ix, colsTop + 44);
    ctx.lineTo(x + colW - 16, colsTop + 44);
    ctx.stroke();

    const ICON = 32;
    const rowH = 46;
    phase.items.forEach((it, r) => {
      const y = colsTop + 58 + r * rowH;
      ctx.globalAlpha = it.transient ? 0.55 : 1;
      const img = it.image ? loaded.get(it.image) : null;
      if (img) {
        drawCover(ctx, img, ix, y, ICON, ICON, 6);
        rounded(ctx, ix, y, ICON, ICON, 6);
        ctx.strokeStyle = SLOT_COLORS[it.slot] ?? LINE;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        drawPlaceholder(ctx, it.name, it.slot, ix, y, ICON);
      }
      const deltaTxt = fmtDelta(it.delta);
      ctx.font = `600 14px ${BODY}`;
      const dw = ctx.measureText(deltaTxt).width;
      ctx.fillStyle = deltaColor(it.delta);
      ctx.textAlign = "right";
      ctx.fillText(deltaTxt, x + colW - 16, y + 21);
      ctx.textAlign = "left";
      ctx.fillStyle = TEXT;
      ctx.font = `400 15px ${BODY}`;
      const nameW = x + colW - 16 - dw - 10 - (ix + ICON + 10);
      ctx.fillText(ellipsize(ctx, it.name, nameW), ix + ICON + 10, y + 21);
      ctx.globalAlpha = 1;
    });
    if (phase.more > 0) {
      ctx.fillStyle = MUTED;
      ctx.font = `400 13px ${BODY}`;
      ctx.fillText(
        `+${phase.more} more`,
        ix,
        colsTop + 58 + phase.items.length * rowH + 16,
      );
    }
  });

  // ---- Fundamentals strip (opt-in, linked profile only) ----
  if (model.fundamentals) {
    const y = colsBottom + 12;
    const h = 46;
    rounded(ctx, PAD, y, CARD_W - PAD * 2, h, 12);
    ctx.fillStyle = PANEL2;
    ctx.fill();
    ctx.strokeStyle = LINE;
    ctx.stroke();
    let cx = PAD + 16;
    ctx.font = `600 13px ${BODY}`;
    ctx.fillStyle = MUTED;
    ctx.fillText("MY FUNDAMENTALS", cx, y + 28);
    cx += ctx.measureText("MY FUNDAMENTALS").width + 22;
    for (const f of model.fundamentals) {
      const label = `${f.label} ${f.value}`;
      const pct = `p${f.percentile}`;
      ctx.font = `400 15px ${BODY}`;
      const lw = ctx.measureText(label).width;
      ctx.font = `600 15px ${BODY}`;
      const pw = ctx.measureText(pct).width;
      if (cx + lw + pw + 30 > CARD_W - PAD) break; // out of room — drop the tail
      ctx.fillStyle = TEXT;
      ctx.font = `400 15px ${BODY}`;
      ctx.fillText(label, cx, y + 29);
      ctx.fillStyle = percentileColor(f.percentile);
      ctx.font = `600 15px ${BODY}`;
      ctx.fillText(pct, cx + lw + 6, y + 29);
      cx += lw + pw + 30;
    }
  }

  // ---- Footer: wordmark + site ----
  const fy = CARD_H - 22;
  ctx.fillStyle = TEXT;
  ctx.font = `700 20px ${FONT}`;
  ctx.fillText("Vibelock", PAD, fy);
  ctx.fillStyle = MUTED;
  ctx.font = `400 15px ${BODY}`;
  ctx.fillText(
    model.siteLabel,
    PAD + ctx.measureText("Vibelock").width + 74,
    fy,
  );
  ctx.textAlign = "right";
  ctx.fillText("data-driven Deadlock builds", CARD_W - PAD, fy);
  ctx.textAlign = "left";

  return canvas;
}
