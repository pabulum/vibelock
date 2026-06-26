// Turns a thrown fetch error into a short, plain-English line for the error banner. Two shapes reach
// here: the API client (api/deadlock.ts) throws `Error("<status> <statusText> for <url>")` on a bad
// HTTP response, and the browser rejects `fetch` with a TypeError on a network-level failure (offline,
// DNS, CORS, reset) where there's no status code at all. We map both to something a player can act on,
// and only fall back to a generic line when we don't recognize the error — we never surface a raw URL
// or stack to the user.

export function friendlyError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);

  // Network-level failure: fetch rejected with a TypeError, so there's no HTTP status to read.
  if (/failed to fetch|networkerror|network error|load failed|fetch failed/i.test(raw)) {
    return "Couldn't reach the stats API — check your connection and try again.";
  }

  // HTTP errors arrive as "<status> <statusText> for <url>"; read the leading status code.
  const status = Number(raw.match(/^(\d{3})\b/)?.[1]);
  if (status === 429) {
    return 'The stats API is rate-limiting us — wait a moment, then try again.';
  }
  if (status >= 500) {
    return 'The stats API is having trouble right now — try again in a bit.';
  }
  if (status === 404) {
    return 'No data for that hero, rank, and patch yet — try a wider patch window or a lower rank.';
  }
  if (status >= 400) {
    return "That request wasn't accepted by the stats API — try a different hero or rank.";
  }

  return 'Something went wrong loading the data — try again.';
}
