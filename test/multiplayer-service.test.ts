import { afterEach, describe, expect, it, vi } from "vitest";

import { MultiplayerService } from "../src/multiplayer/multiplayer-service";
import type { MultiplayerMatchSnapshot, MultiplayerPartySnapshot } from "../src/runtime/types";

interface TestPeerRecord {
  member: { id: string; name: string; isHost: boolean };
  connection: RTCPeerConnection;
  channel: RTCDataChannel;
  realtimeChannel?: RTCDataChannel | null;
}

interface MultiplayerServiceInternals {
  party: MultiplayerPartySnapshot;
  guestSignal: { endpoint: string; peerId: string; secret: string; stopped: boolean } | null;
  guestPeer: TestPeerRecord | null;
  hostPeers: Map<string, TestPeerRecord>;
  activeMatch: MultiplayerMatchSnapshot | null;
  disconnectGuest(record: TestPeerRecord, reason: string): void;
}

class FakeDataChannel {
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  send = vi.fn();

  constructor(readonly label = "interactive-vault") {}

  close(): void {
    this.readyState = "closed";
  }
}

class FakePeerConnection {
  iceGatheringState: RTCIceGatheringState = "complete";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly channel = new FakeDataChannel();
  readonly realtimeChannel = new FakeDataChannel("interactive-vault-realtime");

  createDataChannel(label: string): RTCDataChannel {
    return (label === "interactive-vault-realtime" ? this.realtimeChannel : this.channel) as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0\r\na=candidate:host 1 UDP 1 192.168.1.10 50000 typ host\r\n" };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0\r\na=candidate:guest 1 UDP 1 192.168.1.11 50001 typ host\r\n" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (description.type === "answer" && !this.channel.onopen) {
      throw new Error("host channel lifecycle was not bound before applying the answer");
    }
    this.remoteDescription = description as RTCSessionDescription;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.connectionState = "closed";
  }
}

function projectFacade(service: MultiplayerService) {
  return service.createProjectFacade({
    manifestPath: "games/gomoku/project.json",
    manifest: { schemaVersion: 1, id: "gomoku", title: "五子棋", entry: "dist/main.js" },
  });
}

afterEach(() => vi.unstubAllGlobals());

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
      canScan: true,
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
      canScan: true,
      localMember: { id: "guest", name: "手机", isHost: false },
      members: [{ id: "new-host", name: "新房主", isHost: true }, { id: "guest", name: "手机", isHost: false }],
      pendingJoinRequests: [],
    };

    internals.disconnectGuest(obsolete, "过期事件");

    expect(internals.party.status).toBe("connected");
    expect(internals.party.members).toHaveLength(2);
  });
});

describe("MultiplayerService realtime transport", () => {
  it("reports the active match channel backlog to the game", () => {
    const service = new MultiplayerService();
    const internals = service as unknown as MultiplayerServiceInternals;
    const channel = new FakeDataChannel();
    channel.readyState = "open";
    channel.bufferedAmount = 73_000;
    const record = {
      member: { id: "guest", name: "客机", isHost: false },
      channel: channel as unknown as RTCDataChannel,
      connection: { close: vi.fn() } as unknown as RTCPeerConnection,
    };
    internals.party = {
      status: "connected",
      canHost: true,
      canScan: true,
      localMember: { id: "host", name: "房主", isHost: true },
      members: [{ id: "host", name: "房主", isHost: true }, record.member],
      pendingJoinRequests: [],
    };
    internals.hostPeers.set(record.member.id, record);
    internals.activeMatch = {
      id: "match-1",
      projectId: "gomoku",
      peerId: record.member.id,
      peerName: record.member.name,
      role: "challenger",
      protocolVersion: 1,
      settings: null,
    };

    expect(projectFacade(service).getBufferedAmount?.()).toBe(73_000);
  });

  it("sends replaceable snapshots on the unordered realtime channel", () => {
    const service = new MultiplayerService();
    const internals = service as unknown as MultiplayerServiceInternals;
    const control = new FakeDataChannel();
    const realtime = new FakeDataChannel("interactive-vault-realtime");
    control.readyState = "open";
    realtime.readyState = "open";
    realtime.bufferedAmount = 19_000;
    const record = {
      member: { id: "guest", name: "客机", isHost: false },
      channel: control as unknown as RTCDataChannel,
      realtimeChannel: realtime as unknown as RTCDataChannel,
      connection: { close: vi.fn() } as unknown as RTCPeerConnection,
    };
    internals.party = {
      status: "connected",
      canHost: true,
      canScan: true,
      localMember: { id: "host", name: "房主", isHost: true },
      members: [{ id: "host", name: "房主", isHost: true }, record.member],
      pendingJoinRequests: [],
    };
    internals.hostPeers.set(record.member.id, record);
    internals.activeMatch = {
      id: "match-1",
      projectId: "gomoku",
      peerId: record.member.id,
      peerName: record.member.name,
      role: "challenger",
      protocolVersion: 1,
      settings: null,
    };

    const facade = projectFacade(service);
    facade.sendRealtime?.({ frame: 18 });

    expect(realtime.send).toHaveBeenCalledOnce();
    expect(control.send).not.toHaveBeenCalled();
    expect(facade.getRealtimeBufferedAmount?.()).toBe(19_000);
  });
});

describe("MultiplayerService phone QR pairing", () => {
  it("binds the channel before applying the answer and can invite devices sequentially", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    const host = new MultiplayerService();
    const guest = new MultiplayerService();
    const hostFacade = projectFacade(host);
    const guestFacade = projectFacade(guest);

    await hostFacade.createParty("房主手机");
    const offer = hostFacade.getSnapshot().party;
    expect(offer).toMatchObject({ status: "hosting", pairingRole: "qr-host", canScan: true });
    expect(offer.invite).toMatch(/^IVRQR:/);
    await expect(hostFacade.joinParty(offer.invite!, "房主手机")).rejects.toThrow("回传码");
    expect(hostFacade.getSnapshot().party).toMatchObject({ status: "hosting", partyId: offer.partyId });

    await guestFacade.joinParty(offer.invite!, "加入手机");
    const answer = guestFacade.getSnapshot().party;
    expect(answer).toMatchObject({ status: "joining", pairingRole: "qr-guest", canScan: true });
    expect(answer.invite).toMatch(/^IVRQR:/);

    await hostFacade.joinParty(answer.invite!, "房主手机");
    const hostInternals = host as unknown as MultiplayerServiceInternals;
    const peer = [...hostInternals.hostPeers.values()][0];
    expect(peer).toBeDefined();
    (peer.channel as unknown as FakeDataChannel).readyState = "open";
    (peer.channel as unknown as FakeDataChannel).onopen?.(new Event("open"));

    expect(hostFacade.getSnapshot().party).toMatchObject({
      status: "connected",
      partyId: offer.partyId,
      invite: undefined,
      pairingStatus: undefined,
    });
    expect(hostFacade.getSnapshot().party.members.map((member) => member.name)).toEqual(["房主手机", "加入手机"]);

    await hostFacade.inviteMore!();
    const nextOffer = hostFacade.getSnapshot().party;
    expect(nextOffer).toMatchObject({
      status: "connected",
      partyId: offer.partyId,
      pairingStatus: "awaiting-scan",
    });
    expect(nextOffer.invite).toMatch(/^IVRQR:/);
    expect(nextOffer.invite).not.toBe(offer.invite);

    const secondGuest = new MultiplayerService();
    const secondGuestFacade = projectFacade(secondGuest);
    await secondGuestFacade.joinParty(nextOffer.invite!, "第二台手机");
    await hostFacade.joinParty(secondGuestFacade.getSnapshot().party.invite!, "房主手机");
    const secondPeer = [...hostInternals.hostPeers.values()].find((candidate) => candidate.member.name === "第二台手机");
    expect(secondPeer).toBeDefined();
    (secondPeer!.channel as unknown as FakeDataChannel).readyState = "open";
    (secondPeer!.channel as unknown as FakeDataChannel).onopen?.(new Event("open"));

    expect(hostFacade.getSnapshot().party.members.map((member) => member.name)).toEqual(["房主手机", "加入手机", "第二台手机"]);
  });

  it("keeps existing members and allows retry when a new phone connection fails", async () => {
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    const host = new MultiplayerService();
    const firstGuest = new MultiplayerService();
    const hostFacade = projectFacade(host);
    const firstGuestFacade = projectFacade(firstGuest);

    await hostFacade.createParty("房主手机");
    await firstGuestFacade.joinParty(hostFacade.getSnapshot().party.invite!, "已连接手机");
    await hostFacade.joinParty(firstGuestFacade.getSnapshot().party.invite!, "房主手机");

    const internals = host as unknown as MultiplayerServiceInternals;
    const firstPeer = [...internals.hostPeers.values()][0];
    (firstPeer.channel as unknown as FakeDataChannel).readyState = "open";
    (firstPeer.channel as unknown as FakeDataChannel).onopen?.(new Event("open"));

    await hostFacade.inviteMore!();
    const secondGuest = new MultiplayerService();
    const secondGuestFacade = projectFacade(secondGuest);
    await secondGuestFacade.joinParty(hostFacade.getSnapshot().party.invite!, "失败手机");
    await hostFacade.joinParty(secondGuestFacade.getSnapshot().party.invite!, "房主手机");
    const pending = [...internals.hostPeers.values()].find((candidate) => candidate.member.name === "失败手机")!;
    (pending.connection as unknown as FakePeerConnection).connectionState = "failed";
    (pending.connection as unknown as FakePeerConnection).onconnectionstatechange?.();

    expect(hostFacade.getSnapshot().party).toMatchObject({
      status: "connected",
      invite: undefined,
      pairingStatus: undefined,
    });
    expect(hostFacade.getSnapshot().party.members.map((member) => member.name)).toEqual(["房主手机", "已连接手机"]);
    expect(hostFacade.getSnapshot().party.error).toContain("局域网连接未能建立");

    await hostFacade.inviteMore!();
    expect(hostFacade.getSnapshot().party).toMatchObject({ status: "connected", pairingStatus: "awaiting-scan" });
    expect(hostFacade.getSnapshot().party.invite).toMatch(/^IVRQR:/);
  });
});
