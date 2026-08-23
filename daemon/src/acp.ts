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

export type AcpHandlers = {
  onPermission?: (prompt: PermissionPrompt) => void;
  onAssistant?: (text: string) => void;
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

export class AcpClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<RpcId, Pending>();
  private closed = false;
  private paused = false;
  private sessionId: string | null = null;
  private turnText = "";
  private idleResolvers: Array<() => void> = [];
  private gotIdle = false;
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
    err.on("line", (line) => {
      console.error(`[acp] ${line}`);
      this.handlers.onStderr?.(line);
    });
    this.child.on("exit", () => {
      this.failAll(new Error("ACP child exited"));
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get hasSession(): boolean {
    return this.sessionId !== null;
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
    const kind = String(update.sessionUpdate ?? update.session_update ?? "");
    if (kind === "agent_message_chunk") {
      this.turnText += extractText(update.content);
      this.handlers.onAssistant?.(this.turnText);
      return;
    }
    if (kind === "agent_message") {
      const piece = extractText(update.content);
      if (piece) {
        this.turnText = piece;
        this.handlers.onAssistant?.(this.turnText);
      }
      return;
    }
    if (kind === "state_update") {
      if (update.state === "idle") {
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

  async authenticate(methodId: string): Promise<void> {
    await this.request("authenticate", { methodId });
  }

  async prompt(text: string): Promise<string> {
    if (!this.sessionId) throw new Error("no ACP session");
    this.turnText = "";
    this.gotIdle = false;
    const rpc = this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });
    const result = (await rpc) as { stopReason?: string } | undefined;
    if (!this.gotIdle && !(result && result.stopReason)) {
      await this.waitIdle();
    }
    return this.turnText;
  }

  respondPermission(rpcId: RpcId, optionId: string): void {
    this.send({
      jsonrpc: "2.0",
      id: rpcId,
      result: { outcome: { outcome: "selected", optionId } },
    });
  }

  pause(): void {
    if (this.closed || this.paused) return;
    const pid = this.child.pid;
    if (!pid) return;
    try {
      process.kill(pid, "SIGSTOP");
      this.paused = true;
    } catch {
      /* ignore */
    }
  }

  resume(): void {
    if (this.closed || !this.paused) return;
    const pid = this.child.pid;
    if (!pid) return;
    try {
      process.kill(pid, "SIGCONT");
      this.paused = false;
    } catch {
      /* ignore */
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("ACP client closed"));
    if (this.paused) {
      this.paused = false;
      const pid = this.child.pid;
      if (pid) {
        try {
          process.kill(pid, "SIGCONT");
        } catch {
          /* ignore */
        }
      }
    }
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
