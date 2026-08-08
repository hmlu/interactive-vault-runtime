import { describe, expect, it, vi } from "vitest";

import { MultiplayerService } from "../src/multiplayer/multiplayer-service";
import type { MultiplayerMatchSnapshot, MultiplayerPartySnapshot } from "../src/runtime/types";

interface TestPeerRecord {
  member: { id: string; name: string; isHost: boolean };
  connection: RTCPeerConnection;
  channel: RTCDataChannel;
}

interface MultiplayerServiceInternals {
  party: MultiplayerPartySnapshot;
  guestSignal: { endpoint: string; peerId: string; secret: string; stopped: boolean } | null;
  guestPeer: TestPeerRecord | null;
  activeMatch: MultiplayerMatchSnapshot | null;
  disconnectGuest(record: TestPeerRecord, reason: string): void;
}

describe("MultiplayerService guest disconnection", () => {
  it("clears stale members and the active match when the host disconnects", () => {
    const service = new MultiplayerService();
    const internals = service as unknown as MultiplayerServiceInternals;
    const closeChannel = vi.fn();
    const closeConnection = vi.fn();
    const record: TestPeerRecord = {
      member: { id: "host", name: "房主", isHost: true },
      channel: { close: closeChannel } as unknown as RTCDataChannel,
      connection: { close: closeConnection } as unknown as RTCPeerConnection,
    };
    internals.party = {
      status: "connected",
      canHost: false,
      partyId: "party-1",
      localMember: { id: "guest", name: "手机", isHost: false },
      members: [record.member, { id: "guest", name: "手机", isHost: false }],
      pendingJoinRequests: [],
    };
    internals.guestSignal = { endpoint: "http://host", peerId: "guest", secret: "secret", stopped: false };
    internals.guestPeer = record;
    internals.activeMatch = {
      id: "match-1",
      projectId: "gomoku",
      peerId: "host",
      peerName: "房主",
      role: "invitee",
      protocolVersion: 1,
      settings: null,
    };

    internals.disconnectGuest(record, "与房主的连接已断开");

    const snapshot = service.createProjectFacade({
      manifestPath: "games/gomoku/project.json",
      manifest: { schemaVersion: 1, id: "gomoku", title: "五子棋", entry: "dist/main.js" },
    }).getSnapshot();
    expect(snapshot.party).toMatchObject({
      status: "disconnected",
      members: [],
      error: "与房主的连接已断开",
    });
    expect(snapshot.match).toBeUndefined();
    expect(internals.guestSignal).toBeNull();
    expect(internals.guestPeer).toBeNull();
    expect(closeChannel).toHaveBeenCalledOnce();
    expect(closeConnection).toHaveBeenCalledOnce();
  });

  it("ignores a late close event from an obsolete connection", () => {
    const service = new MultiplayerService();
    const internals = service as unknown as MultiplayerServiceInternals;
    const obsolete = {
      member: { id: "old-host", name: "旧房主", isHost: true },
      channel: { close: vi.fn() } as unknown as RTCDataChannel,
      connection: { close: vi.fn() } as unknown as RTCPeerConnection,
    };
    internals.party = {
      status: "connected",
      canHost: false,
      localMember: { id: "guest", name: "手机", isHost: false },
      members: [{ id: "new-host", name: "新房主", isHost: true }, { id: "guest", name: "手机", isHost: false }],
      pendingJoinRequests: [],
    };

    internals.disconnectGuest(obsolete, "过期事件");

    expect(internals.party.status).toBe("connected");
    expect(internals.party.members).toHaveLength(2);
  });
});
