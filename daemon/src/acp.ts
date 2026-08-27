import crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  COMPUTER_HELP_COMPLETE_FIELD,
  COMPUTER_HELP_COMPLETE_VALUE,
  computerHelpMcpServer,
  parseComputerHelpElicitation,
  type ComputerHelpMcpServer,
} from "./computer-help.ts";
import type { SpawnSpec } from "./harness.ts";

type RpcId = number | string;
const TERMINAL_ELICITATION_LIMIT = 128;

type ComputerHelpGenerationState = {
  directory: string;
  file: string;
};

function randomComputerHelpToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function createComputerHelpGenerationState(): ComputerHelpGenerationState {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-computer-help-"));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, "generation");
  fs.writeFileSync(file, randomComputerHelpToken(), { mode: 0o600 });
  return { directory, file };
}

export type PermissionOption = { optionId: string; name: string; kind?: string };

export type PermissionOptionIdentity = Pick<PermissionOption, "optionId" | "kind">;

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export function validatedPermissionOptions(value: unknown): PermissionOption[] {
  if (!Array.isArray(value)) return [];
  const optionIds = new Set<string>();
  const options: PermissionOption[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const option = entry as Record<string, unknown>;
    if (
      typeof option.optionId !== "string"
      || option.optionId.trim().length === 0
      || typeof option.name !== "string"
      || (option.kind !== undefined && typeof option.kind !== "string")
      || optionIds.has(option.optionId)
    ) {
      return [];
    }
    optionIds.add(option.optionId);
    options.push({
      optionId: option.optionId,
      name: option.name,
      ...(typeof option.kind === "string" ? { kind: option.kind } : {}),
    });
  }
  return options;
}

export function permissionOptionKind(option: PermissionOptionIdentity): PermissionOptionKind | null {
  if (option.kind !== undefined) {
    return option.kind === "allow_once"
      || option.kind === "allow_always"
      || option.kind === "reject_once"
      || option.kind === "reject_always"
      ? option.kind
      : null;
  }
  if (option.optionId === "allow-once" || option.optionId === "once") return "allow_once";
  if (option.optionId === "allow-always" || option.optionId === "always") return "allow_always";
  if (["reject-once", "reject", "deny"].includes(option.optionId)) return "reject_once";
  if (["reject-always", "deny-always"].includes(option.optionId)) return "reject_always";
  return null;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export type PermissionPrompt = {
  rpcId: RpcId;
  title: string;
  description?: string;
  options: PermissionOption[];
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

export type ComputerHelpPrompt = {
  rpcId: RpcId;
  instruction: string;
};

export type ComputerHelpResolution = "done" | "skip" | "cancel";

export type AcpHandlers = {
  onPermission?: (prompt: PermissionPrompt) => void;
  onComputerHelp?: (prompt: ComputerHelpPrompt) => void;
  onComputerHelpCancelled?: (prompt: ComputerHelpPrompt) => void;
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

export function computerHelpResponseWasFlushed(err: unknown): boolean {
  return (err as { responseFlushed?: unknown })?.responseFlushed === true;
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
  private transportError: Error | null = null;
  private sessionId: string | null = null;
  private turnText = "";
  private messageText = "";
  private streaming = false;
  private openMessageId: string | null = null;
  private nonTextBoundary = false;
  private idleResolvers: Array<() => void> = [];
  private gotIdle = false;
  private generation = 0;
  private activeGen = 0;
  private promptId: RpcId | null = null;
  private activeHandlers: AcpHandlers | null = null;
  private promptDrain: Promise<void> | null = null;
  private abortPrompt: (() => void) | null = null;
  private pendingPermissions = new Map<RpcId, number>();
  private pendingComputerHelp = new Map<RpcId, {
    generation: number;
    prompt: ComputerHelpPrompt;
    handlers: AcpHandlers;
    responding: boolean;
  }>();
  private terminalElicitations = new Set<RpcId>();
  private terminalElicitationLimitReached = false;
  private elicitationOverflowClosing = false;
  private readonly computerHelpGenerationState = createComputerHelpGenerationState();
  private activeComputerHelpGeneration: { token: string; generation: number } | null = null;
  private computerHelpGenerationStateClosed = false;
  private readonly computerHelpIdentity = crypto.randomBytes(32).toString("base64url");
  private readonly mcpServers: ComputerHelpMcpServer[];
  readonly spec: SpawnSpec;

  constructor(
    spec: SpawnSpec,
    private cwd: string,
    private handlers: AcpHandlers = {},
  ) {
    this.spec = spec;
    this.mcpServers = [computerHelpMcpServer(
      this.computerHelpIdentity,
      this.computerHelpGenerationState.file,
    )];
    const childEnv = { ...spec.env };
    delete childEnv.APP_SERVER_LOGS;
    this.child = spawn(spec.command, spec.args, {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const out = readline.createInterface({ input: this.child.stdout });
    out.on("line", (line) => this.onLine(line));
    const err = readline.createInterface({ input: this.child.stderr });
    err.on("line", (line) => this.handlers.onStderr?.(line));
    this.child.stdin.on("error", (writeError) => {
      this.transportError = writeError;
      this.failAll(writeError);
    });
    this.child.on("error", (err) => {
      this.transportError = err;
      this.failAll(err);
      this.closeComputerHelpGenerationState();
    });
    this.child.on("exit", () => {
      const err = new Error("ACP child exited");
      this.transportError = err;
      this.failAll(err);
      this.closeComputerHelpGenerationState();
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  private send(obj: unknown): void {
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  private sendConfirmed(obj: unknown, onFlushed?: () => void): Promise<void> {
    if (this.transportError) return Promise.reject(this.transportError);
    if (this.closed || this.child.stdin.destroyed) {
      return Promise.reject(new Error("ACP transport is closed"));
    }
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(obj)}\n`, (err) => {
        if (err) reject(err);
        else {
          try {
            onFlushed?.();
            resolve();
          } catch (flushError) {
            const error = flushError instanceof Error
              ? flushError
              : new Error(String(flushError));
            reject(Object.assign(error, { responseFlushed: true }));
          }
        }
      });
    });
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
    this.cancelComputerHelpWhere(() => true, false);
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

  private cancelComputerHelpWhere(
    predicate: (pending: { generation: number }) => boolean,
    respond: boolean,
  ): void {
    for (const [rpcId, pending] of this.pendingComputerHelp) {
      if (!predicate(pending)) continue;
      this.pendingComputerHelp.delete(rpcId);
      this.rememberTerminalElicitation(rpcId);
      if (respond && !this.transportError && !this.closed && !this.child.stdin.destroyed) {
        this.send({ jsonrpc: "2.0", id: rpcId, result: { action: "cancel" } });
      }
      pending.handlers.onComputerHelpCancelled?.(pending.prompt);
    }
  }

  private resetElicitationLifecycle(): void {
    this.terminalElicitations.clear();
    this.terminalElicitationLimitReached = false;
    this.elicitationOverflowClosing = false;
  }

  private rotateComputerHelpGeneration(): string {
    const token = randomComputerHelpToken();
    fs.writeFileSync(this.computerHelpGenerationState.file, token, { mode: 0o600 });
    return token;
  }

  private invalidateComputerHelpGeneration(generation?: number): void {
    if (
      generation !== undefined
      && this.activeComputerHelpGeneration?.generation !== generation
    ) {
      return;
    }
    this.activeComputerHelpGeneration = null;
    if (this.computerHelpGenerationStateClosed) return;
    try {
      this.rotateComputerHelpGeneration();
    } catch {
      // A later prompt will fail closed when it cannot publish its generation.
    }
  }

  private closeComputerHelpGenerationState(): void {
    if (this.computerHelpGenerationStateClosed) return;
    this.computerHelpGenerationStateClosed = true;
    this.activeComputerHelpGeneration = null;
    try {
      fs.unlinkSync(this.computerHelpGenerationState.file);
    } catch {
      // The private file may already be gone after an external cleanup.
    }
    try {
      fs.rmdirSync(this.computerHelpGenerationState.directory);
    } catch {
      // Never widen cleanup beyond the exact private directory.
    }
  }

  private rememberTerminalElicitation(rpcId: RpcId): void {
    if (this.terminalElicitations.size >= TERMINAL_ELICITATION_LIMIT) {
      this.terminalElicitationLimitReached = true;
      return;
    }
    this.terminalElicitations.add(rpcId);
  }

  private rejectElicitation(rpcId: RpcId): void {
    this.rememberTerminalElicitation(rpcId);
    const response = { jsonrpc: "2.0", id: rpcId, result: { action: "cancel" } };
    if (!this.terminalElicitationLimitReached) {
      this.send(response);
      return;
    }
    if (this.elicitationOverflowClosing) return;
    this.elicitationOverflowClosing = true;
    void this.sendConfirmed(response).then(
      () => this.close(),
      () => this.close(),
    );
  }

  private finishStreamingMessage(): void {
    if (!this.streaming) return;
    this.streaming = false;
    const text = this.messageText;
    if (text) {
      this.turnText += text;
      (this.activeHandlers ?? this.handlers).onAssistant?.(text, {
        done: true,
        ...(this.openMessageId ? { messageId: this.openMessageId } : {}),
      });
    }
    this.nonTextBoundary = false;
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
        options?: unknown;
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
        options: validatedPermissionOptions(params.options),
        locations: params.toolCall?.locations,
        rawInput: params.toolCall?.rawInput ?? null,
        toolKind: params.toolCall?.kind,
        meta: params._meta,
      });
      return;
    }
    if (msg.method === "elicitation/create") {
      if (msg.id === undefined) return;
      const rpcId = msg.id as RpcId;
      if (this.terminalElicitations.has(rpcId) || this.pendingComputerHelp.has(rpcId)) return;
      if (
        this.terminalElicitationLimitReached
        || this.terminalElicitations.size >= TERMINAL_ELICITATION_LIMIT
      ) {
        this.rejectElicitation(rpcId);
        return;
      }
      const activeGeneration = this.activeComputerHelpGeneration;
      if (
        this.activeGen !== this.generation
        || this.promptId === null
        || !this.sessionId
        || !activeGeneration
        || activeGeneration.generation !== this.activeGen
      ) {
        this.rejectElicitation(rpcId);
        return;
      }
      const prompt = parseComputerHelpElicitation(
        msg.params,
        this.computerHelpIdentity,
        activeGeneration.token,
        this.sessionId,
      );
      const handlers = this.activeHandlers ?? this.handlers;
      if (!prompt || !handlers.onComputerHelp || this.pendingComputerHelp.size > 0) {
        this.rejectElicitation(rpcId);
        return;
      }
      const computerHelp = { rpcId, instruction: prompt.instruction };
      this.pendingComputerHelp.set(rpcId, {
        generation: this.activeGen,
        prompt: computerHelp,
        handlers,
        responding: false,
      });
      handlers.onComputerHelp(computerHelp);
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
      const startsIdentifiedMessage = messageId !== undefined
        && shouldStartBubble(this.openMessageId, messageId);
      const startsAnonymousMessage = messageId === undefined
        && this.streaming
        && this.nonTextBoundary;
      if (this.streaming && (startsIdentifiedMessage || startsAnonymousMessage)) {
        this.finishStreamingMessage();
      }
      const start = !this.streaming;
      if (start) {
        this.messageText = "";
        this.openMessageId = messageId ?? null;
      }
      if (messageId !== undefined) this.openMessageId = messageId;
      this.streaming = true;
      this.nonTextBoundary = false;
      this.messageText += piece;
      return;
    }
    if (kind === "agent_message") {
      const piece = extractText(update.content);
      if (!piece) return;
      const messageId = readMessageId(update);
      const completesOpenStream = this.streaming && (
        messageId !== undefined
          ? this.openMessageId === messageId
          : this.openMessageId === null && !this.nonTextBoundary
      );
      if (this.streaming && !completesOpenStream) this.finishStreamingMessage();
      this.streaming = false;
      this.nonTextBoundary = false;
      this.messageText = piece;
      this.turnText += piece;
      this.openMessageId = messageId ?? null;
      (this.activeHandlers ?? this.handlers).onAssistant?.(piece, {
        start: true,
        done: true,
        ...(messageId !== undefined ? { messageId } : {}),
      });
      return;
    }
    if (kind === "tool_call" || kind === "agent_thought_chunk") {
      if (this.streaming) this.nonTextBoundary = true;
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
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        elicitation: { form: {} },
      },
      clientInfo: { name: "openbot", title: "OpenBot", version: "0.0.0" },
      info: { name: "openbot", title: "OpenBot", version: "0.0.0" },
      capabilities: {},
    })) as { authMethods?: unknown[] };
    return { authMethods: Array.isArray(result?.authMethods) ? result.authMethods : [] };
  }

  async newSession(cwd: string): Promise<string> {
    const result = (await this.request("session/new", {
      cwd,
      mcpServers: this.mcpServers,
    })) as { sessionId?: string; session_id?: string };
    const id = result?.sessionId ?? result?.session_id;
    if (typeof id !== "string" || !id) {
      throw new Error("session/new did not return a sessionId");
    }
    this.sessionId = id;
    this.resetElicitationLifecycle();
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
    this.nonTextBoundary = false;
    const result = (await this.request(method, {
      sessionId,
      cwd: this.cwd,
      mcpServers: this.mcpServers,
    })) as { sessionId?: string; session_id?: string } | null | undefined;
    const id = result?.sessionId ?? result?.session_id ?? sessionId;
    if (typeof id !== "string" || !id) {
      throw new Error(`${method} did not return a sessionId`);
    }
    this.sessionId = id;
    this.resetElicitationLifecycle();
    return id;
  }

  async prompt(text: string, handlers?: AcpHandlers): Promise<string> {
    if (!this.sessionId) throw new Error("no ACP session");
    const myGen = ++this.generation;
    const priorDrain = this.promptDrain;
    if (priorDrain) await priorDrain;
    if (myGen !== this.generation) throw cancelledError();
    this.activeGen = myGen;
    this.resetElicitationLifecycle();
    this.activeComputerHelpGeneration = {
      token: this.rotateComputerHelpGeneration(),
      generation: myGen,
    };
    const promptHandlers = handlers ?? this.handlers;
    this.activeHandlers = promptHandlers;
    this.turnText = "";
    this.messageText = "";
    this.streaming = false;
    this.openMessageId = null;
    this.nonTextBoundary = false;
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
      this.cancelComputerHelpWhere((pending) => pending.generation === myGen, true);
      this.invalidateComputerHelpGeneration(myGen);
      if (this.promptId === id) this.promptId = null;
      if (this.abortPrompt === abortPrompt) this.abortPrompt = null;
      if (this.activeGen === myGen) this.activeHandlers = null;
    }
  }

  cancel(): void {
    const cancelledGeneration = this.activeGen;
    this.generation += 1;
    this.streaming = false;
    this.messageText = "";
    this.turnText = "";
    this.openMessageId = null;
    this.nonTextBoundary = false;
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
    this.cancelComputerHelpWhere((pending) => pending.generation === cancelledGeneration, true);
    this.invalidateComputerHelpGeneration(cancelledGeneration);
    if (this.sessionId) {
      this.send({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: this.sessionId },
      });
    }
  }

  async respondPermission(rpcId: RpcId, optionId: string): Promise<void> {
    await this.sendConfirmed({
      jsonrpc: "2.0",
      id: rpcId,
      result: { outcome: { outcome: "selected", optionId } },
    });
    this.pendingPermissions.delete(rpcId);
  }

  async respondComputerHelp(
    rpcId: RpcId,
    resolution: ComputerHelpResolution,
    onFlushed?: () => void,
  ): Promise<void> {
    const pending = this.pendingComputerHelp.get(rpcId);
    if (
      !pending
      || pending.generation !== this.activeGen
      || pending.responding
      || this.terminalElicitations.has(rpcId)
    ) {
      throw Object.assign(new Error("Computer-help request is no longer active"), { status: 409 });
    }
    pending.responding = true;
    const response = resolution === "done"
      ? {
          action: "accept",
          content: { [COMPUTER_HELP_COMPLETE_FIELD]: COMPUTER_HELP_COMPLETE_VALUE },
        }
      : resolution === "skip"
        ? { action: "decline" }
        : { action: "cancel" };
    try {
      await this.sendConfirmed({ jsonrpc: "2.0", id: rpcId, result: response }, () => {
        this.pendingComputerHelp.delete(rpcId);
        this.rememberTerminalElicitation(rpcId);
        onFlushed?.();
      });
    } catch (err) {
      const current = this.pendingComputerHelp.get(rpcId);
      if (current === pending) current.responding = false;
      throw err;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelComputerHelpWhere(() => true, false);
    this.closeComputerHelpGenerationState();
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
