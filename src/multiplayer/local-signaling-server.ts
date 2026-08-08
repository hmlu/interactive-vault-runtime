import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { MultiplayerJoinRequest } from "../runtime/types";
import { MAX_SIGNAL_BODY_BYTES, type SignalMessage, randomId } from "./protocol";

interface JoinSession {
  id: string;
  secret: string;
  name: string;
  requestedAt: number;
  queue: SignalMessage[];
  closed: boolean;
}

interface ServerCallbacks {
  onJoin(request: MultiplayerJoinRequest): void;
  onSignal(peerId: string, message: SignalMessage): void;
  onLeave(peerId: string): void;
}

interface JoinBody {
  partyId?: unknown;
  token?: unknown;
  name?: unknown;
}

interface SignalBody {
  peerId?: unknown;
  secret?: unknown;
  message?: unknown;
}

export class LocalSignalingServer {
  private server: Server | null = null;
  private sessions = new Map<string, JoinSession>();

  constructor(
    private readonly partyId: string,
    private readonly inviteToken: string,
    private readonly callbacks: ServerCallbacks,
  ) {}

  async start(): Promise<number> {
    if (this.server) throw new Error("局域网接入端点已经启动");
    const http = require("node:http") as typeof import("node:http");
    this.server = http.createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        console.error("[InteractiveVaultRuntime] 局域网信令请求失败", error);
        if (!response.headersSent) this.sendJson(response, 500, { error: "局域网接入端点发生错误" });
        else response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "0.0.0.0");
    });
    return (this.server.address() as AddressInfo).port;
  }

  queue(peerId: string, message: SignalMessage): void {
    const session = this.sessions.get(peerId);
    if (!session || session.closed) return;
    session.queue.push(message);
  }

  reject(peerId: string, reason: string): void {
    this.queue(peerId, { type: "rejected", reason });
    const session = this.sessions.get(peerId);
    if (session) session.closed = true;
  }

  getName(peerId: string): string | undefined {
    return this.sessions.get(peerId)?.name;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.sessions.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.setCors(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/join") {
      const body = await this.readJson<JoinBody>(request);
      if (body.partyId !== this.partyId || body.token !== this.inviteToken) {
        this.sendJson(response, 403, { error: "邀请已失效或无权加入" });
        return;
      }
      const name = normalizeName(body.name);
      const id = randomId("peer");
      const secret = randomId("session");
      const session: JoinSession = { id, secret, name, requestedAt: Date.now(), queue: [], closed: false };
      this.sessions.set(id, session);
      this.callbacks.onJoin({ id, name, requestedAt: session.requestedAt });
      this.sendJson(response, 200, { peerId: id, secret });
      return;
    }
    if (request.method === "GET" && url.pathname === "/poll") {
      const session = this.authorize(url.searchParams.get("peerId"), url.searchParams.get("secret"));
      if (!session) {
        this.sendJson(response, 403, { error: "联机会话无效" });
        return;
      }
      const messages = session.queue.splice(0, session.queue.length);
      this.sendJson(response, 200, { messages });
      if (session.closed && messages.length === 0) this.sessions.delete(session.id);
      return;
    }
    if (request.method === "POST" && url.pathname === "/signal") {
      const body = await this.readJson<SignalBody>(request);
      const session = this.authorize(body.peerId, body.secret);
      if (!session || !isSignalMessage(body.message)) {
        this.sendJson(response, 403, { error: "信令消息无效" });
        return;
      }
      this.callbacks.onSignal(session.id, body.message);
      this.sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/leave") {
      const body = await this.readJson<SignalBody>(request);
      const session = this.authorize(body.peerId, body.secret);
      if (session) {
        this.sessions.delete(session.id);
        this.callbacks.onLeave(session.id);
      }
      this.sendJson(response, 200, { ok: true });
      return;
    }
    this.sendJson(response, 404, { error: "未找到局域网信令接口" });
  }

  private authorize(peerId: unknown, secret: unknown): JoinSession | null {
    if (typeof peerId !== "string" || typeof secret !== "string") return null;
    const session = this.sessions.get(peerId);
    return session?.secret === secret ? session : null;
  }

  private readJson<T>(request: IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_SIGNAL_BODY_BYTES) {
          reject(new Error("信令请求过大"));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
        } catch {
          reject(new Error("信令请求不是有效 JSON"));
        }
      });
      request.on("error", reject);
    });
  }

  private setCors(response: ServerResponse): void {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.setHeader("Cache-Control", "no-store");
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value);
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    response.end(body);
  }
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") return "附近设备";
  const trimmed = value.trim().slice(0, 40);
  return trimmed || "附近设备";
}

function isSignalMessage(value: unknown): value is SignalMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<SignalMessage>;
  if (message.type === "answer" || message.type === "offer") return typeof message.sdp === "string" && message.sdp.length <= MAX_SIGNAL_BODY_BYTES;
  return message.type === "rejected" && typeof message.reason === "string";
}
