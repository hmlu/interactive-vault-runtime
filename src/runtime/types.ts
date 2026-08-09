export type DisplayMode = "embedded" | "view";

export interface ProjectStorage<T> {
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
  clear(): Promise<void>;
}

export type MultiplayerJson =
  | null
  | boolean
  | number
  | string
  | MultiplayerJson[]
  | { [key: string]: MultiplayerJson };

export interface MultiplayerMember {
  id: string;
  name: string;
  isHost: boolean;
}

export interface MultiplayerJoinRequest {
  id: string;
  name: string;
  requestedAt: number;
}

export type MultiplayerPartyStatus = "disconnected" | "hosting" | "joining" | "connected";
export type MultiplayerPairingRole = "lan-host" | "qr-host" | "qr-guest";
export type MultiplayerPairingStatus = "awaiting-scan" | "connecting";

export interface MultiplayerPartySnapshot {
  status: MultiplayerPartyStatus;
  canHost: boolean;
  canScan: boolean;
  pairingRole?: MultiplayerPairingRole;
  pairingStatus?: MultiplayerPairingStatus;
  partyId?: string;
  invite?: string;
  localMember?: MultiplayerMember;
  members: MultiplayerMember[];
  pendingJoinRequests: MultiplayerJoinRequest[];
  error?: string;
}

export interface MultiplayerMatchSnapshot {
  id: string;
  projectId: string;
  peerId: string;
  peerName: string;
  role: "challenger" | "invitee";
  protocolVersion: number;
  settings: MultiplayerJson;
}

export interface ProjectMultiplayerSnapshot {
  party: MultiplayerPartySnapshot;
  match?: MultiplayerMatchSnapshot;
}

export interface MultiplayerChallengeOptions {
  protocolVersion: number;
  settings?: MultiplayerJson;
}

export type MultiplayerChallengeResult = "accepted" | "rejected" | "cancelled";

export interface ProjectMultiplayer {
  getSnapshot(): ProjectMultiplayerSnapshot;
  subscribe(listener: (snapshot: ProjectMultiplayerSnapshot) => void): () => void;
  createParty(displayName?: string): Promise<void>;
  inviteMore?(): Promise<void>;
  joinParty(invite: string, displayName?: string): Promise<void>;
  approveJoin(requestId: string): Promise<void>;
  rejectJoin(requestId: string): void;
  leaveParty(): void;
  challenge(memberId: string, options: MultiplayerChallengeOptions): Promise<MultiplayerChallengeResult>;
  send(payload: MultiplayerJson): void;
  onMessage(listener: (payload: MultiplayerJson) => void): () => void;
  endMatch(): void;
}

export interface ProjectContext {
  displayMode: DisplayMode;
  sourcePath?: string;
  storage: ProjectStorage<unknown>;
  openInView(): Promise<void>;
  multiplayer?: ProjectMultiplayer;
}

export interface InteractiveProjectManifest {
  schemaVersion: 1;
  id: string;
  title: string;
  description?: string;
  icon?: string;
  entry: string;
  styles?: string[];
}

export interface InteractiveProjectModule {
  mount(container: HTMLElement, context: ProjectContext): void | (() => void);
}

export interface LoadedInteractiveProject {
  manifestPath: string;
  manifest: InteractiveProjectManifest;
  module: InteractiveProjectModule;
  styleSources: string[];
}

export interface ProjectDirective {
  id?: string;
  manifest?: string;
  mode?: DisplayMode;
}
