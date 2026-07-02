import { describe, expect, it } from "vitest";
import { parseSteamInput } from "./steamId";

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
