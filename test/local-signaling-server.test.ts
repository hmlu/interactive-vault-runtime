import { afterEach, describe, expect, it } from "vitest";
import { LocalSignalingServer } from "../src/multiplayer/local-signaling-server";

describe("desktop LAN signaling endpoint", () => {
  let server: LocalSignalingServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it("accepts an authorized join and exchanges queued signaling", async (context) => {
    const joins: string[] = [];
    const signals: string[] = [];
    server = new LocalSignalingServer("party-test", "invite-1234567890abcdef", {
      onJoin: (request) => joins.push(request.name),
      onSignal: (_peerId, message) => signals.push(message.type),
      onLeave: () => undefined,
    });
    const port = await startOrSkip(server, context.skip);
    if (port === null) return;
    const endpoint = `http://127.0.0.1:${port}`;
    const joinResponse = await fetch(`${endpoint}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ partyId: "party-test", token: "invite-1234567890abcdef", name: "测试手机" }),
    });
    expect(joinResponse.status).toBe(200);
    const session = await joinResponse.json() as { peerId: string; secret: string };
    expect(joins).toEqual(["测试手机"]);

    server.queue(session.peerId, { type: "offer", sdp: "test-offer" });
    const pollResponse = await fetch(`${endpoint}/poll?peerId=${session.peerId}&secret=${session.secret}`);
    expect(await pollResponse.json()).toEqual({ messages: [{ type: "offer", sdp: "test-offer" }] });

    const signalResponse = await fetch(`${endpoint}/signal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peerId: session.peerId, secret: session.secret, message: { type: "answer", sdp: "test-answer" } }),
    });
    expect(signalResponse.status).toBe(200);
    expect(signals).toEqual(["answer"]);
  });

  it("rejects a join with the wrong token", async (context) => {
    server = new LocalSignalingServer("party-test", "invite-1234567890abcdef", {
      onJoin: () => undefined,
      onSignal: () => undefined,
      onLeave: () => undefined,
    });
    const port = await startOrSkip(server, context.skip);
    if (port === null) return;
    const response = await fetch(`http://127.0.0.1:${port}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ partyId: "party-test", token: "wrong", name: "陌生设备" }),
    });
    expect(response.status).toBe(403);
  });
});

async function startOrSkip(server: LocalSignalingServer, skip: () => never): Promise<number | null> {
  try {
    return await server.start();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      skip();
      return null;
    }
    throw error;
  }
}
