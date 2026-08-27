import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { SpawnSpec } from "./harness.ts";

type RpcId = number | string;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export type PermissionPrompt = {
  rpcId: RpcId;
  title: string;
  description?: string;
  options: Array<{ optionId: string; name: string; kind?: string }>;
  locations?: Array<{ path?: string }>;
  rawInput?: Record<string, unknown> | null;
  toolKind?: string;
  meta?: unknown;
};

export type AssistantDelta = {
  start?: boolean;
  done?: boolean;
  messageId?: string;
};

export type AcpHandlers = {
  onPermission?: (prompt: PermissionPrompt) => void;
  onAssistant?: (text: string, delta?: AssistantDelta) => void;
  onPromptWritten?: () => void;
  onPromptFlushed?: () => void;
  onStderr?: (line: string) => void;
};

function extractText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(extractText).join("");
  if (typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
    if (c.content !== undefined) return extractText(c.content);
  }
  return "";
}

export function isAuthError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  const code = e?.code;
  const msg = String(e?.message ?? "");
  return code === -32000 || /auth/i.test(msg);
}

export function isCancelled(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  const code = String(e?.code ?? "");
  const msg = String(e?.message ?? err ?? "");
  return /cancel/i.test(code) || /cancel/i.test(msg);
}

/** ACP v1 messageId is optional. Missing nextId keeps glue-by-streaming. A present id starts a bubble when it differs from the open one. */
export function shouldStartBubble(prevId: string | null, nextId: string | undefined): boolean {
  if (nextId == null || nextId === "") return false;
  return prevId !== nextId;
}

function readMessageId(update: Record<string, unknown>): string | undefined {
  const raw = update.messageId ?? update.message_id;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function cancelledError(): Error {
  return Object.assign(new Error("cancelled"), { code: "cancelled" });
}

export class AcpClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<RpcId, Pending>();
  private closed = false;
  private sessionId: string | null = null;
  private turnText = "";
  private messageText = "";
  private streaming = false;
  private openMessageId: string | null = null;
  private idleResolvers: Array<() => void> = [];
  private gotIdle = false;
  private generation = 0;
  private activeGen = 0;
  private promptId: RpcId | null = null;
  private activeHandlers: AcpHandlers | null = null;
  private promptDrain: Promise<void> | null = null;
  private abortPrompt: (() => void) | null = null;
  private pendingPermissions = new Map<RpcId, number>();
  readonly spec: SpawnSpec;

  constructor(
    spec: SpawnSpec,
    private cwd: string,
    private handlers: AcpHandlers = {},
  ) {
    this.spec = spec;
    this.child = spawn(spec.command, spec.args, {
      cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const out = readline.createInterface({ input: this.child.stdout });
    out.on("line", (line) => this.onLine(line));
    const err = readline.createInterface({ input: this.child.stderr });
    err.on("line", (line) => this.handlers.onStderr?.(line));
    this.child.on("exit", () => {
      this.failAll(new Error("ACP child exited"));
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  private send(obj: unknown): void {
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    for (const resolve of this.idleResolvers) resolve();
    this.idleResolvers = [];
  }

  private waitIdle(): Promise<void> {
    if (this.gotIdle) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  private cancelPermission(rpcId: RpcId): void {
    this.pendingPermissions.delete(rpcId);
    this.send({
      jsonrpc: "2.0",
      id: rpcId,
      result: { outcome: { outcome: "cancelled" } },
    });
  }

  private finishStreamingMessage(): void {
    if (!this.streaming) return;
    this.streaming = false;
    const text = this.messageText;
    if (text) {
      (this.activeHandlers ?? this.handlers).onAssistant?.(text, {
        done: true,
        ...(this.openMessageId ? { messageId: this.openMessageId } : {}),
      });
    }
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id as RpcId);
      if (!p) return;
      this.pending.delete(msg.id as RpcId);
      if (msg.error) {
        const errObj = msg.error as { message?: string; code?: number };
        const err = Object.assign(new Error(errObj.message ?? "ACP error"), {
          code: errObj.code,
        });
        p.reject(err);
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === "session/request_permission") {
      if (msg.id === undefined) return;
      const rpcId = msg.id as RpcId;
      if (this.activeGen !== this.generation) {
        this.cancelPermission(rpcId);
        return;
      }
      const params = (msg.params ?? {}) as {
        title?: string;
        toolCall?: {
          title?: string;
          kind?: string;
          locations?: Array<{ path?: string }>;
          rawInput?: Record<string, unknown>;
        };
        description?: string;
        options?: Array<{ optionId: string; name: string; kind?: string }>;
        _meta?: unknown;
      };
      const handler = (this.activeHandlers ?? this.handlers).onPermission;
      this.pendingPermissions.set(rpcId, this.activeGen);
      if (!handler) {
        this.cancelPermission(rpcId);
        return;
      }
      handler({
        rpcId,
        title: params.title ?? params.toolCall?.title ?? "Allow this tool?",
        description: params.description ?? params.toolCall?.title,
        options: Array.isArray(params.options) ? params.options : [],
        locations: params.toolCall?.locations,
        rawInput: params.toolCall?.rawInput ?? null,
        toolKind: params.toolCall?.kind,
        meta: params._meta,
      });
      return;
    }
    if (msg.method === "session/update") {
      const params = msg.params as { update?: Record<string, unknown> } | undefined;
      this.handleUpdate(params?.update ?? (params as { sessionUpdate?: unknown } | undefined));
      return;
    }
    if (typeof msg.method === "string" && msg.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: "Method not found" },
      });
    }
  }

  private handleUpdate(update: Record<string, unknown> | undefined): void {
    if (!update) return;
    if (this.activeGen !== this.generation) return;
    const kind = String(update.sessionUpdate ?? update.session_update ?? "");
    if (kind === "agent_message_chunk") {
      const piece = extractText(update.content);
      if (!piece) return;
      const messageId = readMessageId(update);
      const start = messageId !== undefined ? shouldStartBubble(this.openMessageId, messageId) : !this.streaming;
      if (start) {
        this.messageText = "";
        if (messageId === undefined) this.openMessageId = null;
      }
      if (messageId !== undefined) this.openMessageId = messageId;
      this.streaming = true;
      this.messageText += piece;
      this.turnText += piece;
      (this.activeHandlers ?? this.handlers).onAssistant?.(
        this.messageText,
        messageId !== undefined
          ? { ...(start ? { start: true } : {}), messageId }
          : start
            ? { start: true }
            : undefined,
      );
      return;
    }
    if (kind === "agent_message") {
      const piece = extractText(update.content);
      if (!piece) return;
      this.streaming = false;
      this.messageText = piece;
      this.turnText += piece;
      const messageId = readMessageId(update);
      this.openMessageId = messageId ?? null;
      (this.activeHandlers ?? this.handlers).onAssistant?.(piece, {
        start: true,
        done: true,
        ...(messageId !== undefined ? { messageId } : {}),
      });
      return;
    }
    if (kind === "tool_call" || kind === "agent_thought_chunk") {
      this.finishStreamingMessage();
      return;
    }
    if (kind === "state_update") {
      if (update.state === "idle") {
        this.finishStreamingMessage();
        this.gotIdle = true;
        for (const resolve of this.idleResolvers) resolve();
        this.idleResolvers = [];
      }
    }
  }

  async initialize(): Promise<{ authMethods: unknown[] }> {
    const result = (await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: "openbot", title: "OpenBot", version: "0.0.0" },
      info: { name: "openbot", title: "OpenBot", version: "0.0.0" },
      capabilities: {},
    })) as { authMethods?: unknown[] };
    return { authMethods: Array.isArray(result?.authMethods) ? result.authMethods : [] };
  }

  async newSession(cwd: string): Promise<string> {
    const result = (await this.request("session/new", {
      cwd,
      mcpServers: [],
    })) as { sessionId?: string; session_id?: string };
    const id = result?.sessionId ?? result?.session_id;
    if (typeof id !== "string" || !id) {
      throw new Error("session/new did not return a sessionId");
    }
    this.sessionId = id;
    return id;
  }

  async loadSession(sessionId: string): Promise<string> {
    return this.attachSession("session/load", sessionId);
  }

  async resumeSession(sessionId: string): Promise<string> {
    return this.attachSession("session/resume", sessionId);
  }

  private async attachSession(method: "session/load" | "session/resume", sessionId: string): Promise<string> {
    this.generation += 1;
    this.streaming = false;
    this.turnText = "";
    this.messageText = "";
    this.openMessageId = null;
    const result = (await this.request(method, {
      sessionId,
      cwd: this.cwd,
      mcpServers: [],
    })) as { sessionId?: string; session_id?: string } | null | undefined;
    const id = result?.sessionId ?? result?.session_id ?? sessionId;
    if (typeof id !== "string" || !id) {
      throw new Error(`${method} did not return a sessionId`);
    }
    this.sessionId = id;
    return id;
  }

  async prompt(text: string, handlers?: AcpHandlers): Promise<string> {
    if (!this.sessionId) throw new Error("no ACP session");
    const myGen = ++this.generation;
    const priorDrain = this.promptDrain;
    if (priorDrain) await priorDrain;
    if (myGen !== this.generation) throw cancelledError();
    this.activeGen = myGen;
    const promptHandlers = handlers ?? this.handlers;
    this.activeHandlers = promptHandlers;
    this.turnText = "";
    this.messageText = "";
    this.streaming = false;
    this.openMessageId = null;
    this.gotIdle = false;
    const id = this.nextId++;
    this.promptId = id;
    const rpc = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    const drain = rpc.then(() => undefined, () => undefined);
    this.promptDrain = drain;
    void drain.then(() => {
      if (this.promptDrain === drain) this.promptDrain = null;
    });
    let abortPrompt!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortPrompt = () => reject(cancelledError());
    });
    this.abortPrompt = abortPrompt;
    const payload = `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      },
    })}\n`;
    const stdin = this.child.stdin;
    if (!stdin) throw new Error("ACP stdin closed");
    const flushed = new Promise<void>((resolve, reject) => {
      stdin.write(payload, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    promptHandlers.onPromptWritten?.();
    await flushed;
    if (myGen !== this.generation) {
      throw cancelledError();
    }
    promptHandlers.onPromptFlushed?.();
    try {
      const result = (await Promise.race([rpc, aborted])) as { stopReason?: string } | undefined;
      if (!this.gotIdle && !(result && result.stopReason)) {
        await this.waitIdle();
      }
      this.finishStreamingMessage();
      return this.turnText;
    } finally {
      if (this.promptId === id) this.promptId = null;
      if (this.abortPrompt === abortPrompt) this.abortPrompt = null;
      if (this.activeGen === myGen) this.activeHandlers = null;
    }
  }

  cancel(): void {
    this.generation += 1;
    this.streaming = false;
    this.messageText = "";
    this.turnText = "";
    this.openMessageId = null;
    this.activeHandlers = null;
    const abort = this.abortPrompt;
    this.abortPrompt = null;
    abort?.();
    this.gotIdle = true;
    for (const resolve of this.idleResolvers) resolve();
    this.idleResolvers = [];
    if (this.promptId !== null) {
      this.promptId = null;
    }
    for (const [rpcId, permissionGen] of this.pendingPermissions) {
      if (permissionGen === this.activeGen) this.cancelPermission(rpcId);
    }
    if (this.sessionId) {
      this.send({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: this.sessionId },
      });
    }
  }

  respondPermission(rpcId: RpcId, optionId: string): void {
    this.pendingPermissions.delete(rpcId);
    this.send({
      jsonrpc: "2.0",
      id: rpcId,
      result: { outcome: { outcome: "selected", optionId } },
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("ACP client closed"));
    try {
      this.child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

export function spawnAcp(spec: SpawnSpec, cwd: string, handlers?: AcpHandlers): AcpClient {
  if (spec.command === "docker" || spec.args.includes("exec")) {
    throw new Error("ACP child must be a host process, not docker exec");
  }
  return new AcpClient(spec, cwd, handlers);
}
