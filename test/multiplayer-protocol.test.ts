import { describe, expect, it } from "vitest";
import { deflateSync, strToU8 } from "fflate";
import { encodeInvite, encodeQrInvite, parseInvite, type QrAnswerInvite, type QrOfferInvite } from "../src/multiplayer/protocol";

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

  it("compresses and round-trips phone offer and answer QR codes", () => {
    const expiresAt = Date.now() + 60_000;
    const sdp = `v=0\r\n${"a=candidate:1 1 UDP 2122260223 192.168.1.20 50000 typ host\r\n".repeat(20)}`;
    const offer: QrOfferInvite = {
      version: 2,
      transport: "qr",
      type: "offer",
      partyId: "party-1234567890abcdef",
      token: "invite-1234567890abcdef",
      expiresAt,
      host: { id: "host-123", name: "房主手机", isHost: true },
      sdp,
    };
    const answer: QrAnswerInvite = {
      version: 2,
      transport: "qr",
      type: "answer",
      partyId: offer.partyId,
      token: offer.token,
      expiresAt,
      hostId: offer.host.id,
      guest: { id: "peer-456", name: "加入手机", isHost: false },
      sdp,
    };

    const encodedOffer = encodeQrInvite(offer);
    expect(encodedOffer).toMatch(/^IVRQR:[0-9A-Z $%*+./:_-]+:$/);
    expect(encodedOffer.length).toBeLessThan(sdp.length / 2);
    expect(parseInvite(encodedOffer)).toEqual(offer);
    expect(parseInvite(encodeQrInvite(answer))).toEqual(answer);

    const legacyPayload = Buffer.from(deflateSync(strToU8(JSON.stringify(offer)), { level: 9 })).toString("base64url");
    expect(parseInvite(`ivr-qr://pair?data=${legacyPayload}`)).toEqual(offer);
  });

  it("rejects expired phone pairing codes", () => {
    const expired: QrOfferInvite = {
      version: 2,
      transport: "qr",
      type: "offer",
      partyId: "party-1234567890abcdef",
      token: "invite-1234567890abcdef",
      expiresAt: Date.now() - 1,
      host: { id: "host-123", name: "房主手机", isHost: true },
      sdp: "v=0\r\n",
    };
    expect(() => parseInvite(encodeQrInvite(expired))).toThrow("已经过期");
  });
});
