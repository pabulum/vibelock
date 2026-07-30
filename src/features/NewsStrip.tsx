// "News": the Deadlock update feed, straight from the source (lib/patchFeed).
//
// The patch selector already names every entry that opens an analytics window, so the thing this
// adds is the entries that DON'T — announcements with no date in their title, which until now the
// feed parser dropped on the floor. 2026-07-30's matchmaking rewrite was the case in point: no item
// changes, so nothing anywhere in the app could mention it, while it quietly reshaped the
// population every stat is computed over.
//
// Same ledger-line idiom as the movers strip above it, and the same tooltip discipline: the feed's
// body is raw HTML from Steam and is never rendered as markup — the excerpt (plain text, built in
// lib/patchFeed) rides in the title attribute, and the entry links out for the rest.
import "./NewsStrip.css";
import type { NewsItem } from "../types";

/** Entries shown. The feed carries ~30, which is a year of patches — far past "what's new". */
const SHOWN = 6;

const MONTH_DAY = (ts: number) => {
  const d = new Date(ts * 1000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

export function NewsStrip(props: { news: NewsItem[] }) {
  const news = props.news.slice(0, SHOWN);
  if (news.length === 0) return null;
  return (
    <div className="news">
      <span
        className="lbl"
        title="Deadlock's update feed, as published by Valve. Entries marked with a dot are announcements rather than balance patches — they change nothing in the item data, so no patch window opens on them, but they can still change how the game (and therefore every statistic here) behaves."
      >
        News
      </span>
      {news.map((n) => {
        const label = (
          <>
            <b>{MONTH_DAY(n.ts)}</b>
            {!n.isPatch && <span className="dot">•</span>}
            {n.title}
          </>
        );
        return n.link ? (
          <a
            key={`${n.ts}|${n.title}`}
            className={`entry${n.isPatch ? "" : " note"}`}
            href={n.link}
            target="_blank"
            rel="noreferrer noopener"
            title={n.excerpt ?? n.title}
          >
            {label}
          </a>
        ) : (
          <span
            key={`${n.ts}|${n.title}`}
            className={`entry${n.isPatch ? "" : " note"}`}
            title={n.excerpt ?? n.title}
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}
