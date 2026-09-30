// The /v2/patches feed, split into the two things the app reads out of it: the PATCH LIST that
// time-boxes every analytics window, and the NEWS LIST the strip renders.
//
// They admit entries on deliberately different rules. A patch needs a trustworthy *day* — it
// becomes a query boundary, and a wrong one silently mis-slices every stat — so the only accepted
// key is the MM-DD-YYYY in the title. The feed's pub_date can't do that job: it unifies the Steam
// and Forum feeds, and Forum entries carry a re-published date (a 05-22 patch arrives stamped
// 06-12). News only has to be readable and roughly ordered, so entries with no date in the title
// are kept too, ordered by pub_date.
//
// A RANKED SEASON is the third source of boundaries, and it doesn't come from this feed at all —
// it comes from the client's own season definitions (/v1/assets/ranked-seasons). A season, or a
// split inside one, opens with a soft reset of everyone's badge, so the same `average_badge`
// filter selects a different population on either side of it: after 2026-07-30 calibration capped
// the ladder at Oracle VI and tiers 9–11 held *zero* matches, while the same window's pre-reset
// half had Eternus at 3%. That is a boundary by exactly the logic that makes a patch one, and it
// is the split deadlock-api's own tool draws its patch list on ("Before Beta Season 1" /
// "Beta Season 1"). Seasons the game hasn't defined yet — the next season, a mid-season split —
// become boundaries here with no code change, but only once they START: the asset schedules them
// ahead (on 2026-09-29 it already carried Split 2, opening 10-08), and a boundary in the future is
// a window with nothing in it — which, as the newest entry, is everyone's default view.
//
// So 2026-07-30's "Matchmaking Update" is a boundary after all, but not because of its title: it
// carries no MM-DD-YYYY and never will. It is the announcement the ranked season *matched*, and
// the title rule below is untouched by it.
//
// A NAMED UPDATE is the one exception the title rule takes. Valve announces its major updates by
// name, not date — "City Never Sleeps" (2026-09-29: rebuilt map and neutrals, six heroes) — and
// nothing else in the feed marks one: no date, no category, no tag (Steam's own API tags the minor
// updates `patchnotes` and this post nothing at all). So they are listed by name in
// NAMED_UPDATES, and the next one needs a line there. The boundary is the Steam post's own
// moment, not a midnight: it is the Forum that re-stamps pub_date, while the Steam copy goes up
// as the build ships — on 2026-09-29 match starts (/v1/sql) fell from ~24/min to ~1/min as the
// servers cycled at 20:25 UTC, and the post is stamped 20:25:11 — and a midnight key would have
// filed that day's twenty hours of old-build games under the new map.

import type { RawPatch } from "../api/schemas";
import type { NewsItem, Patch, SeasonInterval } from "../types";
import { stripHtml } from "./patchChanges";

export interface PatchFeed {
  /** Newest-first, one per day, each with a trustworthy boundary: 00:00 UTC of a dated patch, or
   * the moment a named update or a ranked season went live. */
  patches: Patch[];
  /** Newest-first, patches and undated announcements merged. */
  news: NewsItem[];
}

const TITLE_DATE = /(\d{2})-(\d{2})-(\d{4})/; // MM-DD-YYYY

/** Major updates Valve names instead of dating, by the exact title of their Steam post. */
const NAMED_UPDATES = new Set(["City Never Sleeps"]);

/** Valve dates changelogs in Pacific time — " Minor Update - 06-11-2026" went up at 00:59 UTC on
 * the 12th — so a named update's dated copy, if the Forum ever files one, is keyed by this. */
const PACIFIC = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function pacificDayKeyOf(ts: number): string {
  const part = Object.fromEntries(
    PACIFIC.formatToParts(ts * 1000).map((p) => [p.type, p.value]),
  );
  return `${part.year}-${part.month}-${part.day}`;
}

/** How much of a body the strip shows before the "read at source" link takes over. */
const EXCERPT_MAX = 180;

/** How far from a season's declared start we look for the announcement that shipped it. The two
 * disagree by hours — the KV3 timestamp is when the season's *accounting* starts (2026-07-30
 * 17:00 UTC), the Steam post is when the build actually went live (19:14 UTC) — and matches in
 * between were played on the old build, so the announcement is the better boundary of the two.
 * A day is wide enough for that gap and far too narrow to reach the neighbouring patch. */
const SEASON_ANNOUNCE_WINDOW_S = 86400;

const dayKeyOf = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

/** The entry closest to `ts`, if one is within {@link SEASON_ANNOUNCE_WINDOW_S} of it. */
function nearestEntry<T extends { ts: number }>(
  entries: T[],
  ts: number,
): T | undefined {
  let best: T | undefined;
  for (const e of entries) {
    const d = Math.abs(e.ts - ts);
    if (d > SEASON_ANNOUNCE_WINDOW_S) continue;
    if (!best || d < Math.abs(best.ts - ts)) best = e;
  }
  return best;
}

/** A one-line plain-text lede for a feed body. The feed's content is raw HTML from Steam/forum and
 * is never rendered as markup — this is the only thing we ever show from it. */
export function excerptOf(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const text = stripHtml(html)
    // Steam's image macro is a bare token, not a tag, so it survives tag-stripping. Its path is
    // matched by character class rather than \S*, which would run straight past the path's end
    // and eat whatever text follows it when no whitespace separates the two.
    .replace(/\{STEAM_CLAN_(?:LOC_)?IMAGE\}[/\w.-]*/g, " ")
    // Steam escapes the bracket that opens a notes section header ("\[ General ]").
    .replace(/\\([[\]])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  if (text.length <= EXCERPT_MAX) return text;
  const cut = text.slice(0, EXCERPT_MAX);
  const stop = cut.lastIndexOf(" ");
  // Only break on a word boundary if there is a reasonably late one; otherwise hard-cut.
  return `${cut.slice(0, stop > 80 ? stop : EXCERPT_MAX).trimEnd()}…`;
}

/** Split the raw feed into its patch list and its news list, opening a window boundary at each
 * ranked-season interval that has started by `nowSec` as well. Pure — the query layer only
 * fetches, and the clock is a parameter. */
export function parsePatchFeed(
  raw: RawPatch[],
  seasons: SeasonInterval[] = [],
  nowSec = Date.now() / 1000,
): PatchFeed {
  const byDay = new Map<string, Patch & { newsTitle: string; link?: string }>();
  // `content` rides along only so a season can adopt its announcement's notes below; it is dropped
  // again when the news list is built (the strip shows an excerpt, never the body).
  const undated: Array<NewsItem & { content?: string }> = [];

  for (const p of raw) {
    const title = p.title ?? "";
    const content = p.content || undefined;
    const m = title.match(TITLE_DATE);

    if (!m) {
      // No date in the title ⇒ never a patch boundary. pub_date is the only ordering signal there
      // is; without a parseable one the entry can't be placed on the timeline at all, so drop it.
      const ms = p.pub_date ? Date.parse(p.pub_date) : NaN;
      if (!title || Number.isNaN(ms)) continue;
      const name = title.trim();
      if (p.source === "steam" && NAMED_UPDATES.has(name)) {
        // Filed under its Pacific day, where a dated copy of the same release would land: either
        // arrival order leaves one entry, at this post's moment, carrying the longer notes.
        const ts = Math.floor(ms / 1000);
        const dayKey = pacificDayKeyOf(ts);
        const dated = byDay.get(dayKey);
        const notes =
          dated?.content && dated.content.length > (content?.length ?? 0)
            ? dated
            : { content, link: p.link };
        byDay.set(dayKey, {
          title: `${dayKey} · ${name}`,
          newsTitle: name,
          ts,
          content: notes.content,
          link: notes.link,
        });
        continue;
      }
      undated.push({
        title: name,
        ts: Math.floor(ms / 1000),
        isPatch: false,
        link: p.link,
        excerpt: excerptOf(content),
        content,
      });
      continue;
    }

    const [, mm, dd, yyyy] = m;
    const dayKey = `${yyyy}-${mm}-${dd}`;
    const existing = byDay.get(dayKey);
    if (existing) {
      // Same patch from the other feed: keep whichever copy carries the notes text (Steam), so the
      // changelog is available for the touched-item tag (see lib/patchChanges) — and, now, so the
      // news excerpt is the real lede rather than the Forum copy's link-unfurl boilerplate. The
      // entry's boundary stays put, which is what keeps a named update's precise one.
      if (content && content.length > (existing.content?.length ?? 0)) {
        existing.content = content;
        existing.link = p.link;
      }
      continue;
    }
    const minor = /minor/i.test(title);
    byDay.set(dayKey, {
      title: `${dayKey}${minor ? " · Minor" : ""} Update`,
      // The news strip prints the date itself, in mono, so the entry's own label must not repeat
      // it — "07-28 · 2026-07-28 · Minor Update" is what carrying the patch title over produced.
      newsTitle: minor ? "Minor Update" : "Update",
      ts: Math.floor(Date.UTC(+yyyy, +mm - 1, +dd) / 1000),
      content,
      link: p.link,
    });
  }

  const dated = [...byDay.values()].sort((a, b) => b.ts - a.ts);
  const patches: Patch[] = dated.map(({ title, ts, content }) => ({
    title,
    ts,
    content,
  }));
  const extraNews: NewsItem[] = [];

  // Settle each season on the moment its data actually begins, and give the patch list a boundary
  // there. Order of preference, and why:
  //   1. A dated patch within a day — the season shipped with a changelog, so that entry already
  //      IS the boundary and a second one beside it would only split the window in two. It keeps
  //      its own midnight-UTC day key, imprecise by a few hours in exactly the way every other
  //      patch boundary already is.
  //   2. The announcement that shipped it (2026-07-30's "Matchmaking Update"), promoted from news
  //      to a boundary and lending the entry its notes.
  //   3. The season's declared start, when the feed says nothing at all — the boundary matters
  //      even with no story attached to it, so the strip gets a bare entry for it.
  const settled: SeasonInterval[] = [];
  for (const s of seasons) {
    if (s.startTs > nowSec) continue; // scheduled, not started — see the header
    const onPatch = nearestEntry(dated, s.startTs);
    const announcement = onPatch ? undefined : nearestEntry(undated, s.startTs);
    const startTs = onPatch?.ts ?? announcement?.ts ?? s.startTs;
    settled.push({ name: s.name, startTs });
    if (onPatch) continue;
    if (announcement) announcement.isPatch = true;
    else extraNews.push({ title: s.name, ts: startTs, isPatch: true });
    patches.push({
      title: `${dayKeyOf(startTs)} · ${s.name}`,
      ts: startTs,
      content: announcement?.content,
    });
  }
  settled.sort((a, b) => b.startTs - a.startTs);

  const news: NewsItem[] = [
    ...dated.map((p) => ({
      title: p.newsTitle,
      ts: p.ts,
      isPatch: true,
      link: p.link,
      excerpt: excerptOf(p.content),
    })),
    // Rebuilt field by field to drop `content`, carried this far only so a season could adopt it.
    ...undated.map(({ title, ts, isPatch, link, excerpt }) => ({
      title,
      ts,
      isPatch,
      link,
      excerpt,
    })),
    ...extraNews,
  ].sort((a, b) => b.ts - a.ts);

  return {
    patches: patches
      .sort((a, b) => b.ts - a.ts)
      // Newest-first, so the first season at or below a patch is the one it ran under.
      .map((p) => ({ ...p, season: settled.find((s) => p.ts >= s.startTs) })),
    news,
  };
}
