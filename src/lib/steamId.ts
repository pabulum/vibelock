// Steam identity plumbing. The analytics API wants the *account id* (steamID32 — the number in
// Steam's userdata/<id> folder), but nobody knows that number offhand; what players can actually
// find is their profile URL or steamID64. Accept any of those forms and convert on sight — the
// classic steamID64 = account id + 76561197960265728 offset. Vanity URLs (steamcommunity.com/id/
// somename) intentionally return null: names don't map to ids without a lookup, that's what the
// name-search box is for.

const STEAM64_BASE = 76561197960265728n;

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
