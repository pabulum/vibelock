// Deep-link state <-> URL query string. The whole selection — hero, rank floor, patch, build
// archetype, and the enemy lineup — lives in the URL so a shared link reproduces exactly what the
// sender sees, and the back/forward buttons stay sane.
//
// Query params (not path segments) on purpose: the app is hosted on GitHub Pages (static, no SPA
// rewrite), where a deep path like /vibelock/paradox/eternus would 404 on a cold load unless we add a
// 404.html redirect shim. Query params keep the served path at index.html, so any link loads directly.

export interface UrlState {
  /** Hero slug, derived from the hero's name (e.g. "grey-talon"). Resolved to an id once heroes load. */
  hero?: string;
  /** Rank-floor tier, 0–11 (11 = Eternus). */
  tier?: number;
  /**
   * Selected patch's Unix timestamp; absent ⇒ the default "last 30 days" window. We key off the
   * timestamp rather than the patch-list index so a link survives newly-released patches shifting the
   * list out from under it.
   */
  patchTs?: number;
  /** Build archetype: "gun" | "spirit". Absent ⇒ "all" (the blended/default build). */
  build?: string;
  /** Enemy lineup, as hero slugs. */
  enemies?: string[];
}

/** A hero name reduced to a URL-safe slug: lowercased, non-alphanumerics collapsed to single dashes. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Serialize selection to a query string (with a leading "?", or "" when there's nothing to encode).
 *  Defaults are omitted: the blended "all" build and an empty enemy list leave no trace in the URL. */
export function encodeUrlState(s: UrlState): string {
  const p = new URLSearchParams();
  if (s.hero) p.set('hero', s.hero);
  if (s.tier !== undefined) p.set('rank', String(s.tier));
  if (s.patchTs !== undefined) p.set('patch', String(s.patchTs));
  if (s.build && s.build !== 'all') p.set('build', s.build);
  if (s.enemies?.length) p.set('vs', s.enemies.join(','));
  const q = p.toString();
  return q ? `?${q}` : '';
}

/** Parse a query string back into a UrlState, ignoring anything malformed (a bad link degrades to
 *  defaults rather than throwing). Accepts a leading "?" or not. */
export function decodeUrlState(search: string): UrlState {
  const p = new URLSearchParams(search);
  const out: UrlState = {};

  const hero = p.get('hero');
  if (hero) out.hero = hero;

  const rank = p.get('rank');
  if (rank !== null && /^\d+$/.test(rank)) out.tier = Number(rank);

  const patch = p.get('patch');
  if (patch !== null && /^\d+$/.test(patch)) out.patchTs = Number(patch);

  const build = p.get('build');
  if (build === 'gun' || build === 'spirit') out.build = build;

  const vs = p.get('vs');
  if (vs) {
    const enemies = vs
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (enemies.length) out.enemies = enemies;
  }

  return out;
}
