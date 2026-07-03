// Steam identity plumbing. The analytics API wants the *account id* (steamID32 — the number in
// Steam's userdata/<id> folder), but nobody knows that number offhand; what players can actually
// find is their profile URL or steamID64. Accept any of those forms and convert on sight — the
// classic steamID64 = account id + 76561197960265728 offset. Vanity URLs (steamcommunity.com/id/
// somename) intentionally return null: names don't map to ids without a lookup, that's what the
// name-search box is for.

const STEAM64_BASE = 76561197960265728n;

/** The vanity slug from a steamcommunity.com/id/<name> URL — the one form that CAN'T be converted
 * arithmetically. It resolves through the name-search endpoint instead (the slug is usually the
 * display name or close to it), so the caller should feed it to search rather than reject it. */
export function parseVanityName(raw: string): string | null {
  const m = raw.trim().match(/steamcommunity\.com\/id\/([^/?#\s]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Extract an account id from whatever the player pasted: a plain account id, a steamID64
 * (17 digits), or a steamcommunity.com/profiles/<steam64> URL. Null when it's none of those. */
export function parseSteamInput(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const url = s.match(/profiles\/(\d{17})/);
  const digits = url ? url[1] : /^\d+$/.test(s) ? s : null;
  if (!digits) return null;
  if (digits.length >= 16) {
    const acc = BigInt(digits) - STEAM64_BASE;
    return acc > 0n && acc < 2n ** 32n ? Number(acc) : null;
  }
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
