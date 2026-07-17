// Per-hero accent: derive a UI accent color from the hero's portrait with a one-time canvas
// sample. The portrait is downscaled to a tiny canvas, its hues histogrammed weighted by
// chroma (so the character's costume/glow wins over the gray backdrop), and the dominant hue
// re-emitted at a fixed saturation/lightness — every hero's accent then sits at the same
// readable contrast against the dark UI, only the hue changes. Fail-soft throughout: any
// load/CORS/canvas problem resolves to null and the default accent stays.

/** Downscale size in px — enough pixels for a stable dominant hue, trivial to scan. */
const SAMPLE = 24;
/** 30° hue buckets: coarse enough that one costume color aggregates, fine enough to differ. */
const BUCKETS = 12;
/** The winning bucket must carry at least this mean chroma per pixel, or the portrait is
 * effectively colorless (gray/sepia art) and the default accent reads better. */
const MIN_WEIGHT = 0.02 * SAMPLE * SAMPLE;

const inflight = new Map<string, Promise<string | null>>();

const storageKey = (url: string) => `vibelock:accent:${url}`;

function sample(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    // The portrait CDN sends `access-control-allow-origin: *`; anonymous keeps the canvas
    // untainted so getImageData is allowed. If that ever changes, onerror/catch bail to null.
    img.crossOrigin = "anonymous";
    // The CDN varies on Origin, and the page's plain <img> tags have already primed the HTTP
    // cache with a no-CORS response for the bare URL — reusing it would fail the CORS check.
    // A marker param gives this one-time sample its own cache entry with the ACAO header.
    let src = url;
    try {
      const u = new URL(url);
      u.searchParams.set("vl-accent", "1");
      src = u.href;
    } catch {
      // not an absolute URL — sample it as-is
    }
    img.onerror = () => resolve(null);
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = SAMPLE;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
        const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);

        // Chroma-weighted hue histogram; near-black/near-white/transparent pixels sit out.
        const weight = new Array<number>(BUCKETS).fill(0);
        const hueSum = new Array<number>(BUCKETS).fill(0);
        for (let p = 0; p < data.length; p += 4) {
          if (data[p + 3] < 128) continue;
          const r = data[p] / 255;
          const g = data[p + 1] / 255;
          const b = data[p + 2] / 255;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const chroma = max - min;
          const light = (max + min) / 2;
          if (chroma < 0.06 || light < 0.1 || light > 0.92) continue;
          let hue =
            max === r
              ? ((g - b) / chroma + 6) % 6
              : max === g
                ? (b - r) / chroma + 2
                : (r - g) / chroma + 4;
          hue *= 60;
          const i = Math.min(BUCKETS - 1, Math.floor(hue / (360 / BUCKETS)));
          weight[i] += chroma;
          hueSum[i] += hue * chroma;
        }

        let best = 0;
        for (let i = 1; i < BUCKETS; i++)
          if (weight[i] > weight[best]) best = i;
        if (weight[best] < MIN_WEIGHT) return resolve(null);
        const hue = Math.round(hueSum[best] / weight[best]);
        // Fixed S/L: hue carries the hero's identity, the contrast never drifts.
        resolve(`hsl(${hue} 78% 70%)`);
      } catch {
        resolve(null); // tainted canvas or any decode surprise — keep the default accent
      }
    };
    img.src = src;
  });
}

/** Resolve the accent color for a portrait URL, or null to keep the default accent.
 * Samples each portrait at most once: successes persist in localStorage (failures don't —
 * a flaky network shouldn't pin a hero to the default forever), and concurrent callers
 * share one in-flight sample. */
export function heroAccent(url: string): Promise<string | null> {
  try {
    const cached = localStorage.getItem(storageKey(url));
    if (cached) return Promise.resolve(cached);
  } catch {
    // storage unavailable (private mode) — sample per session instead
  }
  let p = inflight.get(url);
  if (!p) {
    p = sample(url).then((color) => {
      if (color) {
        try {
          localStorage.setItem(storageKey(url), color);
        } catch {
          // best-effort cache only
        }
      }
      return color;
    });
    inflight.set(url, p);
  }
  return p;
}
