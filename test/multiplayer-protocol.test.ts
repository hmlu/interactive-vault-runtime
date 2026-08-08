import { describe, expect, it } from "vitest";
import { encodeInvite, parseInvite } from "../src/multiplayer/protocol";

describe("LAN multiplayer invitations", () => {
  it("round-trips an invitation", () => {
    const invite = { version: 1 as const, endpoint: "http://192.168.1.25:43120", partyId: "party-test", token: "invite-1234567890abcdef" };
    expect(parseInvite(encodeInvite(invite))).toEqual(invite);
  });

  it("rejects external and malformed invitation formats", () => {
    expect(() => parseInvite("https://example.com/join")).toThrow();
    expect(() => parseInvite("ivr-lan://join?data=%7B%7D")).toThrow();
    expect(() => parseInvite(encodeInvite({ version: 1, endpoint: "https://example.com", partyId: "x", token: "invite-1234567890abcdef" }))).toThrow();
  });
});
