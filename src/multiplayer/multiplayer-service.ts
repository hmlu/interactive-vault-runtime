import { Platform, requestUrl } from "obsidian";
import type {
  InteractiveProjectManifest,
  MultiplayerChallengeOptions,
  MultiplayerChallengeResult,
  MultiplayerJson,
  MultiplayerMatchSnapshot,
  MultiplayerMember,
  MultiplayerPartySnapshot,
  ProjectMultiplayer,
  ProjectMultiplayerSnapshot,
} from "../runtime/types";
import { LocalSignalingServer } from "./local-signaling-server";
import {
  MAX_GAME_MESSAGE_BYTES,
  encodeInvite,
  isPartyWireMessage,
  parseInvite,
  randomId,
  type PartyWireMessage,
  type ProjectDescriptor,
  type SignalMessage,
} from "./protocol";

interface ProjectIdentity {
  manifestPath: string;
  manifest: InteractiveProjectManifest;
}

interface PeerConnectionRecord {
  member: MultiplayerMember;
  connection: RTCPeerConnection;
  channel: RTCDataChannel | null;
}

interface GuestSignalSession {
  endpoint: string;
  peerId: string;
  secret: string;
  stopped: boolean;
}

interface PendingChallenge {
  challengeId: string;
  from: string;
  peerName: string;
  project: ProjectDescriptor;
  protocolVersion: number;
  settings: MultiplayerJson;
}

interface ChallengeResolver {
  project: ProjectDescriptor;
  peerId: string;
  peerName: string;
  protocolVersion: number;
  settings: MultiplayerJson;
  resolve(result: MultiplayerChallengeResult): void;
}

export interface IncomingChallengeSnapshot extends PendingChallenge {}

export class MultiplayerService {
  private party: MultiplayerPartySnapshot = disconnectedParty();
  private signalingServer: LocalSignalingServer | null = null;
  private guestSignal: GuestSignalSession | null = null;
  private hostPeers = new Map<string, PeerConnectionRecord>();
  private guestPeer: PeerConnectionRecord | null = null;
  private subscribers = new Set<() => void>();
  private messageSubscribers = new Map<string, Set<(payload: MultiplayerJson) => void>>();
  private pendingProjectMessages = new Map<string, MultiplayerJson[]>();
  private activeMatch: MultiplayerMatchSnapshot | null = null;
  private pendingChallenges = new Map<string, ChallengeResolver>();
  private incomingChallenge: PendingChallenge | null = null;
  private signalingStop: Promise<void> | null = null;

  createProjectFacade(project: ProjectIdentity): ProjectMultiplayer {
    const projectId = project.manifest.id;
    return {
      getSnapshot: () => this.projectSnapshot(projectId),
      subscribe: (listener) => {
        const notify = () => listener(this.projectSnapshot(projectId));
        this.subscribers.add(notify);
        notify();
        return () => this.subscribers.delete(notify);
      },
      createParty: (displayName) => this.createParty(displayName),
      joinParty: (invite, displayName) => this.joinParty(invite, displayName),
      approveJoin: (requestId) => this.approveJoin(requestId),
      rejectJoin: (requestId) => this.rejectJoin(requestId),
      leaveParty: () => this.leaveParty(),
      challenge: (memberId, options) => this.challenge(project, memberId, options),
      send: (payload) => this.sendGameMessage(projectId, payload),
      onMessage: (listener) => this.onProjectMessage(projectId, listener),
      endMatch: () => this.endMatch(projectId),
    };
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  getIncomingChallenge(): IncomingChallengeSnapshot | null {
    return this.incomingChallenge ? { ...this.incomingChallenge } : null;
  }

  async respondToIncomingChallenge(accept: boolean): Promise<ProjectDescriptor | null> {
    const challenge = this.incomingChallenge;
    if (!challenge) return null;
    this.incomingChallenge = null;
    if (accept && this.activeMatch) this.endMatch(this.activeMatch.projectId);
    if (accept) {
      this.activeMatch = {
        id: challenge.challengeId,
        projectId: challenge.project.id,
        peerId: challenge.from,
        peerName: challenge.peerName,
        role: "invitee",
        protocolVersion: challenge.protocolVersion,
        settings: challenge.settings,
      };
    }
    this.sendWire({
      v: 1,
      type: "challenge-response",
      from: this.party.localMember!.id,
      to: challenge.from,
      challengeId: challenge.challengeId,
      accepted: accept,
    });
    this.notify();
    return accept ? challenge.project : null;
  }

  async dispose(): Promise<void> {
    this.leaveParty();
    await this.signalingStop;
  }

  private async createParty(displayName?: string): Promise<void> {
    if (!Platform.isDesktopApp) throw new Error("当前移动端只能加入联机小队；创建小队需要桌面端房主");
    this.leaveParty();
    const partyId = randomId("party");
    const token = randomId("invite");
    const localMember: MultiplayerMember = { id: randomId("host"), name: normalizeName(displayName, "房主设备"), isHost: true };
    const server = new LocalSignalingServer(partyId, token, {
      onJoin: (request) => {
        this.party = { ...this.party, pendingJoinRequests: [...this.party.pendingJoinRequests, request] };
        this.notify();
      },
      onSignal: (peerId, message) => { void this.handleHostSignal(peerId, message); },
      onLeave: (peerId) => this.removeHostPeer(peerId),
    });
    try {
      const port = await server.start();
      const address = firstPrivateIpv4Address();
      if (!address) throw new Error("没有找到可用于局域网联机的 IPv4 地址");
      this.signalingServer = server;
      this.party = {
        status: "hosting",
        canHost: true,
        partyId,
        invite: encodeInvite({ version: 1, endpoint: `http://${address}:${port}`, partyId, token }),
        localMember,
        members: [localMember],
        pendingJoinRequests: [],
      };
      this.notify();
    } catch (error) {
      await server.stop();
      this.party = { ...disconnectedParty(), error: errorMessage(error) };
      this.notify();
      throw error;
    }
  }

  private async joinParty(inviteValue: string, displayName?: string): Promise<void> {
    this.leaveParty();
    const invite = parseInvite(inviteValue);
    const localName = normalizeName(displayName, "加入设备");
    this.party = { ...disconnectedParty(), status: "joining", canHost: Platform.isDesktopApp };
    this.notify();
    try {
      const response = await postJson(invite.endpoint, "/join", { partyId: invite.partyId, token: invite.token, name: localName });
      if (typeof response.peerId !== "string" || typeof response.secret !== "string") throw new Error("房主返回了无效的加入响应");
      const localMember: MultiplayerMember = { id: response.peerId, name: localName, isHost: false };
      this.guestSignal = { endpoint: invite.endpoint, peerId: response.peerId, secret: response.secret, stopped: false };
      this.party = {
        status: "joining",
        canHost: Platform.isDesktopApp,
        partyId: invite.partyId,
        localMember,
        members: [localMember],
        pendingJoinRequests: [],
      };
      this.notify();
      void this.pollGuestSignals(this.guestSignal);
    } catch (error) {
      this.party = { ...disconnectedParty(), error: errorMessage(error) };
      this.notify();
      throw error;
    }
  }

  private async approveJoin(requestId: string): Promise<void> {
    if (!this.signalingServer || !this.party.localMember?.isHost) throw new Error("当前设备不是联机小队房主");
    const request = this.party.pendingJoinRequests.find((candidate) => candidate.id === requestId);
    if (!request) throw new Error("加入申请已经失效");
    this.party = { ...this.party, pendingJoinRequests: this.party.pendingJoinRequests.filter((candidate) => candidate.id !== requestId) };
    const connection = new RTCPeerConnection({ iceServers: [] });
    const channel = connection.createDataChannel("interactive-vault", { ordered: true });
    const member: MultiplayerMember = { id: request.id, name: request.name, isHost: false };
    const record: PeerConnectionRecord = { member, connection, channel };
    this.hostPeers.set(request.id, record);
    this.bindHostChannel(record, channel);
    connection.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(connection.connectionState)) this.removeHostPeer(request.id);
    };
    try {
      await connection.setLocalDescription(await connection.createOffer());
      await waitForIceGathering(connection);
      const sdp = connection.localDescription?.sdp;
      if (!sdp) throw new Error("无法创建 WebRTC 联机邀请");
      this.signalingServer.queue(request.id, { type: "offer", sdp });
      this.notify();
    } catch (error) {
      this.removeHostPeer(request.id);
      this.signalingServer.reject(request.id, errorMessage(error));
      throw error;
    }
  }

  private rejectJoin(requestId: string): void {
    this.party = { ...this.party, pendingJoinRequests: this.party.pendingJoinRequests.filter((candidate) => candidate.id !== requestId) };
    this.signalingServer?.reject(requestId, "房主拒绝了加入申请");
    this.notify();
  }

  private leaveParty(): void {
    const guestSignal = this.guestSignal;
    if (guestSignal) {
      guestSignal.stopped = true;
      void postJson(guestSignal.endpoint, "/leave", { peerId: guestSignal.peerId, secret: guestSignal.secret }).catch(() => undefined);
    }
    this.guestSignal = null;
    this.guestPeer?.channel?.close();
    this.guestPeer?.connection.close();
    this.guestPeer = null;
    for (const peer of this.hostPeers.values()) {
      peer.channel?.close();
      peer.connection.close();
    }
    this.hostPeers.clear();
    const signalingServer = this.signalingServer;
    this.signalingServer = null;
    this.signalingStop = signalingServer?.stop() ?? null;
    for (const pending of this.pendingChallenges.values()) pending.resolve("cancelled");
    this.pendingChallenges.clear();
    this.incomingChallenge = null;
    this.activeMatch = null;
    this.pendingProjectMessages.clear();
    this.party = disconnectedParty();
    this.notify();
  }

  private challenge(project: ProjectIdentity, memberId: string, options: MultiplayerChallengeOptions): Promise<MultiplayerChallengeResult> {
    const local = this.party.localMember;
    const peer = this.party.members.find((member) => member.id === memberId && member.id !== local?.id);
    if (!local || !peer || this.party.status === "disconnected" || this.party.status === "joining") {
      return Promise.reject(new Error("对方当前不在联机小队中"));
    }
    if (this.activeMatch) return Promise.reject(new Error("请先结束当前联机对局"));
    const challengeId = randomId("match");
    const descriptor: ProjectDescriptor = { id: project.manifest.id, title: project.manifest.title, manifestPath: project.manifestPath };
    const settings = options.settings ?? null;
    return new Promise((resolve) => {
      this.pendingChallenges.set(challengeId, {
        project: descriptor,
        peerId: peer.id,
        peerName: peer.name,
        protocolVersion: options.protocolVersion,
        settings,
        resolve,
      });
      this.sendWire({
        v: 1,
        type: "challenge",
        from: local.id,
        to: peer.id,
        challengeId,
        project: descriptor,
        protocolVersion: options.protocolVersion,
        settings,
      });
      globalThis.setTimeout(() => {
        const pending = this.pendingChallenges.get(challengeId);
        if (!pending) return;
        this.pendingChallenges.delete(challengeId);
        pending.resolve("cancelled");
      }, 30_000);
    });
  }

  private sendGameMessage(projectId: string, payload: MultiplayerJson): void {
    const match = this.activeMatch;
    const local = this.party.localMember;
    if (!match || match.projectId !== projectId || !local) throw new Error("当前游戏没有活动的联机对局");
    const serialized = JSON.stringify(payload);
    if (serialized.length > MAX_GAME_MESSAGE_BYTES) throw new Error("联机游戏消息过大");
    this.sendWire({ v: 1, type: "game-message", from: local.id, to: match.peerId, matchId: match.id, projectId, payload });
  }

  private onProjectMessage(projectId: string, listener: (payload: MultiplayerJson) => void): () => void {
    let listeners = this.messageSubscribers.get(projectId);
    if (!listeners) {
      listeners = new Set();
      this.messageSubscribers.set(projectId, listeners);
    }
    listeners.add(listener);
    const queued = this.pendingProjectMessages.get(projectId);
    if (queued) {
      this.pendingProjectMessages.delete(projectId);
      for (const payload of queued) listener(payload);
    }
    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0) this.messageSubscribers.delete(projectId);
    };
  }

  private endMatch(projectId: string): void {
    const match = this.activeMatch;
    const local = this.party.localMember;
    if (!match || match.projectId !== projectId || !local) return;
    this.sendWire({ v: 1, type: "match-end", from: local.id, to: match.peerId, matchId: match.id, projectId });
    this.activeMatch = null;
    this.notify();
  }

  private async pollGuestSignals(session: GuestSignalSession): Promise<void> {
    while (!session.stopped && this.guestSignal === session) {
      try {
        const query = `/poll?peerId=${encodeURIComponent(session.peerId)}&secret=${encodeURIComponent(session.secret)}`;
        const result = await getJson(session.endpoint, query);
        const messages = Array.isArray(result.messages) ? result.messages : [];
        for (const message of messages) await this.handleGuestSignal(session, message as SignalMessage);
      } catch (error) {
        if (!session.stopped) {
          this.party = { ...this.party, error: `无法联系房主：${errorMessage(error)}` };
          this.notify();
        }
      }
      if (!session.stopped && this.guestSignal === session) await delay(350);
    }
  }

  private async handleGuestSignal(session: GuestSignalSession, message: SignalMessage): Promise<void> {
    if (message.type === "rejected") {
      session.stopped = true;
      this.party = { ...disconnectedParty(), error: message.reason };
      this.notify();
      return;
    }
    if (message.type !== "offer" || this.guestPeer) return;
    const connection = new RTCPeerConnection({ iceServers: [] });
    const hostMember: MultiplayerMember = { id: "pending-host", name: "房主设备", isHost: true };
    const record: PeerConnectionRecord = { member: hostMember, connection, channel: null };
    this.guestPeer = record;
    connection.ondatachannel = (event) => {
      record.channel = event.channel;
      this.bindGuestChannel(record, event.channel);
    };
    connection.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(connection.connectionState) && this.party.status === "connected") {
        this.party = { ...this.party, status: "joining", error: "与房主的连接已断开" };
        this.notify();
      }
    };
    await connection.setRemoteDescription({ type: "offer", sdp: message.sdp });
    await connection.setLocalDescription(await connection.createAnswer());
    await waitForIceGathering(connection);
    const sdp = connection.localDescription?.sdp;
    if (!sdp) throw new Error("无法创建 WebRTC 应答");
    await postJson(session.endpoint, "/signal", { peerId: session.peerId, secret: session.secret, message: { type: "answer", sdp } });
  }

  private async handleHostSignal(peerId: string, message: SignalMessage): Promise<void> {
    if (message.type !== "answer") return;
    const record = this.hostPeers.get(peerId);
    if (!record) return;
    await record.connection.setRemoteDescription({ type: "answer", sdp: message.sdp });
  }

  private bindHostChannel(record: PeerConnectionRecord, channel: RTCDataChannel): void {
    channel.onopen = () => {
      if (!this.party.members.some((member) => member.id === record.member.id)) {
        this.party = { ...this.party, status: "connected", members: [...this.party.members, record.member] };
      }
      this.broadcastPartyState();
      this.notify();
    };
    channel.onmessage = (event) => this.receiveWire(event.data, record.member.id);
    channel.onclose = () => this.removeHostPeer(record.member.id);
  }

  private bindGuestChannel(record: PeerConnectionRecord, channel: RTCDataChannel): void {
    channel.onopen = () => {
      if (this.guestSignal) this.guestSignal.stopped = true;
      this.party = { ...this.party, status: "connected", error: undefined };
      this.notify();
    };
    channel.onmessage = (event) => this.receiveWire(event.data);
    channel.onclose = () => {
      if (this.party.status !== "disconnected") {
        this.party = { ...this.party, status: "joining", error: "房主已断开联机小队" };
        this.notify();
      }
    };
  }

  private receiveWire(raw: unknown, authenticatedPeerId?: string): void {
    if (typeof raw !== "string" || raw.length > MAX_GAME_MESSAGE_BYTES) return;
    let message: unknown;
    try { message = JSON.parse(raw); } catch { return; }
    if (!isPartyWireMessage(message)) return;
    const wire = message as PartyWireMessage;
    if (authenticatedPeerId) wire.from = authenticatedPeerId;
    const localId = this.party.localMember?.id;
    if (!localId) return;
    if (this.party.localMember?.isHost && wire.to && wire.to !== localId) {
      this.sendToHostPeer(wire.to, wire);
      return;
    }
    if (wire.to && wire.to !== localId) return;
    this.processWire(wire);
  }

  private processWire(message: PartyWireMessage): void {
    if (message.type === "party-state") {
      this.party = { ...this.party, status: "connected", members: message.members, error: undefined };
      const host = message.members.find((member) => member.isHost);
      if (host && this.guestPeer) this.guestPeer.member = host;
      this.notify();
      return;
    }
    if (message.type === "challenge") {
      if (this.activeMatch || this.incomingChallenge) {
        this.sendWire({ v: 1, type: "challenge-response", from: this.party.localMember!.id, to: message.from, challengeId: message.challengeId, accepted: false });
        return;
      }
      const peer = this.party.members.find((member) => member.id === message.from);
      this.incomingChallenge = {
        challengeId: message.challengeId,
        from: message.from,
        peerName: peer?.name ?? "联机伙伴",
        project: message.project,
        protocolVersion: message.protocolVersion,
        settings: message.settings,
      };
      this.notify();
      return;
    }
    if (message.type === "challenge-response") {
      const pending = this.pendingChallenges.get(message.challengeId);
      if (!pending || pending.peerId !== message.from) return;
      this.pendingChallenges.delete(message.challengeId);
      if (message.accepted) {
        this.activeMatch = {
          id: message.challengeId,
          projectId: pending.project.id,
          peerId: pending.peerId,
          peerName: pending.peerName,
          role: "challenger",
          protocolVersion: pending.protocolVersion,
          settings: pending.settings,
        };
      }
      pending.resolve(message.accepted ? "accepted" : "rejected");
      this.notify();
      return;
    }
    if (message.type === "game-message") {
      const match = this.activeMatch;
      if (!match || match.id !== message.matchId || match.projectId !== message.projectId || match.peerId !== message.from) return;
      const listeners = this.messageSubscribers.get(message.projectId);
      if (!listeners || listeners.size === 0) {
        const queued = this.pendingProjectMessages.get(message.projectId) ?? [];
        queued.push(message.payload);
        this.pendingProjectMessages.set(message.projectId, queued.slice(-8));
      } else {
        for (const listener of listeners) listener(message.payload);
      }
      return;
    }
    if (message.type === "match-end") {
      if (this.activeMatch?.id === message.matchId && this.activeMatch.projectId === message.projectId) {
        this.activeMatch = null;
        this.notify();
      }
    }
  }

  private sendWire(message: PartyWireMessage): void {
    const local = this.party.localMember;
    if (!local) return;
    if (local.isHost) {
      if (message.to === local.id) this.processWire(message);
      else if (message.to) this.sendToHostPeer(message.to, message);
      return;
    }
    const channel = this.guestPeer?.channel;
    if (channel?.readyState === "open") channel.send(JSON.stringify(message));
  }

  private sendToHostPeer(peerId: string, message: PartyWireMessage): void {
    const channel = this.hostPeers.get(peerId)?.channel;
    if (channel?.readyState === "open") channel.send(JSON.stringify(message));
  }

  private broadcastPartyState(): void {
    const local = this.party.localMember;
    if (!local?.isHost) return;
    for (const peer of this.hostPeers.values()) {
      if (peer.channel?.readyState !== "open") continue;
      peer.channel.send(JSON.stringify({ v: 1, type: "party-state", from: local.id, to: peer.member.id, members: this.party.members } satisfies PartyWireMessage));
    }
  }

  private removeHostPeer(peerId: string): void {
    const record = this.hostPeers.get(peerId);
    if (!record) return;
    record.channel?.close();
    record.connection.close();
    this.hostPeers.delete(peerId);
    this.party = { ...this.party, status: this.hostPeers.size > 0 ? "connected" : "hosting", members: this.party.members.filter((member) => member.id !== peerId) };
    if (this.activeMatch?.peerId === peerId) this.activeMatch = null;
    this.broadcastPartyState();
    this.notify();
  }

  private projectSnapshot(projectId: string): ProjectMultiplayerSnapshot {
    return { party: cloneParty(this.party), match: this.activeMatch?.projectId === projectId ? { ...this.activeMatch } : undefined };
  }

  private notify(): void {
    for (const listener of this.subscribers) listener();
  }
}

function disconnectedParty(): MultiplayerPartySnapshot {
  return { status: "disconnected", canHost: Platform.isDesktopApp, members: [], pendingJoinRequests: [] };
}

function cloneParty(party: MultiplayerPartySnapshot): MultiplayerPartySnapshot {
  return {
    ...party,
    localMember: party.localMember ? { ...party.localMember } : undefined,
    members: party.members.map((member) => ({ ...member })),
    pendingJoinRequests: party.pendingJoinRequests.map((request) => ({ ...request })),
  };
}

function normalizeName(value: string | undefined, fallback: string): string {
  const normalized = value?.trim().slice(0, 40);
  return normalized || fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

async function waitForIceGathering(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const timeout = globalThis.setTimeout(done, 5000);
    function done() {
      globalThis.clearTimeout(timeout);
      connection.removeEventListener("icegatheringstatechange", check);
      resolve();
    }
    function check() { if (connection.iceGatheringState === "complete") done(); }
    connection.addEventListener("icegatheringstatechange", check);
  });
}

async function postJson(endpoint: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await requestUrl({ url: `${endpoint}${path}`, method: "POST", contentType: "application/json", body: JSON.stringify(body), throw: false });
  if (response.status < 200 || response.status >= 300) throw new Error(readResponseError(response.json));
  return response.json as Record<string, unknown>;
}

async function getJson(endpoint: string, path: string): Promise<Record<string, unknown>> {
  const response = await requestUrl({ url: `${endpoint}${path}`, method: "GET", throw: false });
  if (response.status < 200 || response.status >= 300) throw new Error(readResponseError(response.json));
  return response.json as Record<string, unknown>;
}

function readResponseError(value: unknown): string {
  if (value && typeof value === "object" && typeof (value as { error?: unknown }).error === "string") return (value as { error: string }).error;
  return "局域网接入请求失败";
}

function firstPrivateIpv4Address(): string | null {
  const os = require("node:os") as typeof import("node:os");
  const candidates = Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter((address) => address.family === "IPv4" && !address.internal && isPrivateIpv4(address.address))
      .map((address) => ({ name, address: address.address })),
  );
  candidates.sort((a, b) => interfacePriority(a.name) - interfacePriority(b.name));
  return candidates[0]?.address ?? null;
}

function interfacePriority(name: string): number {
  if (/^(en0|wi-?fi|wlan0)$/i.test(name)) return 0;
  if (/^(en\d+|wlan\d+)$/i.test(name)) return 1;
  return 2;
}

function isPrivateIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  return parts.length === 4 && (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
