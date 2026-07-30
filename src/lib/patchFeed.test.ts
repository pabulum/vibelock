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
  it("keeps undated announcements as news but never as patch boundaries", () => {
    // The 2026-07-30 matchmaking rewrite: no date in the title, no item changes, but the single
    // most consequential thing to happen to the underlying data. It must be sayable, and it must
    // not open an analytics window.
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
