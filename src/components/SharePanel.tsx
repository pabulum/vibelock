// "Share this build" — renders the build-summary card (lib/shareCard) onto a canvas, with
// copy-to-clipboard for Discord and a share link. The link prefers the per-hero og/<hero>.html
// shim (baked at deploy; unfurls with a hero-specific card since OG crawlers don't run JS) and
// falls back to the plain app URL when the shim isn't baked — a hero newer than the last deploy,
// or the dev server. Which shims exist is read from og/manifest.json, written by the same bake.

import { useEffect, useRef, useState } from "react";
import {
  drawShareCard,
  type ShareCardModel,
  type ShareFundamental,
} from "../lib/shareCard";
import { ModalShell } from "./ModalShell";

// ClipboardItem is present in all evergreen browsers but easy to feature-check, and Safari
// wants the blob *promise* handed to it inside the user gesture — so the canvas encode isn't
// awaited before constructing the item.
const canCopyImage =
  typeof ClipboardItem !== "undefined" && !!navigator.clipboard?.write;

/** The baked shim slugs, fetched once per session (fail-soft: no manifest ⇒ no shims — the
 * Vite dev server answers this with index.html, which fails JSON parse and lands here too). */
let shimSlugs: Promise<Set<string>> | null = null;
function bakedShims(base: string): Promise<Set<string>> {
  shimSlugs ??= fetch(`${base}og/manifest.json`)
    .then((r) => (r.ok ? r.json() : []))
    .then((v: unknown) =>
      Array.isArray(v) ? new Set(v.filter((s) => typeof s === "string")) : new Set<string>(),
    )
    .catch(() => new Set<string>());
  return shimSlugs;
}

function pngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))),
      "image/png",
    ),
  );
}

export function SharePanel({
  model,
  fundamentals,
  heroSlug,
  links,
  onClose,
}: {
  /** Card content, without the fundamentals strip (toggled here). */
  model: ShareCardModel;
  /** The sharer's benchmark rows — offered as an opt-in strip when a profile is linked. */
  fundamentals?: ShareFundamental[];
  heroSlug?: string;
  links: { app: string; shim?: string };
  onClose: () => void;
}) {
  const [includeFun, setIncludeFun] = useState(false);
  const [status, setStatus] = useState("");
  const [shareUrl, setShareUrl] = useState(links.app);
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Resolve the link once: the shim only when its page was actually baked.
  useEffect(() => {
    if (!links.shim || !heroSlug) return;
    let live = true;
    bakedShims(import.meta.env.BASE_URL).then((slugs) => {
      if (live && slugs.has(heroSlug)) setShareUrl(links.shim!);
    });
    return () => {
      live = false;
    };
  }, [links.shim, heroSlug]);

  // (Re)paint the card whenever the fundamentals toggle flips. Drawing is async (icon loads);
  // a stale paint is dropped rather than raced into the DOM.
  useEffect(() => {
    let live = true;
    const withFun = includeFun && fundamentals?.length;
    drawShareCard(withFun ? { ...model, fundamentals } : model)
      .then((canvas) => {
        if (!live) return;
        canvasRef.current = canvas;
        canvas.className = "share-preview";
        holderRef.current?.replaceChildren(canvas);
      })
      .catch(() => {
        if (live) setStatus("Couldn't render the card in this browser.");
      });
    return () => {
      live = false;
    };
  }, [model, fundamentals, includeFun]);

  const copyImage = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": pngBlob(canvas) }),
      ]);
      setStatus("Image copied — paste it into Discord.");
    } catch {
      setStatus("Copy failed — use Download instead.");
    }
  };

  const download = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `vibelock-${heroSlug ?? "build"}.png`;
    a.click();
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setStatus(
        shareUrl === links.shim
          ? "Link copied — it unfurls with this hero's card."
          : "Link copied.",
      );
    } catch {
      setStatus("Copy failed — select the link text below and copy it.");
    }
  };

  return (
    <ModalShell
      className="share"
      label="Share this build"
      title="Share this build"
      onClose={onClose}
    >
      <div className="share-holder" ref={holderRef} aria-label="Card preview" />
      {!!fundamentals?.length && (
        <label className="share-fun">
          <input
            type="checkbox"
            checked={includeFun}
            onChange={(e) => setIncludeFun(e.target.checked)}
          />
          Include my fundamentals (souls/min, deaths… vs the ladder)
        </label>
      )}
      <div className="share-actions">
        {canCopyImage && (
          <button type="button" className="export-go" onClick={copyImage}>
            Copy image
          </button>
        )}
        <button type="button" className="export-go" onClick={download}>
          Download PNG
        </button>
        <button type="button" className="export-go" onClick={copyLink}>
          Copy link
        </button>
      </div>
      <p className="share-url" title={shareUrl}>
        {shareUrl}
      </p>
      {status && <p className="export-status done">{status}</p>}
    </ModalShell>
  );
}
