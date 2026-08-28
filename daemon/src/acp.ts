import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { TextDecoder } from "node:util";
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
const ACP_PROTOCOL_ERROR_MESSAGE = "ACP transport protocol error";
/** ACP is newline-delimited JSON. One input frame may occupy at most 1 MiB before its newline. */
const MAX_ACP_INPUT_LINE_BYTES = 1024 * 1024;
/** ACP content may nest deeply enough for normal structured output without risking parser exhaustion. */
const MAX_ACP_CONTENT_DEPTH = 256;
/** Each startup/attach request, local prompt handoff, and cancelled-prompt drain gets 60 seconds. A flushed, uncancelled Bot Turn has no transport deadline. */
const ACP_START_DEADLINE_MS = 60_000;
/** A failed ACP transport gets one second after TERM before its owned process group is force-killed. */
const ACP_TERMINATE_GRACE_MS = 1_000;

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string"
    || (typeof value === "number" && Number.isSafeInteger(value));
}

function isJsonRpcError(value: unknown): value is { code: number; message: string } {
  if (!isObjectRecord(value)) return false;
  const error = value as Record<string, unknown>;
  return typeof error.code === "number"
    && Number.isSafeInteger(error.code)
    && typeof error.message === "string";
}

function isPromptResponse(value: unknown): value is { stopReason: string } {
  return isObjectRecord(value)
    && typeof value.stopReason === "string"
    && value.stopReason.trim().length > 0;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  const pending: Array<{ left: unknown; right: unknown }> = [{ left, right }];
  while (pending.length > 0) {
    const pair = pending.pop();
    if (!pair) break;
    if (pair.left === pair.right) continue;
    if (
      typeof pair.left !== "object"
      || pair.left === null
      || typeof pair.right !== "object"
      || pair.right === null
    ) {
      return false;
    }
    const leftArray = Array.isArray(pair.left);
    if (leftArray !== Array.isArray(pair.right)) return false;
    if (leftArray) {
      const leftItems = pair.left as unknown[];
      const rightItems = pair.right as unknown[];
      if (leftItems.length !== rightItems.length) return false;
      for (let index = 0; index < leftItems.length; index += 1) {
        pending.push({ left: leftItems[index], right: rightItems[index] });
      }
      continue;
    }
    const leftRecord = pair.left as Record<string, unknown>;
    const rightRecord = pair.right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    if (leftKeys.length !== Object.keys(rightRecord).length) return false;
    for (const key of leftKeys) {
      if (!hasOwn(rightRecord, key)) return false;
      pending.push({ left: leftRecord[key], right: rightRecord[key] });
    }
  }
  return true;
}

function isJsonRpcEnvelope(message: Record<string, unknown>): boolean {
  if (message.jsonrpc !== "2.0") return false;
  const hasMethod = hasOwn(message, "method");
  const hasResult = hasOwn(message, "result");
  const hasError = hasOwn(message, "error");
  const hasId = hasOwn(message, "id");
  if (hasMethod) {
    if (typeof message.method !== "string" || message.method.length === 0) return false;
    if (hasResult || hasError) return false;
    if (hasId && !isRpcId(message.id)) return false;
    if (
      hasOwn(message, "params")
      && (typeof message.params !== "object" || message.params === null)
    ) {
      return false;
    }
    return true;
  }
  if (!hasId || !isRpcId(message.id)) return false;
  if (hasResult === hasError || hasOwn(message, "params")) return false;
  return !hasError || isJsonRpcError(message.error);
}

function hasValidAcpMethodRole(message: Record<string, unknown>): boolean {
  if (
    message.method === "session/request_permission"
    || message.method === "elicitation/create"
  ) {
    return hasOwn(message, "id") && isObjectRecord(message.params);
  }
  if (message.method === "session/update") {
    return !hasOwn(message, "id")
      && isObjectRecord(message.params)
      && typeof message.params.sessionId === "string"
      && isObjectRecord(message.params.update);
  }
  return true;
}

function sanitizedRpcError(value: { code: number; message: string }): Error {
  const message = /cancel/i.test(value.message)
    ? "ACP request cancelled"
    : value.code === -32_000
      ? "ACP authentication failed"
      : "ACP request failed";
  return Object.assign(new Error(message), { code: value.code });
}

function startTimeoutError(): Error {
  return Object.assign(new Error("ACP start timed out"), { code: "ACP_START_TIMEOUT" });
}

function transportFailureError(): Error {
  return new Error("ACP transport closed");
}

type CallbackFailureOptions = {
  discardProcessStderr?: boolean;
  responseFlushed?: boolean;
  transportClosed?: boolean;
};

type AcpHandlerResult = void | Promise<void>;

type CallbackInvocation = {
  active: boolean;
};

type CallbackTask = {
  invoke: (() => AcpHandlerResult) | null;
  invocation: CallbackInvocation;
  options: CallbackFailureOptions;
  resolve: () => void;
  settled: boolean;
};

type CallbackChain = {
  active: boolean;
  running: boolean;
  waiting: number;
  queue: CallbackTask[];
  tail: Promise<void>;
  detached: Promise<void>;
  detach: () => void;
  fail: ((options: CallbackFailureOptions) => void) | null;
};

type CallbackContext = {
  chain: CallbackChain;
  invocation: CallbackInvocation;
};

function callbackTransportError(options: CallbackFailureOptions = {}): Error {
  return Object.assign(new Error("ACP transport callback failed"), {
    code: "ACP_CALLBACK_FAILED",
    ...(options.responseFlushed ? { responseFlushed: true } : {}),
    ...(options.transportClosed ? { transportClosed: true } : {}),
  });
}

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
  settlementQueued?: boolean;
};

type SessionAttachment = {
  requestId: RpcId;
  method: "session/new" | "session/load" | "session/resume";
  sessionId: string | null;
};

type ActiveServerRequest = {
  kind: "permission" | "elicitation";
  generation: number;
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
  onPermission?: (prompt: PermissionPrompt) => AcpHandlerResult;
  onComputerHelp?: (prompt: ComputerHelpPrompt) => AcpHandlerResult;
  onComputerHelpCancelled?: (prompt: ComputerHelpPrompt) => AcpHandlerResult;
  onAssistant?: (text: string, delta?: AssistantDelta) => AcpHandlerResult;
  onPromptWritten?: () => AcpHandlerResult;
  onPromptFlushed?: () => AcpHandlerResult;
  onStderr?: (line: string) => AcpHandlerResult;
};

export type AcpClientOptions = {
  /** Tests may shorten the production 60-second start/drain deadline without changing uncancelled Turn duration. */
  startDeadlineMs?: number;
  /** Tests may shorten the production TERM-to-KILL grace period. */
  terminateGraceMs?: number;
};

function extractText(content: unknown): string | null {
  const pieces: string[] = [];
  const pending: Array<{ value: unknown; depth: number }> = [{ value: content, depth: 0 }];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry) break;
    if (entry.depth > MAX_ACP_CONTENT_DEPTH) return null;
    if (typeof entry.value === "string") {
      pieces.push(entry.value);
      continue;
    }
    if (Array.isArray(entry.value)) {
      for (let index = entry.value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: entry.value[index], depth: entry.depth + 1 });
      }
      continue;
    }
    if (typeof entry.value !== "object" || entry.value === null) continue;
    const record = entry.value as Record<string, unknown>;
    if (typeof record.text === "string") {
      pieces.push(record.text);
    } else if (record.content !== undefined) {
      pending.push({ value: record.content, depth: entry.depth + 1 });
    }
  }
  return pieces.join("");
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

export function acpResponseWasFlushed(err: unknown): boolean {
  return (err as { responseFlushed?: unknown })?.responseFlushed === true;
}

export function computerHelpResponseWasFlushed(err: unknown): boolean {
  return acpResponseWasFlushed(err);
}

export function cancellationClosedTransport(err: unknown): boolean {
  return (err as { transportClosed?: unknown })?.transportClosed === true;
}

export function callbackFailedTransport(err: unknown): boolean {
  return (err as { code?: unknown })?.code === "ACP_CALLBACK_FAILED";
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

function cancelledError(transportClosed = false): Error {
  return Object.assign(new Error("cancelled"), {
    code: "cancelled",
    ...(transportClosed ? { transportClosed: true } : {}),
  });
}

export class AcpClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<RpcId, Pending>();
  private pendingWriteRejectors = new Set<(error: Error) => void>();
  private pendingResponseFlushCallbacks = new Set<symbol>();
  private callbackContext = new AsyncLocalStorage<CallbackContext>();
  private callbackChain: CallbackChain;
  private stdoutBuffer = Buffer.alloc(0);
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
  private promptHandoffPending = false;
  private activeHandlers: AcpHandlers | null = null;
  private promptDrain: Promise<void> | null = null;
  private cancelledPromptDrain: {
    promptId: RpcId;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  private abortPrompt: (() => void) | null = null;
  private sessionAttachment: SessionAttachment | null = null;
  private activeServerRequests = new Map<RpcId, ActiveServerRequest>();
  private pendingPermissions = new Map<RpcId, { generation: number; responding: boolean }>();
  private pendingComputerHelp = new Map<RpcId, {
    generation: number;
    prompt: ComputerHelpPrompt;
    requestParams: Record<string, unknown>;
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
  private readonly startDeadlineMs: number;
  private readonly terminateGraceMs: number;
  private forceKillTimer: NodeJS.Timeout | null = null;
  private childExited = false;
  private readonly ownedProcessGroupId: number | null;
  private processStderrHandler: AcpHandlers["onStderr"];
  readonly spec: SpawnSpec;

  constructor(
    spec: SpawnSpec,
    private cwd: string,
    private handlers: AcpHandlers = {},
    options: AcpClientOptions = {},
  ) {
    this.spec = spec;
    this.callbackChain = this.createCallbackChain();
    this.processStderrHandler = handlers.onStderr;
    this.startDeadlineMs = options.startDeadlineMs ?? ACP_START_DEADLINE_MS;
    this.terminateGraceMs = options.terminateGraceMs ?? ACP_TERMINATE_GRACE_MS;
    if (
      !Number.isFinite(this.startDeadlineMs)
      || this.startDeadlineMs <= 0
      || !Number.isFinite(this.terminateGraceMs)
      || this.terminateGraceMs <= 0
    ) {
      this.closeComputerHelpGenerationState();
      throw new TypeError("ACP transport deadlines must be positive durations");
    }
    this.mcpServers = [computerHelpMcpServer(
      this.computerHelpIdentity,
      this.computerHelpGenerationState.file,
    )];
    const childEnv = { ...spec.env };
    delete childEnv.APP_SERVER_LOGS;
    const ownsProcessGroup = process.platform !== "win32";
    this.child = spawn(spec.command, spec.args, {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: ownsProcessGroup,
    });
    this.ownedProcessGroupId = ownsProcessGroup ? (this.child.pid ?? null) : null;
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdoutData(chunk));
    const err = readline.createInterface({ input: this.child.stderr });
    err.on("line", (line) => {
      if (this.transportError || this.closed) {
        void this.invokeCallback(this.processStderrHandler, [line], { cleanup: true });
        return;
      }
      void this.invokeCallback(
        this.handlers.onStderr,
        [line],
        { discardProcessStderr: true },
      );
    });
    this.child.stdin.on("error", () => {
      this.failTransport(transportFailureError());
    });
    this.child.on("error", () => {
      this.failTransport(transportFailureError());
    });
    this.child.once("exit", () => {
      this.childExited = true;
      if (!this.ownedProcessGroupExists()) this.clearForceKillTimer();
      this.failTransport(new Error("ACP child exited"));
    });
    this.child.once("close", () => {
      this.childExited = true;
      this.processStderrHandler = undefined;
      if (!this.ownedProcessGroupExists()) this.clearForceKillTimer();
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  private send(obj: unknown): void {
    if (this.transportError || this.closed || this.child.stdin.destroyed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(obj)}\n`);
    } catch {
      this.failTransport(transportFailureError());
    }
  }

  private createCallbackChain(): CallbackChain {
    let detach!: () => void;
    const detached = new Promise<void>((resolve) => { detach = resolve; });
    return {
      active: true,
      running: false,
      waiting: 0,
      queue: [],
      tail: Promise.resolve(),
      detached,
      detach,
      fail: (options) => {
        if (options.discardProcessStderr) this.processStderrHandler = undefined;
        this.failTransport(callbackTransportError(options));
      },
    };
  }

  private detachCallbackChain(replace = false): void {
    const chain = this.callbackChain;
    if (chain.active) {
      chain.active = false;
      chain.fail = null;
      chain.detach();
      for (const task of chain.queue.splice(0)) {
        task.invoke = null;
        if (!task.settled) {
          task.settled = true;
          task.resolve();
        }
      }
    }
    if (replace && !this.transportError && !this.closed) {
      this.callbackChain = this.createCallbackChain();
    }
  }

  private finishCallbackTask(chain: CallbackChain, task: CallbackTask): void {
    task.invocation.active = false;
    if (!task.settled) {
      task.settled = true;
      task.resolve();
    }
    chain.running = false;
    if (!chain.active || this.transportError || this.closed) return;
    const next = chain.queue.shift();
    if (next) this.runCallbackTask(chain, next);
  }

  private runCallbackTask(chain: CallbackChain, task: CallbackTask): void {
    if (!chain.active || this.transportError || this.closed) {
      this.finishCallbackTask(chain, task);
      return;
    }
    chain.running = true;
    const invoke = task.invoke;
    task.invoke = null;
    task.invocation.active = true;
    let result: AcpHandlerResult;
    try {
      result = this.callbackContext.run({
        chain,
        invocation: task.invocation,
      }, () => invoke?.());
    } catch {
      chain.fail?.(task.options);
      this.finishCallbackTask(chain, task);
      return;
    }
    if (result === undefined) {
      this.finishCallbackTask(chain, task);
      return;
    }
    chain.waiting += 1;
    void Promise.resolve(result).then(
      () => {
        chain.waiting -= 1;
        this.finishCallbackTask(chain, task);
      },
      () => {
        chain.waiting -= 1;
        chain.fail?.(task.options);
        this.finishCallbackTask(chain, task);
      },
    );
  }

  private invokeCallback<Args extends unknown[]>(
    callback: ((...args: Args) => AcpHandlerResult) | undefined,
    args: Args,
    options: {
      cleanup?: boolean;
      discardProcessStderr?: boolean;
      responseFlushed?: boolean;
      transportClosed?: boolean;
    } = {},
  ): Promise<void> {
    if (!callback) return Promise.resolve();
    if (options.cleanup) {
      try {
        return Promise.resolve(callback(...args)).then(
          () => undefined,
          () => undefined,
        );
      } catch {
        return Promise.resolve();
      }
    }
    if (this.transportError || this.closed) return Promise.resolve();
    const chain = this.callbackChain;
    let resolveTask!: () => void;
    const taskDone = new Promise<void>((resolve) => { resolveTask = resolve; });
    const task: CallbackTask = {
      invoke: () => callback(...args),
      invocation: { active: false },
      options,
      resolve: resolveTask,
      settled: false,
    };
    const work = Promise.race([taskDone, chain.detached]).then(() => undefined);
    chain.tail = work;
    if (chain.running) {
      chain.queue.push(task);
    } else {
      this.runCallbackTask(chain, task);
    }
    return work;
  }

  private callbacksBeforeSettlement(): Promise<void> {
    const chain = this.callbackChain;
    return Promise.race([chain.tail, chain.detached]).then(() => undefined);
  }

  private sendConfirmed(
    obj: unknown,
    commitFlushedState?: () => void,
    applicationCallback?: () => AcpHandlerResult,
  ): Promise<void> {
    if (this.transportError) return Promise.reject(this.transportError);
    if (this.closed || this.child.stdin.destroyed) {
      return Promise.reject(new Error("ACP transport is closed"));
    }
    const responseCallbackContext = this.callbackContext.getStore();
    return new Promise((resolve, reject) => {
      let settled = false;
      const rejectWrite = (error: Error) => {
        if (settled) return;
        settled = true;
        this.pendingWriteRejectors.delete(rejectWrite);
        reject(error);
      };
      const resolveWrite = () => {
        if (settled) return;
        settled = true;
        this.pendingWriteRejectors.delete(rejectWrite);
        resolve();
      };
      this.pendingWriteRejectors.add(rejectWrite);
      try {
        this.child.stdin.write(`${JSON.stringify(obj)}\n`, (err) => {
          if (settled) return;
          if (err) {
            this.failTransport(transportFailureError());
            return;
          }
          const responseFlushCallback = applicationCallback ? Symbol() : null;
          if (responseFlushCallback) this.pendingResponseFlushCallbacks.add(responseFlushCallback);
          try {
            commitFlushedState?.();
          } catch {
            this.failTransport(transportFailureError());
            return;
          }
          const commitApplicationCallback = applicationCallback
            ? () => {
                const result = applicationCallback();
                if (result === undefined) {
                  if (responseFlushCallback) {
                    this.pendingResponseFlushCallbacks.delete(responseFlushCallback);
                  }
                  resolveWrite();
                  return;
                }
                return Promise.resolve(result).then(() => {
                  if (responseFlushCallback) {
                    this.pendingResponseFlushCallbacks.delete(responseFlushCallback);
                  }
                  resolveWrite();
                });
              }
            : undefined;
          const responseFromActiveCallback = (
            responseCallbackContext?.chain === this.callbackChain
            && responseCallbackContext.chain.active
            && responseCallbackContext.invocation.active
          );
          const callbackWork = responseFromActiveCallback && commitApplicationCallback
            ? this.invokeResponseCallbackInline(commitApplicationCallback)
            : this.invokeCallback(
                commitApplicationCallback,
                [],
                { responseFlushed: true },
              );
          void callbackWork.then(() => {
            if (responseFlushCallback) this.pendingResponseFlushCallbacks.delete(responseFlushCallback);
            if (settled) return;
            if (this.transportError) {
              rejectWrite(this.transportError);
              return;
            }
            resolveWrite();
          });
        });
      } catch {
        this.failTransport(transportFailureError());
      }
    });
  }

  private invokeResponseCallbackInline(callback: () => AcpHandlerResult): Promise<void> {
    try {
      return Promise.resolve(callback()).then(
        () => undefined,
        () => {
          this.failTransport(callbackTransportError({ responseFlushed: true }));
        },
      );
    } catch {
      this.failTransport(callbackTransportError({ responseFlushed: true }));
      return Promise.resolve();
    }
  }

  private rejectPendingWrites(error: Error): void {
    const rejectors = [...this.pendingWriteRejectors];
    this.pendingWriteRejectors.clear();
    for (const reject of rejectors) reject(error);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.transportError) return Promise.reject(this.transportError);
    if (this.closed || this.child.stdin.destroyed) {
      return Promise.reject(new Error("ACP transport is closed"));
    }
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
    return this.withStartDeadline(response);
  }

  private withStartDeadline<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const error = startTimeoutError();
        this.failTransport(error);
        reject(error);
      }, this.startDeadlineMs);
      timer.unref();
      operation.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private failAll(err: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    const idleResolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const p of pending) p.reject(err);
    for (const resolve of idleResolvers) resolve();
  }

  private failTransport(err: Error): void {
    if (this.transportError) return;
    const failure = this.pendingResponseFlushCallbacks.size > 0
      ? callbackTransportError({
          responseFlushed: true,
          transportClosed: cancellationClosedTransport(err),
        })
      : err;
    const computerHelpCancellations = [...this.pendingComputerHelp.values()].map((pending) => ({
      callback: pending.handlers.onComputerHelpCancelled,
      prompt: pending.prompt,
    }));
    this.transportError = failure;
    this.closed = true;
    this.detachCallbackChain();
    this.pendingResponseFlushCallbacks.clear();
    this.stdoutBuffer = Buffer.alloc(0);
    this.generation += 1;
    this.activeGen = this.generation;
    this.sessionId = null;
    this.sessionAttachment = null;
    this.promptId = null;
    this.promptHandoffPending = false;
    this.finishCancelledPromptDrain(undefined, failure);
    this.promptDrain = null;
    this.abortPrompt = null;
    this.activeHandlers = null;
    this.handlers = {};
    this.pendingPermissions.clear();
    this.pendingComputerHelp.clear();
    this.activeServerRequests.clear();
    this.resetElicitationLifecycle();
    this.streaming = false;
    this.turnText = "";
    this.messageText = "";
    this.openMessageId = null;
    this.nonTextBoundary = false;
    this.gotIdle = true;
    this.closeComputerHelpGenerationState();
    this.rejectPendingWrites(failure);
    this.failAll(failure);
    this.terminateChild();
    for (const cancellation of computerHelpCancellations) {
      void this.invokeCallback(cancellation.callback, [cancellation.prompt], { cleanup: true });
    }
  }

  private clearForceKillTimer(): void {
    if (!this.forceKillTimer) return;
    clearTimeout(this.forceKillTimer);
    this.forceKillTimer = null;
  }

  private terminateChild(): void {
    if (this.forceKillTimer) return;
    const groupId = this.ownedProcessGroupId;
    const child = this.child;
    if (
      groupId === null
      && (this.childExited || child.exitCode !== null || child.signalCode !== null)
    ) {
      return;
    }
    if (groupId !== null && !this.ownedProcessGroupExists(groupId)) return;
    this.signalOwnedTransport("SIGTERM", child, groupId);
    if (
      groupId === null
      && (this.childExited || child.exitCode !== null || child.signalCode !== null)
    ) {
      return;
    }
    if (groupId !== null && !this.ownedProcessGroupExists(groupId)) return;
    const timer = setTimeout(() => {
      if (this.forceKillTimer === timer) this.forceKillTimer = null;
      if (this.child !== child || this.ownedProcessGroupId !== groupId) return;
      if (
        groupId === null
        && (this.childExited || child.exitCode !== null || child.signalCode !== null)
      ) {
        return;
      }
      if (groupId !== null && !this.ownedProcessGroupExists(groupId)) return;
      this.signalOwnedTransport("SIGKILL", child, groupId);
    }, this.terminateGraceMs);
    this.forceKillTimer = timer;
    timer.unref();
  }

  private signalOwnedTransport(
    signal: NodeJS.Signals,
    child: ChildProcessWithoutNullStreams,
    groupId: number | null,
  ): void {
    if (groupId !== null && groupId > 0) {
      try {
        // A detached POSIX child is the leader of this exact owned process group.
        process.kill(-groupId, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      }
    }
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  }

  private ownedProcessGroupExists(groupId = this.ownedProcessGroupId): boolean {
    if (groupId === null || groupId <= 0) return false;
    try {
      process.kill(-groupId, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private waitIdle(): Promise<void> {
    if (this.gotIdle) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  private beginCancelledPromptDrain(promptId: RpcId): void {
    this.finishCancelledPromptDrain();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const drain = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const timer = setTimeout(() => {
      if (this.cancelledPromptDrain?.promptId !== promptId) return;
      this.failTransport(cancelledError(true));
    }, this.startDeadlineMs);
    timer.unref();
    this.cancelledPromptDrain = { promptId, resolve, reject, timer };
    this.promptDrain = drain;
    void drain.then(
      () => {
        if (this.promptDrain === drain) this.promptDrain = null;
      },
      () => {
        if (this.promptDrain === drain) this.promptDrain = null;
      },
    );
  }

  private finishCancelledPromptDrain(promptId?: RpcId, error?: Error): boolean {
    const drain = this.cancelledPromptDrain;
    if (!drain || (promptId !== undefined && drain.promptId !== promptId)) return false;
    this.cancelledPromptDrain = null;
    clearTimeout(drain.timer);
    if (error) drain.reject(error);
    else drain.resolve();
    return true;
  }

  private hasActivePromptMessageWindow(): boolean {
    if (this.cancelledPromptDrain) return true;
    if (this.promptId === null || this.activeGen !== this.generation) return false;
    const pending = this.pending.get(this.promptId);
    return pending !== undefined && !pending.settlementQueued;
  }

  private claimServerRequest(
    rpcId: RpcId,
    kind: ActiveServerRequest["kind"],
    requestParams?: Record<string, unknown>,
  ): boolean {
    const active = this.activeServerRequests.get(rpcId);
    if (active) {
      const computerHelp = this.pendingComputerHelp.get(rpcId);
      if (
        kind === "elicitation"
        && active.kind === "elicitation"
        && computerHelp?.generation === active.generation
        && requestParams !== undefined
        && jsonValuesEqual(computerHelp.requestParams, requestParams)
      ) {
        return false;
      }
      this.failTransport(new Error(ACP_PROTOCOL_ERROR_MESSAGE));
      return false;
    }
    this.activeServerRequests.set(rpcId, { kind, generation: this.activeGen });
    return true;
  }

  private releaseServerRequest(
    rpcId: RpcId,
    kind: ActiveServerRequest["kind"],
    generation: number,
  ): void {
    const active = this.activeServerRequests.get(rpcId);
    if (active?.kind === kind && active.generation === generation) {
      this.activeServerRequests.delete(rpcId);
    }
  }

  private hasPendingPermission(generation: number): boolean {
    for (const pending of this.pendingPermissions.values()) {
      if (pending.generation === generation) return true;
    }
    return false;
  }

  private inboundSessionId(): string | null {
    return this.sessionAttachment?.sessionId ?? this.sessionId;
  }

  private stageSessionAttachmentResponse(
    rpcId: RpcId,
    message: Record<string, unknown>,
  ): boolean {
    const attachment = this.sessionAttachment;
    if (!attachment || attachment.requestId !== rpcId || hasOwn(message, "error")) return true;
    const result = message.result;
    const record = isObjectRecord(result) ? result : null;
    const returnedId = record?.sessionId ?? record?.session_id;
    if (attachment.method === "session/new") {
      if (typeof returnedId !== "string" || returnedId.length === 0) {
        this.failTransport(new Error(ACP_PROTOCOL_ERROR_MESSAGE));
        return false;
      }
      attachment.sessionId = returnedId;
      return true;
    }
    if (
      returnedId !== undefined
      && (
        typeof returnedId !== "string"
        || returnedId.length === 0
        || returnedId !== attachment.sessionId
      )
    ) {
      this.failTransport(new Error(ACP_PROTOCOL_ERROR_MESSAGE));
      return false;
    }
    return true;
  }

  private cancelPermission(rpcId: RpcId): void {
    const pending = this.pendingPermissions.get(rpcId);
    if (!pending || pending.responding) return;
    pending.responding = true;
    void this.sendConfirmed({
      jsonrpc: "2.0",
      id: rpcId,
      result: { outcome: { outcome: "cancelled" } },
    }, () => {
      if (this.pendingPermissions.get(rpcId) === pending) this.pendingPermissions.delete(rpcId);
      this.releaseServerRequest(rpcId, "permission", pending.generation);
    }).catch(() => {
      const current = this.pendingPermissions.get(rpcId);
      if (current === pending && !this.transportError) current.responding = false;
    });
  }

  private cancelComputerHelpWhere(
    predicate: (pending: { generation: number }) => boolean,
    respond: boolean,
  ): Promise<void> {
    const callbacks: Promise<void>[] = [];
    for (const [rpcId, pending] of this.pendingComputerHelp) {
      if (!predicate(pending)) continue;
      this.pendingComputerHelp.delete(rpcId);
      this.rememberTerminalElicitation(rpcId);
      if (respond && !this.transportError && !this.closed && !this.child.stdin.destroyed) {
        void this.sendConfirmed(
          { jsonrpc: "2.0", id: rpcId, result: { action: "cancel" } },
          () => this.releaseServerRequest(rpcId, "elicitation", pending.generation),
        ).catch(() => undefined);
      } else {
        this.releaseServerRequest(rpcId, "elicitation", pending.generation);
      }
      callbacks.push(this.invokeCallback(
        pending.handlers.onComputerHelpCancelled,
        [pending.prompt],
        { transportClosed: true },
      ));
    }
    return Promise.all(callbacks).then(() => undefined);
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

  private rejectElicitation(rpcId: RpcId, generation = this.activeGen): void {
    this.rememberTerminalElicitation(rpcId);
    const response = { jsonrpc: "2.0", id: rpcId, result: { action: "cancel" } };
    const closeAfterResponse = this.terminalElicitationLimitReached;
    if (closeAfterResponse) {
      if (this.elicitationOverflowClosing) return;
      this.elicitationOverflowClosing = true;
    }
    void this.sendConfirmed(response, () => {
      this.releaseServerRequest(rpcId, "elicitation", generation);
    }).then(
      () => { if (closeAfterResponse) this.close(); },
      () => { if (closeAfterResponse) this.close(); },
    );
  }

  private finishStreamingMessage(): Promise<void> {
    if (!this.streaming) return Promise.resolve();
    this.streaming = false;
    const text = this.messageText;
    let callbackWork = Promise.resolve();
    if (text) {
      this.turnText += text;
      callbackWork = this.invokeCallback((this.activeHandlers ?? this.handlers).onAssistant, [text, {
        done: true,
        ...(this.openMessageId ? { messageId: this.openMessageId } : {}),
      }]);
    }
    this.nonTextBoundary = false;
    return callbackWork;
  }

  private onStdoutData(chunk: Buffer): void {
    if (this.transportError || this.closed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      const lineLength = this.stdoutBuffer.length + segment.length;
      if (lineLength > MAX_ACP_INPUT_LINE_BYTES) {
        this.failTransport(new Error(ACP_PROTOCOL_ERROR_MESSAGE));
        return;
      }
      if (segment.length > 0) {
        this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, segment], lineLength);
      }
      if (newline === -1) return;
      let line = this.stdoutBuffer;
      this.stdoutBuffer = Buffer.alloc(0);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(line);
      } catch {
        this.failTransport(new Error(ACP_PROTOCOL_ERROR_MESSAGE));
        return;
      }
      this.onLine(decoded);
      if (this.transportError || this.closed) return;
      offset = newline + 1;
    }
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      this.failTransport(new Error(ACP_PROTOCOL_ERROR_MESSAGE));
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.failTransport(new Error(ACP_PROTOCOL_ERROR_MESSAGE));
      return;
    }
    const msg = parsed as Record<string, unknown>;
    if (!isJsonRpcEnvelope(msg) || !hasValidAcpMethodRole(msg)) {
      this.failTransport(new Error(ACP_PROTOCOL_ERROR_MESSAGE));
      return;
    }
    if (
      (msg.method === "session/update" || msg.method === "session/request_permission")
      && (msg.params as Record<string, unknown>).sessionId !== this.inboundSessionId()
    ) {
      this.failTransport(new Error(ACP_PROTOCOL_ERROR_MESSAGE));
      return;
    }
    if (msg.id !== undefined && msg.method === undefined && (hasOwn(msg, "result") || hasOwn(msg, "error"))) {
      const id = msg.id as RpcId;
      const p = this.pending.get(id);
      if (!p) {
        const drain = this.cancelledPromptDrain;
        if (
          !drain
          || drain.promptId !== id
          || (hasOwn(msg, "result") && !isPromptResponse(msg.result))
        ) {
          this.failTransport(new Error(ACP_PROTOCOL_ERROR_MESSAGE));
          return;
        }
        this.finishCancelledPromptDrain(id);
        return;
      }
      if (p.settlementQueued) {
        this.failTransport(new Error(ACP_PROTOCOL_ERROR_MESSAGE));
        return;
      }
      if (!this.stageSessionAttachmentResponse(id, msg)) return;
      p.settlementQueued = true;
      const error = hasOwn(msg, "error")
        ? sanitizedRpcError(msg.error as { code: number; message: string })
        : null;
      const result = msg.result;
      const callbackWork = id === this.promptId
        ? this.callbacksBeforeSettlement()
        : Promise.resolve();
      queueMicrotask(() => {
        void callbackWork.then(() => {
          if (this.pending.get(id) !== p) return;
          this.pending.delete(id);
          if (error) p.reject(error);
          else p.resolve(result);
        });
      });
      return;
    }
    if (
      (msg.method === "session/request_permission" || msg.method === "elicitation/create")
      && !this.hasActivePromptMessageWindow()
    ) {
      this.failTransport(new Error(ACP_PROTOCOL_ERROR_MESSAGE));
      return;
    }
    if (msg.method === "session/request_permission") {
      if (msg.id === undefined) return;
      const rpcId = msg.id as RpcId;
      if (!this.claimServerRequest(rpcId, "permission")) return;
      this.pendingPermissions.set(rpcId, { generation: this.activeGen, responding: false });
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
      if (!handler) {
        this.cancelPermission(rpcId);
        return;
      }
      void this.invokeCallback(handler, [{
        rpcId,
        title: params.title ?? params.toolCall?.title ?? "Allow this tool?",
        description: params.description ?? params.toolCall?.title,
        options: validatedPermissionOptions(params.options),
        locations: params.toolCall?.locations,
        rawInput: params.toolCall?.rawInput ?? null,
        toolKind: params.toolCall?.kind,
        meta: params._meta,
      }]);
      return;
    }
    if (msg.method === "elicitation/create") {
      if (msg.id === undefined) return;
      const rpcId = msg.id as RpcId;
      if (this.terminalElicitations.has(rpcId)) return;
      const requestParams = msg.params as Record<string, unknown>;
      if (!this.claimServerRequest(rpcId, "elicitation", requestParams)) return;
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
        requestParams,
        handlers,
        responding: false,
      });
      void this.invokeCallback(handlers.onComputerHelp, [computerHelp]);
      return;
    }
    if (msg.method === "session/update") {
      const params = msg.params as { update: Record<string, unknown> };
      if (this.sessionAttachment?.method === "session/load") return;
      if (!this.hasActivePromptMessageWindow()) {
        const kind = String(params.update.sessionUpdate ?? params.update.session_update ?? "");
        if (kind === "agent_message" || kind === "agent_message_chunk") {
          this.failTransport(new Error(ACP_PROTOCOL_ERROR_MESSAGE));
        }
        return;
      }
      this.handleUpdate(params.update);
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
      if (piece === null) {
        this.failTransport(new Error(ACP_PROTOCOL_ERROR_MESSAGE));
        return;
      }
      if (!piece) return;
      const messageId = readMessageId(update);
      const startsIdentifiedMessage = messageId !== undefined
        && shouldStartBubble(this.openMessageId, messageId);
      const startsAnonymousMessage = messageId === undefined
        && this.streaming
        && this.nonTextBoundary;
      if (this.streaming && (startsIdentifiedMessage || startsAnonymousMessage)) {
        void this.finishStreamingMessage();
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
      if (piece === null) {
        this.failTransport(new Error(ACP_PROTOCOL_ERROR_MESSAGE));
        return;
      }
      if (!piece) return;
      const messageId = readMessageId(update);
      const completesOpenStream = this.streaming && (
        messageId !== undefined
          ? this.openMessageId === messageId
          : this.openMessageId === null && !this.nonTextBoundary
      );
      if (this.streaming && !completesOpenStream) void this.finishStreamingMessage();
      this.streaming = false;
      this.nonTextBoundary = false;
      this.messageText = piece;
      this.turnText += piece;
      this.openMessageId = messageId ?? null;
      void this.invokeCallback((this.activeHandlers ?? this.handlers).onAssistant, [piece, {
        start: true,
        done: true,
        ...(messageId !== undefined ? { messageId } : {}),
      }]);
      return;
    }
    if (kind === "tool_call" || kind === "agent_thought_chunk") {
      if (this.streaming) this.nonTextBoundary = true;
      return;
    }
    if (kind === "state_update") {
      if (update.state === "idle") {
        void this.finishStreamingMessage();
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
    const attachment: SessionAttachment = {
      requestId: this.nextId,
      method: "session/new",
      sessionId: null,
    };
    this.sessionAttachment = attachment;
    try {
      await this.request("session/new", {
        cwd,
        mcpServers: this.mcpServers,
      });
      const id = attachment.sessionId;
      if (typeof id !== "string" || !id) {
        throw new Error("session/new did not return a sessionId");
      }
      this.sessionId = id;
      this.resetElicitationLifecycle();
      return id;
    } finally {
      if (this.sessionAttachment === attachment) this.sessionAttachment = null;
    }
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
    const attachment: SessionAttachment = {
      requestId: this.nextId,
      method,
      sessionId,
    };
    this.sessionAttachment = attachment;
    try {
      await this.request(method, {
        sessionId,
        cwd: this.cwd,
        mcpServers: this.mcpServers,
      });
      this.sessionId = sessionId;
      this.resetElicitationLifecycle();
      return sessionId;
    } finally {
      if (this.sessionAttachment === attachment) this.sessionAttachment = null;
    }
  }

  async prompt(text: string, handlers?: AcpHandlers): Promise<string> {
    if (this.transportError) throw this.transportError;
    if (!this.sessionId) throw new Error("no ACP session");
    const myGen = ++this.generation;
    const priorDrain = this.promptDrain;
    if (priorDrain) await priorDrain;
    if (this.transportError) throw this.transportError;
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
    this.promptHandoffPending = true;
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
    void aborted.catch(() => undefined);
    this.abortPrompt = abortPrompt;
    const promptWrite = this.sendConfirmed({
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      },
    });
    try {
      const handoff = (async () => {
        const writtenCallback = this.invokeCallback(promptHandlers.onPromptWritten, []);
        await Promise.all([promptWrite, writtenCallback]);
        if (this.transportError) throw this.transportError;
        if (this.promptId === id) this.promptHandoffPending = false;
        if (myGen !== this.generation) throw cancelledError();
        await this.invokeCallback(promptHandlers.onPromptFlushed, []);
        if (this.transportError) throw this.transportError;
      })();
      await this.withStartDeadline(handoff);
      const result = await Promise.race([rpc, aborted]);
      if (!isPromptResponse(result)) {
        const error = new Error(ACP_PROTOCOL_ERROR_MESSAGE);
        this.failTransport(error);
        throw error;
      }
      if (this.hasPendingPermission(myGen)) {
        const error = new Error(ACP_PROTOCOL_ERROR_MESSAGE);
        this.failTransport(error);
        throw error;
      }
      await this.finishStreamingMessage();
      if (this.transportError) throw this.transportError;
      return this.turnText;
    } finally {
      for (const [rpcId, permission] of this.pendingPermissions) {
        if (permission.generation === myGen) this.cancelPermission(rpcId);
      }
      const transportBeforeCleanup = this.transportError;
      await this.cancelComputerHelpWhere((pending) => pending.generation === myGen, true);
      if (!transportBeforeCleanup && this.transportError) throw this.transportError;
      this.invalidateComputerHelpGeneration(myGen);
      if (this.promptId === id) {
        this.promptId = null;
        this.promptHandoffPending = false;
      }
      if (this.abortPrompt === abortPrompt) this.abortPrompt = null;
      if (this.activeGen === myGen) this.activeHandlers = null;
    }
  }

  cancel(): boolean {
    if (this.transportError || this.closed) return false;
    if (this.promptHandoffPending) {
      this.failTransport(cancelledError(true));
      return false;
    }
    if (this.callbackChain.waiting > 0) {
      this.failTransport(cancelledError(true));
      return false;
    }
    this.detachCallbackChain(true);
    const cancelledGeneration = this.activeGen;
    this.generation += 1;
    this.streaming = false;
    this.messageText = "";
    this.turnText = "";
    this.openMessageId = null;
    this.nonTextBoundary = false;
    this.activeHandlers = null;
    const error = cancelledError();
    if (this.promptId !== null) {
      const cancelledPromptId = this.promptId;
      const pending = this.pending.get(cancelledPromptId);
      this.pending.delete(cancelledPromptId);
      pending?.reject(error);
      this.promptId = null;
      this.beginCancelledPromptDrain(cancelledPromptId);
    }
    const abort = this.abortPrompt;
    this.abortPrompt = null;
    abort?.();
    this.gotIdle = true;
    for (const resolve of this.idleResolvers) resolve();
    this.idleResolvers = [];
    for (const [rpcId, permission] of this.pendingPermissions) {
      if (permission.generation === this.activeGen) this.cancelPermission(rpcId);
    }
    void this.cancelComputerHelpWhere((pending) => pending.generation === cancelledGeneration, true);
    this.invalidateComputerHelpGeneration(cancelledGeneration);
    if (this.sessionId) {
      this.send({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: this.sessionId },
      });
    }
    return this.transportError === null;
  }

  async respondPermission(
    rpcId: RpcId,
    optionId: string,
    onFlushed?: () => AcpHandlerResult,
  ): Promise<void> {
    const pending = this.pendingPermissions.get(rpcId);
    if (
      !pending
      || pending.generation !== this.activeGen
      || pending.responding
    ) {
      throw Object.assign(new Error("Permission request is no longer active"), { status: 409 });
    }
    pending.responding = true;
    try {
      await this.sendConfirmed({
        jsonrpc: "2.0",
        id: rpcId,
        result: { outcome: { outcome: "selected", optionId } },
      }, () => {
        if (this.pendingPermissions.get(rpcId) === pending) this.pendingPermissions.delete(rpcId);
        this.releaseServerRequest(rpcId, "permission", pending.generation);
      }, onFlushed);
    } catch (error) {
      const current = this.pendingPermissions.get(rpcId);
      if (current === pending && !this.transportError) current.responding = false;
      throw error;
    }
  }

  async respondComputerHelp(
    rpcId: RpcId,
    resolution: ComputerHelpResolution,
    onFlushed?: () => AcpHandlerResult,
  ): Promise<void> {
    const pending = this.pendingComputerHelp.get(rpcId);
    if (
      !pending
      || pending.generation !== this.activeGen
      || pending.responding
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
        this.releaseServerRequest(rpcId, "elicitation", pending.generation);
      }, onFlushed);
    } catch (err) {
      const current = this.pendingComputerHelp.get(rpcId);
      if (current === pending) current.responding = false;
      throw err;
    }
  }

  close(): void {
    this.failTransport(new Error("ACP client closed"));
  }
}

export function spawnAcp(spec: SpawnSpec, cwd: string, handlers?: AcpHandlers): AcpClient {
  if (spec.command === "docker" || spec.args.includes("exec")) {
    throw new Error("ACP child must be a host process, not docker exec");
  }
  return new AcpClient(spec, cwd, handlers);
}
