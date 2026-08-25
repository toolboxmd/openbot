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
};

export type AssistantDelta = {
  start?: boolean;
  done?: boolean;
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
      const params = (msg.params ?? {}) as {
        title?: string;
        toolCall?: { title?: string; kind?: string };
        description?: string;
        options?: Array<{ optionId: string; name: string; kind?: string }>;
      };
      this.handlers.onPermission?.({
        rpcId: msg.id as RpcId,
        title: params.title ?? params.toolCall?.title ?? "Allow this tool?",
        description: params.description,
        options: Array.isArray(params.options) ? params.options : [],
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
      if (start) this.messageText = "";
      if (messageId !== undefined) this.openMessageId = messageId;
      this.streaming = true;
      this.messageText += piece;
      this.turnText += piece;
      this.handlers.onAssistant?.(this.messageText, start ? { start: true } : undefined);
      return;
    }
    if (kind === "agent_message") {
      const piece = extractText(update.content);
      if (!piece) return;
      this.streaming = false;
      this.messageText = piece;
      this.turnText += piece;
      const messageId = readMessageId(update);
      if (messageId !== undefined) this.openMessageId = messageId;
      this.handlers.onAssistant?.(piece, { start: true, done: true });
      return;
    }
    if (kind === "tool_call" || kind === "agent_thought_chunk") {
      this.streaming = false;
      return;
    }
    if (kind === "state_update") {
      if (update.state === "idle") {
        this.gotIdle = true;
        this.streaming = false;
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

  async prompt(text: string): Promise<string> {
    if (!this.sessionId) throw new Error("no ACP session");
    this.activeGen = ++this.generation;
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
    const myGen = this.activeGen;
    this.handlers.onPromptWritten?.();
    await flushed;
    if (myGen !== this.generation) {
      throw cancelledError();
    }
    this.handlers.onPromptFlushed?.();
    try {
      const result = (await rpc) as { stopReason?: string } | undefined;
      if (!this.gotIdle && !(result && result.stopReason)) {
        await this.waitIdle();
      }
      this.streaming = false;
      return this.turnText;
    } finally {
      if (this.promptId === id) this.promptId = null;
    }
  }

  cancel(): void {
    this.generation += 1;
    this.streaming = false;
    this.messageText = "";
    this.turnText = "";
    this.openMessageId = null;
    this.gotIdle = true;
    for (const resolve of this.idleResolvers) resolve();
    this.idleResolvers = [];
    if (this.promptId !== null) {
      const pending = this.pending.get(this.promptId);
      if (pending) {
        this.pending.delete(this.promptId);
        pending.reject(cancelledError());
      }
      this.promptId = null;
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
