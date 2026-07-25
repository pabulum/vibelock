import { describe, expect, it } from "vitest";
import { parseSteamInput, parseVanityName, typedAccountId } from "./steamId";

describe("parseVanityName", () => {
  it("extracts the slug from a vanity URL", () => {
    expect(parseVanityName("https://steamcommunity.com/id/larrylizard/")).toBe(
      "larrylizard",
    );
    expect(parseVanityName("steamcommunity.com/id/some_name?tab=x")).toBe(
      "some_name",
    );
  });

  it("returns null for non-vanity input", () => {
    expect(
      parseVanityName("https://steamcommunity.com/profiles/76561199015904602"),
    ).toBeNull();
    expect(parseVanityName("larrylizard")).toBeNull();
  });
});

describe("parseSteamInput", () => {
  it("passes a plain account id through", () => {
    expect(parseSteamInput("1055638874")).toBe(1055638874);
    expect(parseSteamInput("  22202 ")).toBe(22202);
  });

  it("converts a steamID64 by the fixed offset", () => {
    expect(parseSteamInput("76561199015904602")).toBe(1055638874);
  });

  it("pulls the steamID64 out of a profile URL", () => {
    expect(
      parseSteamInput("https://steamcommunity.com/profiles/76561199015904602/"),
    ).toBe(1055638874);
  });

  it("rejects vanity URLs, names, and junk", () => {
    expect(parseSteamInput("https://steamcommunity.com/id/gaben")).toBeNull();
    expect(parseSteamInput("gaben")).toBeNull();
    expect(parseSteamInput("")).toBeNull();
    expect(parseSteamInput("0")).toBeNull();
    // A 17-digit number below the steam64 offset is not a real id.
    expect(parseSteamInput("10000000000000000")).toBeNull();
  });
});

describe("typedAccountId", () => {
  it("resolves the same ids as the parser once they're long enough", () => {
    expect(typedAccountId("1055638874")).toBe(1055638874);
    expect(typedAccountId("76561199015904602")).toBe(1055638874);
    expect(
      typedAccountId("https://steamcommunity.com/profiles/76561199015904602/"),
    ).toBe(1055638874);
  });

  it("holds back the prefixes of an id being typed", () => {
    // Every one of these parses — and most are real accounts — so without the gate the page would
    // load (and apply) a stranger's profile on the way to your own id.
    for (const prefix of ["1", "10", "105", "1055", "10556"])
      expect(typedAccountId(prefix)).toBeNull();
    expect(typedAccountId("105563")).toBe(105563);
  });

  it("does not gate the unambiguous forms by length", () => {
    // A steamID64 passes through every prefix as null anyway (below the offset), and a URL is
    // never ambiguous — the gate is only about bare digit runs.
    expect(typedAccountId("7656119901")).toBe(7656119901);
    expect(typedAccountId("https://steamcommunity.com/id/gaben")).toBeNull();
  });
});
