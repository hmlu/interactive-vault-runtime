import type { MultiplayerJson, MultiplayerMember } from "../runtime/types";

export const MULTIPLAYER_WIRE_VERSION = 1;
export const MAX_SIGNAL_BODY_BYTES = 96 * 1024;
export const MAX_GAME_MESSAGE_BYTES = 256 * 1024;

export interface LanInvite {
  version: 1;
  endpoint: string;
  partyId: string;
  token: string;
}

export type SignalMessage =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "rejected"; reason: string };

export interface ProjectDescriptor {
  id: string;
  title: string;
  manifestPath: string;
}

export type PartyWireMessage =
  | { v: 1; type: "party-state"; from: string; to?: string; members: MultiplayerMember[] }
  | { v: 1; type: "challenge"; from: string; to: string; challengeId: string; project: ProjectDescriptor; protocolVersion: number; settings: MultiplayerJson }
  | { v: 1; type: "challenge-response"; from: string; to: string; challengeId: string; accepted: boolean }
  | { v: 1; type: "game-message"; from: string; to: string; matchId: string; projectId: string; payload: MultiplayerJson }
  | { v: 1; type: "match-end"; from: string; to: string; matchId: string; projectId: string };

export function encodeInvite(invite: LanInvite): string {
  return `ivr-lan://join?data=${encodeURIComponent(JSON.stringify(invite))}`;
}

export function parseInvite(value: string): LanInvite {
  const trimmed = value.trim();
  const prefix = "ivr-lan://join?data=";
  if (!trimmed.startsWith(prefix)) throw new Error("邀请内容不是有效的 Interactive Vault 联机邀请");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(trimmed.slice(prefix.length)));
  } catch {
    throw new Error("联机邀请已损坏");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("联机邀请格式无效");
  const invite = parsed as Partial<LanInvite>;
  if (
    invite.version !== 1 ||
    typeof invite.endpoint !== "string" ||
    !/^http:\/\/[^/]+:\d+$/.test(invite.endpoint) ||
    typeof invite.partyId !== "string" ||
    typeof invite.token !== "string" ||
    invite.token.length < 16
  ) throw new Error("联机邀请格式无效或版本不受支持");
  return invite as LanInvite;
}

export function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function isPartyWireMessage(value: unknown): value is PartyWireMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.v !== MULTIPLAYER_WIRE_VERSION || typeof candidate.type !== "string" || typeof candidate.from !== "string") return false;
  if (candidate.type === "party-state") return Array.isArray(candidate.members) && candidate.members.every(isMember);
  if (candidate.type === "challenge") {
    return typeof candidate.to === "string" && typeof candidate.challengeId === "string"
      && isProjectDescriptor(candidate.project) && Number.isInteger(candidate.protocolVersion) && "settings" in candidate;
  }
  if (candidate.type === "challenge-response") {
    return typeof candidate.to === "string" && typeof candidate.challengeId === "string" && typeof candidate.accepted === "boolean";
  }
  if (candidate.type === "game-message") {
    return typeof candidate.to === "string" && typeof candidate.matchId === "string" && typeof candidate.projectId === "string" && "payload" in candidate;
  }
  if (candidate.type === "match-end") {
    return typeof candidate.to === "string" && typeof candidate.matchId === "string" && typeof candidate.projectId === "string";
  }
  return false;
}

function isMember(value: unknown): value is MultiplayerMember {
  if (!value || typeof value !== "object") return false;
  const member = value as Partial<MultiplayerMember>;
  return typeof member.id === "string" && typeof member.name === "string" && member.name.length <= 40 && typeof member.isHost === "boolean";
}

function isProjectDescriptor(value: unknown): value is ProjectDescriptor {
  if (!value || typeof value !== "object") return false;
  const project = value as Partial<ProjectDescriptor>;
  return typeof project.id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(project.id)
    && typeof project.title === "string" && project.title.length <= 100
    && typeof project.manifestPath === "string" && project.manifestPath.length <= 500;
}
