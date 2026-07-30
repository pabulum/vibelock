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
// That difference is the whole point, and 2026-07-30's "Matchmaking Update" is the case that
// motivated it: a matchmaking rewrite ships no item changes, so opening an analytics window on it
// would blank every build for nothing — but it is the most consequential thing to happen to the
// data in months, so it has to be *sayable*. News, not a patch.

import { stripHtml } from "./patchChanges";
import type { NewsItem, Patch } from "../types";
import type { RawPatch } from "../api/schemas";

export interface PatchFeed {
  /** Newest-first, one per day, each with a trustworthy 00:00-UTC boundary. */
  patches: Patch[];
  /** Newest-first, patches and undated announcements merged. */
  news: NewsItem[];
}

const TITLE_DATE = /(\d{2})-(\d{2})-(\d{4})/; // MM-DD-YYYY

/** How much of a body the strip shows before the "read at source" link takes over. */
const EXCERPT_MAX = 180;

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

/** Split the raw feed into its patch list and its news list. Pure — the query layer only fetches. */
export function parsePatchFeed(raw: RawPatch[]): PatchFeed {
  const byDay = new Map<string, Patch & { newsTitle: string; link?: string }>();
  const undated: NewsItem[] = [];

  for (const p of raw) {
    const title = p.title ?? "";
    const content = p.content || undefined;
    const m = title.match(TITLE_DATE);

    if (!m) {
      // No date in the title ⇒ never a patch boundary. pub_date is the only ordering signal there
      // is; without a parseable one the entry can't be placed on the timeline at all, so drop it.
      const ms = p.pub_date ? Date.parse(p.pub_date) : NaN;
      if (!title || Number.isNaN(ms)) continue;
      undated.push({
        title: title.trim(),
        ts: Math.floor(ms / 1000),
        isPatch: false,
        link: p.link,
        excerpt: excerptOf(content),
      });
      continue;
    }

    const [, mm, dd, yyyy] = m;
    const dayKey = `${yyyy}-${mm}-${dd}`;
    const existing = byDay.get(dayKey);
    if (existing) {
      // Same patch from the other feed: keep whichever copy carries the notes text (Steam), so the
      // changelog is available for the touched-item tag (see lib/patchChanges) — and, now, so the
      // news excerpt is the real lede rather than the Forum copy's link-unfurl boilerplate.
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
  const news: NewsItem[] = [
    ...dated.map((p) => ({
      title: p.newsTitle,
      ts: p.ts,
      isPatch: true,
      link: p.link,
      excerpt: excerptOf(p.content),
    })),
    ...undated,
  ].sort((a, b) => b.ts - a.ts);

  return { patches, news };
}
