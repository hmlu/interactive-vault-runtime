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
  encodeQrInvite,
  isPartyWireMessage,
  parseInvite,
  randomId,
  type PartyWireMessage,
  type ProjectDescriptor,
  type QrAnswerInvite,
  type QrOfferInvite,
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

interface QrHostSession {
  partyId: string;
  token: string;
  hostId: string;
  expiresAt: number;
  connection: RTCPeerConnection;
  channel: RTCDataChannel;
  connectionTimeout?: ReturnType<typeof globalThis.setTimeout>;
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
  private qrHostSession: QrHostSession | null = null;
  private qrInviteGeneration = 0;
  private qrInvitePreparing = false;
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
      inviteMore: () => this.inviteMore(),
      joinParty: (invite, displayName) => this.joinParty(invite, displayName),
      approveJoin: (requestId) => this.approveJoin(requestId),
      rejectJoin: (requestId) => this.rejectJoin(requestId),
      leaveParty: () => this.leaveParty(),
      challenge: (memberId, options) => this.challenge(project, memberId, options),
      send: (payload) => this.sendGameMessage(projectId, payload),
      getBufferedAmount: () => this.getGameBufferedAmount(projectId),
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
    if (Platform.isDesktopApp) return this.createDesktopParty(displayName);
    return this.createQrParty(displayName);
  }

  private async createDesktopParty(displayName?: string): Promise<void> {
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
        canScan: false,
        pairingRole: "lan-host",
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
    const invite = parseInvite(inviteValue);
    if (invite.version === 2 && invite.type === "answer") return this.completeQrPairing(invite);
    if (invite.version === 2 && this.party.pairingRole === "qr-host") {
      throw new Error("请扫描加入手机展示的回传码");
    }
    this.leaveParty();
    if (invite.version === 2) return this.joinQrParty(invite, displayName);
    const localName = normalizeName(displayName, "加入设备");
    this.party = { ...disconnectedParty(), status: "joining" };
    this.notify();
    try {
      const response = await postJson(invite.endpoint, "/join", { partyId: invite.partyId, token: invite.token, name: localName });
      if (typeof response.peerId !== "string" || typeof response.secret !== "string") throw new Error("房主返回了无效的加入响应");
      const localMember: MultiplayerMember = { id: response.peerId, name: localName, isHost: false };
      this.guestSignal = { endpoint: invite.endpoint, peerId: response.peerId, secret: response.secret, stopped: false };
      this.party = {
        status: "joining",
        canHost: true,
        canScan: Platform.isMobileApp,
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

  private async createQrParty(displayName?: string): Promise<void> {
    this.leaveParty();
    const partyId = randomId("party");
    const localMember: MultiplayerMember = { id: randomId("host"), name: normalizeName(displayName, "手机房主"), isHost: true };
    this.party = {
      status: "hosting",
      canHost: true,
      canScan: true,
      pairingRole: "qr-host",
      partyId,
      localMember,
      members: [localMember],
      pendingJoinRequests: [],
    };
    this.notify();
    try {
      await this.prepareQrHostInvite();
    } catch (error) {
      if (this.party.partyId === partyId && this.party.localMember?.id === localMember.id) {
        this.party = { ...disconnectedParty(), error: errorMessage(error) };
        this.notify();
      }
      throw error;
    }
  }

  private async inviteMore(): Promise<void> {
    const local = this.party.localMember;
    if (!local?.isHost) throw new Error("只有房主可以邀请其他设备");
    if (this.party.pairingRole === "lan-host") {
      if (this.party.invite) return;
      throw new Error("当前电脑小队没有可用的邀请");
    }
    if (this.party.pairingRole !== "qr-host") throw new Error("当前小队不支持手机二维码邀请");
    if (this.qrHostSession || this.qrInvitePreparing || this.party.pairingStatus) throw new Error("请先完成当前设备的配对");
    await this.prepareQrHostInvite();
  }

  private async prepareQrHostInvite(): Promise<void> {
    const localMember = this.party.localMember;
    const partyId = this.party.partyId;
    if (!localMember?.isHost || !partyId || this.party.pairingRole !== "qr-host") {
      throw new Error("当前设备不是手机小队房主");
    }
    if (this.qrInvitePreparing) throw new Error("正在生成手机联机邀请");
    this.qrInvitePreparing = true;
    const generation = ++this.qrInviteGeneration;
    const token = randomId("invite");
    const expiresAt = Date.now() + 10 * 60_000;
    const connection = new RTCPeerConnection({ iceServers: [] });
    const channel = connection.createDataChannel("interactive-vault", { ordered: true });
    try {
      await connection.setLocalDescription(await connection.createOffer());
      await waitForIceGathering(connection, 12_000);
      if (generation !== this.qrInviteGeneration || this.party.partyId !== partyId || this.party.localMember?.id !== localMember.id) {
        throw new Error("手机联机邀请已取消");
      }
      const sdp = connection.localDescription?.sdp;
      if (!sdp || !hasIceCandidate(sdp)) throw new Error("没有获取到可用的局域网连接地址，请保持 Wi-Fi 开启后重试");
      this.qrHostSession = { partyId, token, hostId: localMember.id, expiresAt, connection, channel };
      this.party = {
        ...this.party,
        pairingStatus: "awaiting-scan",
        invite: encodeQrInvite({ version: 2, transport: "qr", type: "offer", partyId, token, expiresAt, host: localMember, sdp }),
        error: undefined,
      };
      this.notify();
    } catch (error) {
      channel.close();
      connection.close();
      throw error;
    } finally {
      if (generation === this.qrInviteGeneration) this.qrInvitePreparing = false;
    }
  }

  private async joinQrParty(invite: QrOfferInvite, displayName?: string): Promise<void> {
    const localMember: MultiplayerMember = { id: randomId("peer"), name: normalizeName(displayName, "加入手机"), isHost: false };
    const connection = new RTCPeerConnection({ iceServers: [] });
    const record: PeerConnectionRecord = { member: invite.host, connection, channel: null };
    this.guestPeer = record;
    this.party = {
      status: "joining",
      canHost: true,
      canScan: true,
      pairingRole: "qr-guest",
      partyId: invite.partyId,
      localMember,
      members: [localMember],
      pendingJoinRequests: [],
    };
    this.notify();
    connection.ondatachannel = (event) => {
      record.channel = event.channel;
      this.bindGuestChannel(record, event.channel);
    };
    connection.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(connection.connectionState)) {
        this.disconnectGuest(record, "与手机房主的连接已断开");
      }
    };
    try {
      await connection.setRemoteDescription({ type: "offer", sdp: invite.sdp });
      await connection.setLocalDescription(await connection.createAnswer());
      await waitForIceGathering(connection, 12_000);
      const sdp = connection.localDescription?.sdp;
      if (!sdp || !hasIceCandidate(sdp)) throw new Error("没有获取到可用的局域网连接地址，请保持 Wi-Fi 开启后重试");
      this.party = {
        ...this.party,
        pairingStatus: "awaiting-scan",
        invite: encodeQrInvite({
          version: 2,
          transport: "qr",
          type: "answer",
          partyId: invite.partyId,
          token: invite.token,
          expiresAt: invite.expiresAt,
          hostId: invite.host.id,
          guest: localMember,
          sdp,
        }),
      };
      this.notify();
    } catch (error) {
      this.guestPeer = null;
      connection.close();
      this.party = { ...disconnectedParty(), error: errorMessage(error) };
      this.notify();
      throw error;
    }
  }

  private async completeQrPairing(invite: QrAnswerInvite): Promise<void> {
    const session = this.qrHostSession;
    const local = this.party.localMember;
    if (!session || !local?.isHost || this.party.pairingRole !== "qr-host") throw new Error("当前没有等待确认的手机小队");
    if (invite.partyId !== session.partyId || invite.token !== session.token || invite.hostId !== session.hostId) {
      throw new Error("回传码不属于当前手机小队");
    }
    if (this.hostPeers.has(invite.guest.id)) throw new Error("这台设备已经加入当前小队");
    const record: PeerConnectionRecord = { member: invite.guest, connection: session.connection, channel: session.channel };
    this.hostPeers.set(invite.guest.id, record);
    this.bindHostChannel(record, session.channel, () => {
      if (this.qrHostSession !== session) return;
      if (session.connectionTimeout !== undefined) globalThis.clearTimeout(session.connectionTimeout);
      this.qrHostSession = null;
      this.party = { ...this.party, pairingStatus: undefined, invite: undefined, error: undefined };
    });
    session.connection.onconnectionstatechange = () => {
      const state = session.connection.connectionState;
      if (state === "disconnected" && this.qrHostSession === session) return;
      if (!["failed", "closed", "disconnected"].includes(state)) return;
      if (this.qrHostSession === session) {
        this.failQrHostPairing(session, record, "局域网连接未能建立，请确认两台设备连接同一 Wi-Fi 后重新邀请");
      } else {
        this.removeHostPeer(invite.guest.id);
      }
    };
    this.party = { ...this.party, pairingStatus: "connecting", invite: undefined, error: undefined };
    this.notify();
    session.connectionTimeout = globalThis.setTimeout(() => {
      this.failQrHostPairing(session, record, "局域网连接超时，请确认两台设备连接同一 Wi-Fi 后重新邀请");
    }, 20_000);
    try {
      await session.connection.setRemoteDescription({ type: "answer", sdp: invite.sdp });
    } catch (error) {
      this.failQrHostPairing(session, record, `无法应用手机回传信息：${errorMessage(error)}`);
      throw error;
    }
  }

  private failQrHostPairing(session: QrHostSession, record: PeerConnectionRecord, reason: string): void {
    if (this.qrHostSession !== session) return;
    if (session.connectionTimeout !== undefined) globalThis.clearTimeout(session.connectionTimeout);
    this.qrHostSession = null;
    if (this.hostPeers.get(record.member.id) === record) this.hostPeers.delete(record.member.id);
    session.channel.close();
    session.connection.close();
    const hasRemoteMember = this.party.members.some((member) => member.id !== this.party.localMember?.id);
    this.party = {
      ...this.party,
      status: hasRemoteMember ? "connected" : "hosting",
      pairingStatus: undefined,
      invite: undefined,
      error: reason,
    };
    this.notify();
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
    this.qrInviteGeneration += 1;
    this.qrInvitePreparing = false;
    const guestSignal = this.guestSignal;
    if (guestSignal) {
      guestSignal.stopped = true;
      void postJson(guestSignal.endpoint, "/leave", { peerId: guestSignal.peerId, secret: guestSignal.secret }).catch(() => undefined);
    }
    this.guestSignal = null;
    const qrHostSession = this.qrHostSession;
    this.qrHostSession = null;
    if (qrHostSession?.connectionTimeout !== undefined) globalThis.clearTimeout(qrHostSession.connectionTimeout);
    qrHostSession?.channel.close();
    qrHostSession?.connection.close();
    const guestPeer = this.guestPeer;
    this.guestPeer = null;
    guestPeer?.channel?.close();
    guestPeer?.connection.close();
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

  private getGameBufferedAmount(projectId: string): number {
    const match = this.activeMatch;
    const local = this.party.localMember;
    if (!match || match.projectId !== projectId || !local) return 0;
    const channel = local.isHost ? this.hostPeers.get(match.peerId)?.channel : this.guestPeer?.channel;
    return channel?.readyState === "open" ? channel.bufferedAmount : 0;
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
      if (["failed", "closed", "disconnected"].includes(connection.connectionState)) {
        this.disconnectGuest(record, "与房主的连接已断开");
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

  private bindHostChannel(record: PeerConnectionRecord, channel: RTCDataChannel, onOpen?: () => void): void {
    channel.onopen = () => {
      if (!this.party.members.some((member) => member.id === record.member.id)) {
        this.party = { ...this.party, status: "connected", members: [...this.party.members, record.member] };
      }
      onOpen?.();
      this.broadcastPartyState();
      this.notify();
    };
    channel.onmessage = (event) => this.receiveWire(event.data, record.member.id);
    channel.onclose = () => this.removeHostPeer(record.member.id);
  }

  private bindGuestChannel(record: PeerConnectionRecord, channel: RTCDataChannel): void {
    channel.onopen = () => {
      if (this.guestSignal) this.guestSignal.stopped = true;
      this.party = { ...this.party, status: "connected", pairingStatus: undefined, invite: undefined, error: undefined };
      this.notify();
    };
    channel.onmessage = (event) => this.receiveWire(event.data);
    channel.onclose = () => this.disconnectGuest(record, "房主已断开联机小队");
  }

  private disconnectGuest(record: PeerConnectionRecord, reason: string): void {
    if (this.guestPeer !== record) return;
    this.guestPeer = null;
    const signal = this.guestSignal;
    if (signal) signal.stopped = true;
    this.guestSignal = null;
    record.channel?.close();
    record.connection.close();
    for (const pending of this.pendingChallenges.values()) pending.resolve("cancelled");
    this.pendingChallenges.clear();
    this.incomingChallenge = null;
    this.activeMatch = null;
    this.pendingProjectMessages.clear();
    this.party = { ...disconnectedParty(), error: reason };
    this.notify();
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
    const members = this.party.members.filter((member) => member.id !== peerId);
    const hasRemoteMember = members.some((member) => member.id !== this.party.localMember?.id);
    this.party = { ...this.party, status: hasRemoteMember ? "connected" : "hosting", members };
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
  return { status: "disconnected", canHost: true, canScan: Platform.isMobileApp, members: [], pendingJoinRequests: [] };
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

function hasIceCandidate(sdp: string): boolean {
  return /^a=candidate:/m.test(sdp);
}

async function waitForIceGathering(connection: RTCPeerConnection, timeoutMs = 5000): Promise<void> {
  if (connection.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const timeout = globalThis.setTimeout(done, timeoutMs);
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
  return requestLanJson(endpoint, path, "POST", body);
}

async function getJson(endpoint: string, path: string): Promise<Record<string, unknown>> {
  return requestLanJson(endpoint, path, "GET");
}

class LanResponseError extends Error {}

async function requestLanJson(endpoint: string, path: string, method: "GET" | "POST", body?: unknown): Promise<Record<string, unknown>> {
  const url = `${endpoint}${path}`;
  if (Platform.isMobileApp) {
    try {
      return await fetchLanJson(url, method, body);
    } catch (webError) {
      if (webError instanceof LanResponseError) throw webError;
      try {
        return await requestUrlJson(url, method, body);
      } catch (nativeError) {
        if (nativeError instanceof LanResponseError) throw nativeError;
        console.warn("[InteractiveVaultRuntime] 手机局域网请求失败", { webError, nativeError });
        throw new Error("无法访问电脑的局域网地址。请在系统设置中允许 Obsidian 访问本地网络，并确认两台设备连接同一 Wi‑Fi且未使用访客网络");
      }
    }
  }
  return requestUrlJson(url, method, body);
}

async function fetchLanJson(url: string, method: "GET" | "POST", body?: unknown): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      method,
      headers: method === "POST" ? { "Content-Type": "text/plain;charset=UTF-8" } : undefined,
      body: method === "POST" ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: controller.signal,
    });
    const value = await response.json() as unknown;
    if (!response.ok) throw new LanResponseError(readResponseError(value));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new LanResponseError("局域网接入响应无效");
    return value as Record<string, unknown>;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function requestUrlJson(url: string, method: "GET" | "POST", body?: unknown): Promise<Record<string, unknown>> {
  const response = await requestUrl({
    url,
    method,
    contentType: method === "POST" ? "application/json" : undefined,
    body: method === "POST" ? JSON.stringify(body) : undefined,
    throw: false,
  });
  if (response.status < 200 || response.status >= 300) throw new LanResponseError(readResponseError(response.json));
  if (!response.json || typeof response.json !== "object" || Array.isArray(response.json)) throw new LanResponseError("局域网接入响应无效");
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
