import type { MultiplayerJson, MultiplayerMember } from "../runtime/types";
import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";

export const MULTIPLAYER_WIRE_VERSION = 1;
export const MAX_SIGNAL_BODY_BYTES = 96 * 1024;
export const MAX_GAME_MESSAGE_BYTES = 256 * 1024;

export interface LanInvite {
  version: 1;
  endpoint: string;
  partyId: string;
  token: string;
}

export interface QrOfferInvite {
  version: 2;
  transport: "qr";
  type: "offer";
  partyId: string;
  token: string;
  expiresAt: number;
  host: MultiplayerMember;
  sdp: string;
}

export interface QrAnswerInvite {
  version: 2;
  transport: "qr";
  type: "answer";
  partyId: string;
  token: string;
  expiresAt: number;
  hostId: string;
  guest: MultiplayerMember;
  sdp: string;
}

export type MultiplayerInvite = LanInvite | QrOfferInvite | QrAnswerInvite;

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

export function encodeQrInvite(invite: QrOfferInvite | QrAnswerInvite): string {
  const compressed = deflateSync(strToU8(JSON.stringify(invite)), { level: 9 });
  return `IVRQR:${encodeBase45(compressed)}:`;
}

export function parseInvite(value: string): MultiplayerInvite {
  const trimmed = value.trim();
  const lanPrefix = "ivr-lan://join?data=";
  const compactQrPrefix = "IVRQR:";
  const legacyQrPrefix = "ivr-qr://pair?data=";
  if (trimmed.startsWith(compactQrPrefix) && trimmed.endsWith(":")) {
    return parseQrInvite(decodeQrPayload(trimmed.slice(compactQrPrefix.length, -1), decodeBase45));
  }
  if (trimmed.startsWith(legacyQrPrefix)) {
    return parseQrInvite(decodeQrPayload(trimmed.slice(legacyQrPrefix.length), decodeBase64Url));
  }
  if (!trimmed.startsWith(lanPrefix)) throw new Error("邀请内容不是有效的 Interactive Vault 联机邀请");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(trimmed.slice(lanPrefix.length)));
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

function parseQrInvite(compressed: Uint8Array): QrOfferInvite | QrAnswerInvite {
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(inflateSync(compressed)));
  } catch {
    throw new Error("手机联机二维码已损坏");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("手机联机二维码格式无效");
  const invite = parsed as Record<string, unknown>;
  const validBase = invite.version === 2 && invite.transport === "qr"
    && typeof invite.partyId === "string" && invite.partyId.startsWith("party-")
    && typeof invite.token === "string" && invite.token.length >= 16
    && typeof invite.expiresAt === "number" && Number.isFinite(invite.expiresAt)
    && typeof invite.sdp === "string" && invite.sdp.length > 0 && invite.sdp.length <= MAX_SIGNAL_BODY_BYTES;
  if (!validBase || (invite.expiresAt as number) < Date.now()) throw new Error("手机联机二维码无效或已经过期");
  if (invite.type === "offer" && isMember(invite.host) && invite.host.isHost) return invite as unknown as QrOfferInvite;
  if (invite.type === "answer" && typeof invite.hostId === "string" && isMember(invite.guest) && !invite.guest.isHost) return invite as unknown as QrAnswerInvite;
  throw new Error("手机联机二维码格式无效");
}

function decodeQrPayload(value: string, decode: (encoded: string) => Uint8Array): Uint8Array {
  try {
    return decode(value);
  } catch {
    throw new Error("手机联机二维码已损坏");
  }
}

const BASE45_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

function encodeBase45(value: Uint8Array): string {
  let encoded = "";
  for (let index = 0; index < value.length; index += 2) {
    if (index + 1 < value.length) {
      let pair = value[index]! * 256 + value[index + 1]!;
      const first = pair % 45;
      pair = Math.floor(pair / 45);
      const second = pair % 45;
      const third = Math.floor(pair / 45);
      encoded += BASE45_ALPHABET[first]! + BASE45_ALPHABET[second]! + BASE45_ALPHABET[third]!;
    } else {
      const first = value[index]! % 45;
      const second = Math.floor(value[index]! / 45);
      encoded += BASE45_ALPHABET[first]! + BASE45_ALPHABET[second]!;
    }
  }
  return encoded;
}

function decodeBase45(value: string): Uint8Array {
  if (value.length % 3 === 1) throw new Error("Invalid base45 length");
  const decoded: number[] = [];
  for (let index = 0; index < value.length; index += 3) {
    const remaining = value.length - index;
    const first = BASE45_ALPHABET.indexOf(value[index]!);
    const second = BASE45_ALPHABET.indexOf(value[index + 1]!);
    if (first < 0 || second < 0) throw new Error("Invalid base45 character");
    if (remaining >= 3) {
      const third = BASE45_ALPHABET.indexOf(value[index + 2]!);
      const pair = first + second * 45 + third * 45 * 45;
      if (third < 0 || pair > 0xffff) throw new Error("Invalid base45 value");
      decoded.push(pair >> 8, pair & 0xff);
    } else {
      const byte = first + second * 45;
      if (byte > 0xff) throw new Error("Invalid base45 value");
      decoded.push(byte);
    }
  }
  return Uint8Array.from(decoded);
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = globalThis.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
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
