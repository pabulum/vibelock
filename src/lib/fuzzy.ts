// Fuzzy name matching for the command palette (lib/palette): type a few letters, press Enter,
// the best match commits — and enemy entry chains, the box clearing for the next name
// ("hazENTER vindiENTER…"). The ranking blends three signals so it's forgiving in the two ways
// typing-in-a-hurry fails:
//   1. Prefix / word-prefix — "haz" → Haze, "tal" → Grey Talon. The common case as you type.
//   2. Subsequence — "grytln" → Grey Talon. Skipped letters still resolve.
//   3. Levenshtein edit distance — "vindicat" → Vindicta, "sevn" → Seven. The classic spell-check
//      distance catches transpositions/typos that prefix/subsequence miss.
// Higher score = better; shorter names break ties (so "haz" prefers Haze over a longer hero that
// also starts with those letters). Returns null for a hopeless match so the caller can drop it.

/** Classic Levenshtein edit distance (insert/delete/substitute), iterative two-row DP. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** True when every char of `q` appears in `s` in order (not necessarily contiguously). */
function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) if (s[j] === q[i]) i++;
  return i === q.length;
}

/**
 * Score how well `query` matches `name` (higher = better), or null for no usable match. The bands are
 * ordered so a live prefix always beats a typo-corrected match, and shorter names win ties. Tuned for
 * short queries (a few keystrokes) against short hero names.
 */
export function fuzzyScore(query: string, name: string): number | null {
  const q = query.toLowerCase().trim();
  const n = name.toLowerCase();
  if (!q) return null;
  if (n === q) return 1000;
  if (n.startsWith(q)) return 900 - n.length; // whole-name prefix — the as-you-type case
  const words = n.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 800 - n.length; // word prefix: "tal" → Grey Talon
  if (isSubsequence(q, n)) return 600 - n.length; // "grytln" → Grey Talon
  // Typo tolerance: allow ~1 edit per 4 chars, measured against the name's leading slice so a short
  // query isn't penalized for the rest of a long name. "vindicat" → Vindicta, "sevn" → Seven.
  const budget = Math.max(1, Math.floor(q.length / 4));
  const d = editDistance(q, n.slice(0, q.length + budget));
  if (d <= budget) return 400 - d * 50 - n.length;
  return null;
}

/** Rank `items` by how well their `name` matches `query`, best first, dropping non-matches. */
export function rankByFuzzy<T>(
  query: string,
  items: T[],
  nameOf: (t: T) => string,
): T[] {
  return items
    .map((item) => ({ item, score: fuzzyScore(query, nameOf(item)) }))
    .filter((x): x is { item: T; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
}
