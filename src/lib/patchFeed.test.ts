import { describe, expect, it } from "vitest";
import { excerptOf, parsePatchFeed } from "./patchFeed";

const D = (s: string) => Math.floor(Date.parse(s) / 1000);

describe("parsePatchFeed — patch list", () => {
  it("keys off the title date, not the re-stamped pub_date", () => {
    // The exact hazard the trust rule exists for: a Forum entry for the 05-22 patch, republished
    // (and so pub_date-stamped) on 06-12. Windowing on pub_date would move the boundary 3 weeks.
    const { patches } = parsePatchFeed([
      { title: "05-22-2026 Update", pub_date: "2026-06-12T00:59:45Z" },
    ]);
    expect(patches).toHaveLength(1);
    expect(patches[0].ts).toBe(D("2026-05-22T00:00:00Z"));
  });

  it("collapses the two feeds' copies of one patch, keeping the copy with real notes", () => {
    const { patches } = parsePatchFeed([
      { title: "06-30-2026 Update", content: "<div>unfurl</div>" },
      {
        title: " Minor Update - 06-30-2026",
        content: "<p>- Scourge: nerfed</p>",
      },
    ]);
    expect(patches).toHaveLength(1);
    expect(patches[0].content).toContain("Scourge");
  });

  it("orders newest-first and marks minor updates", () => {
    const { patches } = parsePatchFeed([
      { title: " Minor Update - 07-09-2026" },
      { title: "05-22-2026 Update" },
      { title: " Minor Update - 07-28-2026" },
    ]);
    expect(patches.map((p) => p.title)).toEqual([
      "2026-07-28 · Minor Update",
      "2026-07-09 · Minor Update",
      "2026-05-22 Update",
    ]);
  });
});

describe("parsePatchFeed — news list", () => {
  it("keeps undated announcements as news, and out of the patch list on their own", () => {
    // A title with no MM-DD-YYYY never becomes a boundary by itself. The 2026-07-30 matchmaking
    // rewrite is one, and it opens a window only because a ranked season matches it — with no
    // season asset (the API down, or an announcement that starts nothing) it stays news.
    const raw = [
      { title: "Matchmaking Update", pub_date: "2026-07-30T19:14:37Z" },
      { title: " Minor Update - 07-28-2026", pub_date: "2026-07-28T20:24:35Z" },
    ];
    const { patches, news } = parsePatchFeed(raw);
    expect(patches.map((p) => p.title)).toEqual(["2026-07-28 · Minor Update"]);
    expect(news.map((n) => [n.title, n.isPatch])).toEqual([
      ["Matchmaking Update", false],
      // Not the patch's own title: the strip prints the date in mono beside this, so repeating it
      // here rendered "07-28 · 2026-07-28 · Minor Update".
      ["Minor Update", true],
    ]);
  });

  it("drops an undated entry with no usable pub_date — it can't be placed on the timeline", () => {
    const { news } = parsePatchFeed([
      { title: "Some Announcement" },
      { title: "Другое", pub_date: "not a date" },
    ]);
    expect(news).toEqual([]);
  });

  it("carries the link and a plain-text excerpt", () => {
    const { news } = parsePatchFeed([
      {
        title: "Matchmaking Update",
        pub_date: "2026-07-30T19:14:37Z",
        link: "https://example.invalid/news/1",
        content:
          "This update includes a revamp.<br><br><b>STANDARD MODE</b><br>Lower stakes.",
      },
    ]);
    expect(news[0].link).toBe("https://example.invalid/news/1");
    expect(news[0].excerpt).toBe(
      "This update includes a revamp. STANDARD MODE Lower stakes.",
    );
  });

  it("sorts patches and announcements into one timeline", () => {
    const { news } = parsePatchFeed([
      { title: " Minor Update - 07-28-2026", pub_date: "2026-07-28T20:24:35Z" },
      { title: "Matchmaking Update", pub_date: "2026-07-30T19:14:37Z" },
      { title: " Minor Update - 07-09-2026", pub_date: "2026-07-09T19:26:55Z" },
    ]);
    expect(news.map((n) => n.ts)).toEqual(
      [...news.map((n) => n.ts)].sort((a, b) => b - a),
    );
    expect(news[0].title).toBe("Matchmaking Update");
  });
});

describe("parsePatchFeed — ranked-season boundaries", () => {
  // The live shape: Beta Season 1's declared start is 17:00 UTC, the announcement that shipped it
  // landed at 19:14 UTC, and the nearest patch is two days earlier.
  const SEASON_START = D("2026-07-30T17:00:00Z");
  const ANNOUNCED = D("2026-07-30T19:14:37Z");
  const seasons = [{ name: "Beta Season 1", startTs: SEASON_START }];
  const feed = [
    {
      title: "Matchmaking Update",
      pub_date: "2026-07-30T19:14:37Z",
      content: "<p>Ranked Mode has seasons.</p>",
    },
    { title: " Minor Update - 07-28-2026", pub_date: "2026-07-28T20:24:35Z" },
    { title: " Minor Update - 07-09-2026", pub_date: "2026-07-09T19:26:55Z" },
  ];

  it("opens the boundary on the announcement, not the season's declared start", () => {
    // Matches between 17:00 and 19:14 were still played on the old build; the post is when it
    // actually went live, and it's the boundary deadlock-api's own picker uses.
    const { patches } = parsePatchFeed(feed, seasons);
    expect(patches[0]).toMatchObject({
      title: "2026-07-30 · Beta Season 1",
      ts: ANNOUNCED,
      content: "<p>Ranked Mode has seasons.</p>",
      season: { name: "Beta Season 1", startTs: ANNOUNCED },
    });
  });

  it("promotes the matched announcement in the news strip instead of duplicating it", () => {
    const { news } = parsePatchFeed(feed, seasons);
    expect(news.filter((n) => n.ts === ANNOUNCED)).toEqual([
      expect.objectContaining({ title: "Matchmaking Update", isPatch: true }),
    ]);
  });

  it("tells every patch which season it ran under, and leaves older ones with none", () => {
    const { patches } = parsePatchFeed(feed, seasons);
    expect(patches.map((p) => p.season?.name)).toEqual([
      "Beta Season 1",
      undefined, // 07-28 — the season boundary is what makes these two un-mixable
      undefined, // 07-09
    ]);
  });

  it("lets a patch that shipped with the season be the boundary itself", () => {
    // No second entry hours apart: the changelog patch is already a boundary, and it keeps its own
    // midnight-UTC day key — imprecise by a few hours in exactly the way every patch boundary is.
    const { patches } = parsePatchFeed(
      [
        {
          title: " Minor Update - 07-30-2026",
          pub_date: "2026-07-30T17:02:00Z",
        },
      ],
      seasons,
    );
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      title: "2026-07-30 · Minor Update",
      season: { startTs: D("2026-07-30T00:00:00Z") },
    });
  });

  it("still opens a boundary when the feed says nothing about the season", () => {
    // A season the announcement feed never mentioned (or one that scrolled off the 30-entry feed)
    // is still a reset. The boundary matters with no story attached, so the strip gets a bare one.
    const { patches, news } = parsePatchFeed(
      [
        {
          title: " Minor Update - 07-09-2026",
          pub_date: "2026-07-09T19:26:55Z",
        },
      ],
      seasons,
    );
    expect(patches[0]).toMatchObject({
      title: "2026-07-30 · Beta Season 1",
      ts: SEASON_START,
      content: undefined,
    });
    expect(news[0]).toEqual({
      title: "Beta Season 1",
      ts: SEASON_START,
      isPatch: true,
    });
  });

  it("takes splits as their own boundaries", () => {
    // Anticipating the shape the API already allows: a mid-season split is a second interval, and
    // a split break adjusts ranks — another reset, another boundary, no code change.
    const split = D("2026-09-01T17:00:00Z");
    const { patches } = parsePatchFeed(feed, [
      { name: "Beta Season 1 · Split 2", startTs: split },
      ...seasons,
    ]);
    expect(patches.map((p) => p.title)).toEqual([
      "2026-09-01 · Beta Season 1 · Split 2",
      "2026-07-30 · Beta Season 1",
      "2026-07-28 · Minor Update",
      "2026-07-09 · Minor Update",
    ]);
    expect(patches[1].season?.name).toBe("Beta Season 1");
  });
});

describe("excerptOf", () => {
  it("strips markup, Steam's image macro, and escaped brackets", () => {
    expect(
      excerptOf(
        "{STEAM_CLAN_LOC_IMAGE}/45164767/f6a6d57.png<p>\\[ General ]</p><p>- Faster dashes</p>",
      ),
    ).toBe("[ General ] - Faster dashes");
  });

  it("returns undefined for an empty or markup-only body", () => {
    expect(excerptOf(undefined)).toBeUndefined();
    expect(excerptOf("")).toBeUndefined();
    expect(excerptOf("<div><br></div>")).toBeUndefined();
  });

  it("truncates on a word boundary", () => {
    const long = `${"alpha ".repeat(60)}omega`;
    const out = excerptOf(long)!;
    expect(out.length).toBeLessThanOrEqual(181);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("alph…");
  });
});
