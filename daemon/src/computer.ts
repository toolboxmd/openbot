import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

/** Host loopback floor. Never publish Screen on 6901 (agent desktop often owns it). */
export const HOST_PORT_FLOOR = 16901;
export const FORBIDDEN_HOST_PORT = 6901;
export const CONTAINER_PORT_BASE = 6901;
export const DISPLAY_MAX = 8;
export const COMPUTER_CONTAINER = "openbot-screen";
export const SCREEN_IMAGE = "openbot-screen";
export const COOKIE_MOUNT = "/computer/cookies";
export const WORKSPACE_MOUNT = "/workspace";
export const DISPLAY_BIN = "/usr/local/bin/openbot-display";
export const PINCHTAB_CONTAINER_PORT_BASE = 9867;
export const CDP_PORT_BASE = 9222;
export const MAX_DOCKER_OUTPUT_BYTES = 64 * 1024;

export type DisplayHandle = {
  botId: string;
  display: number;
  containerPort: number;
  hostPort: number;
  upstream: string;
  pinchTabHostPort?: number;
  pinchTabUrl?: string;
};

export type PinchTabBridge = {
  url: string;
  token: string;
};

export type ComputerRuntime = {
  readonly requiresReadiness: boolean;
  reserve(botId: string, requestedDisplay?: number): DisplayHandle;
  prepare(botId: string): Promise<DisplayHandle>;
  commit(botId: string): DisplayHandle;
  rollback(botId: string, display?: number): Promise<void>;
  allocate(botId: string): Promise<DisplayHandle>;
  release(botId: string): Promise<void>;
  upstream(botId: string): string | undefined;
  display(botId: string): DisplayHandle | undefined;
  computerUpstream(): string | undefined;
  cookieJar(): string;
  containerName(): string;
  pinchTab(botId: string): PinchTabBridge | undefined;
  commands: string[][];
};

export type DockerFn = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

function validateDockerResult(
  result: { code: number; stdout: string; stderr: string },
  args: string[],
): { code: number; stdout: string; stderr: string } {
  if (!Number.isInteger(result.code)) {
    throw new Error(`docker ${args[0] ?? "command"} returned an invalid exit status`);
  }
  for (const [stream, output] of [["stdout", result.stdout], ["stderr", result.stderr]] as const) {
    if (typeof output !== "string" || Buffer.byteLength(output) > MAX_DOCKER_OUTPUT_BYTES) {
      throw new Error(`docker ${args[0] ?? "command"} ${stream} exceeded the bounded output contract`);
    }
  }
  return result;
}

function reserveDisplay(handles: Iterable<DisplayHandle>, requestedDisplay?: number): number | undefined {
  const used = new Set([...handles].map((handle) => handle.display));
  if (requestedDisplay !== undefined) {
    if (!Number.isInteger(requestedDisplay) || requestedDisplay < 1 || requestedDisplay > DISPLAY_MAX) {
      throw new Error("Screen display reservation is invalid");
    }
    if (used.has(requestedDisplay)) {
      throw Object.assign(new Error(`Screen display ${requestedDisplay} is already reserved`), { status: 409 });
    }
    return requestedDisplay;
  }
  return Array.from({ length: DISPLAY_MAX }, (_, index) => index + 1).find((display) => !used.has(display));
}

export function defaultCookieJar(cwd = process.cwd()): string {
  return path.resolve(cwd, "computer/cookies");
}

export function assertPrivateDirectoryTarget(directory: string): void {
  const resolved = path.resolve(directory);
  if (directory.length === 0 || resolved === path.parse(resolved).root) {
    throw new Error(`private state directory must not be the filesystem root: ${directory || "<empty>"}`);
  }
}

function ensurePrivateDirectory(directory: string): void {
  assertPrivateDirectoryTarget(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const state = fs.lstatSync(directory);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error(`cookie jar must be a private directory: ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
}

export function parseScreenPorts(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export const parsePinchTabPorts = parseScreenPorts;

export function pinchTabContainerPort(display: number): number {
  return PINCHTAB_CONTAINER_PORT_BASE + display - 1;
}

export function chromeCdpPort(display: number): number {
  return CDP_PORT_BASE + display - 1;
}

export function isForbiddenHostPort(port: number): boolean {
  return port === FORBIDDEN_HOST_PORT;
}

function listenLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close((err) => resolve(!err));
    });
  });
}

export async function pickScreenPorts(
  count = DISPLAY_MAX,
  avoid: number[] = [FORBIDDEN_HOST_PORT],
): Promise<number[]> {
  const blocked = new Set(avoid);
  blocked.add(FORBIDDEN_HOST_PORT);
  const ports: number[] = [];
  let candidate = HOST_PORT_FLOOR;
  while (ports.length < count) {
    if (candidate > HOST_PORT_FLOOR + 4000) {
      throw new Error("could not allocate loopback ports for Screen");
    }
    if (!blocked.has(candidate) && (await listenLoopback(candidate))) {
      ports.push(candidate);
    }
    candidate += 1;
  }
  return ports;
}

function defaultDocker(env: NodeJS.ProcessEnv): DockerFn {
  return (args) =>
    new Promise((resolve, reject) => {
      const child = spawn("docker", args, { env, stdio: ["ignore", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(error);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > MAX_DOCKER_OUTPUT_BYTES) {
          fail(new Error("docker stdout exceeded the bounded output contract"));
          return;
        }
        out.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        errBytes += chunk.length;
        if (errBytes > MAX_DOCKER_OUTPUT_BYTES) {
          fail(new Error("docker stderr exceeded the bounded output contract"));
          return;
        }
        err.push(chunk);
      });
      child.on("error", fail);
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        });
      });
    });
}

export class MemoryComputerRuntime implements ComputerRuntime {
  readonly commands: string[][] = [];
  readonly requiresReadiness: boolean;
  private slots = new Map<string, DisplayHandle>();
  private reservations = new Map<string, DisplayHandle>();
  private prepared = new Set<string>();
  private cookieDir: string;
  private upstreams: string[];
  private name: string;
  private pinchTabUpstreams: string[];
  private pinchTabTokenValue?: string;

  constructor(
    opts: {
      cookiesDir?: string;
      upstreams?: string[];
      containerName?: string;
      pinchTabUpstreams?: string[];
      pinchTabToken?: string;
      requiresReadiness?: boolean;
    } = {},
  ) {
    this.cookieDir = opts.cookiesDir ?? defaultCookieJar();
    this.upstreams = opts.upstreams ?? [`http://127.0.0.1:${HOST_PORT_FLOOR}`];
    this.name = opts.containerName ?? COMPUTER_CONTAINER;
    this.pinchTabUpstreams = opts.pinchTabUpstreams ?? [];
    this.pinchTabTokenValue = opts.pinchTabToken;
    this.requiresReadiness = opts.requiresReadiness ?? false;
    ensurePrivateDirectory(this.cookieDir);
  }

  cookieJar(): string {
    return this.cookieDir;
  }

  containerName(): string {
    return this.name;
  }

  computerUpstream(): string | undefined {
    return this.upstreams[0];
  }

  upstream(botId: string): string | undefined {
    return this.slots.get(botId)?.upstream;
  }

  display(botId: string): DisplayHandle | undefined {
    return this.slots.get(botId);
  }

  reserve(botId: string, requestedDisplay?: number): DisplayHandle {
    const existing = this.slots.get(botId) ?? this.reservations.get(botId);
    if (existing) {
      if (requestedDisplay !== undefined && existing.display !== requestedDisplay) {
        throw new Error(`Screen display reservation changed from ${existing.display} to ${requestedDisplay}`);
      }
      return existing;
    }
    const display = reserveDisplay(
      [...this.slots.values(), ...this.reservations.values()],
      requestedDisplay,
    );
    if (!display) {
      throw Object.assign(new Error("Computer is out of displays"), { status: 409 });
    }
    const containerPort = CONTAINER_PORT_BASE + display - 1;
    const upstream = this.upstreams[display - 1] ?? this.upstreams[0];
    const url = new URL(upstream);
    const hostPort = Number(url.port || "80");
    if (isForbiddenHostPort(hostPort)) {
      throw new Error("refusing to publish Screen on 6901");
    }
    const pinchTabUrl = this.pinchTabUpstreams[display - 1];
    const pinchTabHostPort = pinchTabUrl ? Number(new URL(pinchTabUrl).port || "0") || undefined : undefined;
    const handle: DisplayHandle = {
      botId,
      display,
      containerPort,
      hostPort,
      upstream,
      pinchTabHostPort,
      pinchTabUrl,
    };
    this.reservations.set(botId, handle);
    return handle;
  }

  async prepare(botId: string): Promise<DisplayHandle> {
    const handle = this.reservations.get(botId) ?? this.slots.get(botId);
    if (!handle) throw new Error("Screen display is not reserved");
    if (this.slots.has(botId)) return handle;
    if (handle.display === 1) {
      this.commands.push(["inspect", this.name]);
    } else {
      this.commands.push(["exec", this.name, DISPLAY_BIN, "start", String(handle.display)]);
    }
    this.prepared.add(botId);
    return handle;
  }

  commit(botId: string): DisplayHandle {
    const existing = this.slots.get(botId);
    if (existing) return existing;
    const handle = this.reservations.get(botId);
    if (!handle) throw new Error("Screen display is not reserved");
    if (!this.prepared.has(botId)) throw new Error("Screen display is not prepared");
    this.reservations.delete(botId);
    this.prepared.delete(botId);
    this.slots.set(botId, handle);
    return handle;
  }

  async rollback(botId: string, display?: number): Promise<void> {
    const handle = this.reservations.get(botId) ?? this.slots.get(botId);
    const ownedDisplay = handle?.display ?? display;
    if (!ownedDisplay) return;
    if (ownedDisplay > 1) {
      this.commands.push(["exec", this.name, DISPLAY_BIN, "discard", String(ownedDisplay)]);
    }
    this.reservations.delete(botId);
    this.prepared.delete(botId);
    this.slots.delete(botId);
  }

  async allocate(botId: string): Promise<DisplayHandle> {
    const existing = this.slots.get(botId);
    if (existing) return existing;
    this.reserve(botId);
    try {
      await this.prepare(botId);
      return this.commit(botId);
    } catch (error) {
      await this.rollback(botId);
      throw error;
    }
  }

  async release(botId: string): Promise<void> {
    const handle = this.slots.get(botId) ?? this.reservations.get(botId);
    if (!handle) return;
    if (handle.display > 1) {
      this.commands.push(["exec", this.name, DISPLAY_BIN, "stop", String(handle.display)]);
    }
    this.reservations.delete(botId);
    this.prepared.delete(botId);
    this.slots.delete(botId);
  }

  pinchTab(botId: string): PinchTabBridge | undefined {
    const slot = this.slots.get(botId);
    if (!slot?.pinchTabUrl || !this.pinchTabTokenValue) return undefined;
    return { url: slot.pinchTabUrl, token: this.pinchTabTokenValue };
  }
}

export class NoopComputerRuntime implements ComputerRuntime {
  readonly commands: string[][] = [];
  readonly requiresReadiness = false;
  private cookieDir: string;
  private base?: string;
  private slots = new Map<string, DisplayHandle>();
  private reservations = new Map<string, DisplayHandle>();
  private prepared = new Set<string>();

  constructor(cookiesDir = defaultCookieJar(), upstream?: string) {
    this.cookieDir = cookiesDir;
    this.base = upstream;
    ensurePrivateDirectory(this.cookieDir);
  }

  cookieJar(): string {
    return this.cookieDir;
  }

  containerName(): string {
    return COMPUTER_CONTAINER;
  }

  computerUpstream(): string | undefined {
    return this.base;
  }

  upstream(botId: string): string | undefined {
    return this.slots.get(botId)?.upstream ?? this.base;
  }

  display(botId: string): DisplayHandle | undefined {
    return this.slots.get(botId);
  }

  reserve(botId: string, requestedDisplay?: number): DisplayHandle {
    const existing = this.slots.get(botId) ?? this.reservations.get(botId);
    if (existing) {
      if (requestedDisplay !== undefined && existing.display !== requestedDisplay) {
        throw new Error(`Screen display reservation changed from ${existing.display} to ${requestedDisplay}`);
      }
      return existing;
    }
    const display = reserveDisplay(
      [...this.slots.values(), ...this.reservations.values()],
      requestedDisplay,
    );
    if (!display) throw Object.assign(new Error("Computer is out of displays"), { status: 409 });
    const hostPort = this.base ? Number(new URL(this.base).port || HOST_PORT_FLOOR) : HOST_PORT_FLOOR;
    const handle = {
      botId,
      display,
      containerPort: CONTAINER_PORT_BASE + display - 1,
      hostPort,
      upstream: this.base ?? `http://127.0.0.1:${HOST_PORT_FLOOR}`,
    };
    this.reservations.set(botId, handle);
    return handle;
  }

  async prepare(botId: string): Promise<DisplayHandle> {
    const handle = this.reservations.get(botId) ?? this.slots.get(botId);
    if (!handle) throw new Error("Screen display is not reserved");
    if (this.slots.has(botId)) return handle;
    this.prepared.add(botId);
    return handle;
  }

  commit(botId: string): DisplayHandle {
    const existing = this.slots.get(botId);
    if (existing) return existing;
    const handle = this.reservations.get(botId);
    if (!handle) throw new Error("Screen display is not reserved");
    if (!this.prepared.has(botId)) throw new Error("Screen display is not prepared");
    this.reservations.delete(botId);
    this.prepared.delete(botId);
    this.slots.set(botId, handle);
    return handle;
  }

  async rollback(botId: string, _display?: number): Promise<void> {
    this.reservations.delete(botId);
    this.prepared.delete(botId);
    this.slots.delete(botId);
  }

  async allocate(botId: string): Promise<DisplayHandle> {
    const existing = this.slots.get(botId);
    if (existing) return existing;
    this.reserve(botId);
    await this.prepare(botId);
    return this.commit(botId);
  }

  async release(botId: string): Promise<void> {
    this.reservations.delete(botId);
    this.prepared.delete(botId);
    this.slots.delete(botId);
  }

  pinchTab(_botId: string): PinchTabBridge | undefined {
    return undefined;
  }
}

export type DockerComputerOptions = {
  containerName?: string;
  hostPorts?: number[];
  pinchTabHostPorts?: number[];
  pinchTabToken?: string;
  cookiesDir?: string;
  workspaceDir?: string;
  password?: string;
  docker?: DockerFn;
  env?: NodeJS.ProcessEnv;
};

export class DockerComputerRuntime implements ComputerRuntime {
  readonly commands: string[][] = [];
  readonly requiresReadiness = true;
  private slots = new Map<string, DisplayHandle>();
  private reservations = new Map<string, DisplayHandle>();
  private prepared = new Set<string>();
  private name: string;
  private hostPorts: number[];
  private pinchTabHostPorts: number[];
  private pinchTabTokenValue?: string;
  private cookiesDir: string;
  private docker: DockerFn;

  constructor(opts: DockerComputerOptions = {}) {
    this.name = opts.containerName ?? process.env.OPENBOT_SCREEN_CONTAINER ?? COMPUTER_CONTAINER;
    this.hostPorts = opts.hostPorts ?? parseScreenPorts(process.env.SCREEN_PORTS);
    this.pinchTabHostPorts = opts.pinchTabHostPorts ?? parsePinchTabPorts(process.env.PINCHTAB_PORTS);
    this.pinchTabTokenValue = opts.pinchTabToken ?? process.env.PINCHTAB_TOKEN;
    this.cookiesDir = opts.cookiesDir ?? defaultCookieJar();
    this.docker = opts.docker ?? defaultDocker(opts.env ?? process.env);
    ensurePrivateDirectory(this.cookiesDir);
    if (opts.workspaceDir) fs.mkdirSync(opts.workspaceDir, { recursive: true });
  }

  cookieJar(): string {
    return this.cookiesDir;
  }

  containerName(): string {
    return this.name;
  }

  computerUpstream(): string | undefined {
    const port = this.hostPorts[0];
    if (!port || isForbiddenHostPort(port)) return undefined;
    return `http://127.0.0.1:${port}`;
  }

  upstream(botId: string): string | undefined {
    return this.slots.get(botId)?.upstream ?? this.computerUpstream();
  }

  display(botId: string): DisplayHandle | undefined {
    return this.slots.get(botId);
  }

  reserve(botId: string, requestedDisplay?: number): DisplayHandle {
    const existing = this.slots.get(botId) ?? this.reservations.get(botId);
    if (existing) {
      if (requestedDisplay !== undefined && existing.display !== requestedDisplay) {
        throw new Error(`Screen display reservation changed from ${existing.display} to ${requestedDisplay}`);
      }
      return existing;
    }
    const display = reserveDisplay(
      [...this.slots.values(), ...this.reservations.values()],
      requestedDisplay,
    );
    if (!display) {
      throw Object.assign(new Error("Computer is out of displays"), { status: 409 });
    }
    const containerPort = CONTAINER_PORT_BASE + display - 1;
    const hostPort = this.hostPorts[display - 1];
    if (!hostPort) {
      throw new Error("SCREEN_PORTS does not cover this display");
    }
    const configuredOwner = this.hostPorts.indexOf(hostPort) + 1;
    if (configuredOwner !== display) {
      throw Object.assign(
        new Error(`Screen endpoint for display ${display} is already assigned to display ${configuredOwner}`),
        { status: 409, code: "SCREEN_ENDPOINT_CONFLICT", recoverable: true },
      );
    }
    if (isForbiddenHostPort(hostPort) || isForbiddenHostPort(containerPort) && hostPort === FORBIDDEN_HOST_PORT) {
      throw new Error("refusing to publish Screen on 6901");
    }
    if (isForbiddenHostPort(hostPort)) {
      throw new Error("refusing to publish Screen on 6901");
    }
    const pinchTabHostPort = this.pinchTabHostPorts[display - 1];
    if (pinchTabHostPort && isForbiddenHostPort(pinchTabHostPort)) {
      throw new Error("refusing to publish Screen on 6901");
    }
    const handle: DisplayHandle = {
      botId,
      display,
      containerPort,
      hostPort,
      upstream: `http://127.0.0.1:${hostPort}`,
      pinchTabHostPort,
      pinchTabUrl: pinchTabHostPort ? `http://127.0.0.1:${pinchTabHostPort}` : undefined,
    };
    this.reservations.set(botId, handle);
    return handle;
  }

  async prepare(botId: string): Promise<DisplayHandle> {
    const handle = this.reservations.get(botId) ?? this.slots.get(botId);
    if (!handle) throw new Error("Screen display is not reserved");
    if (this.slots.has(botId)) return handle;
    if (handle.display > 1) {
      const started = await this.exec(["exec", this.name, DISPLAY_BIN, "start", String(handle.display)]);
      if (started.code !== 0) {
        throw new Error(started.stderr.trim() || `openbot-display start ${handle.display} failed`);
      }
    } else {
      const inspected = await this.exec(["inspect", "--format", "{{.State.Running}}", this.name]);
      if (inspected.code !== 0) {
        throw new Error(inspected.stderr.trim() || "Docker Screen inspection failed");
      }
      if (inspected.stderr !== "" || inspected.stdout !== "true\n") {
        throw new Error("Docker Screen inspection returned an invalid running-state record");
      }
    }
    this.prepared.add(botId);
    return handle;
  }

  commit(botId: string): DisplayHandle {
    const existing = this.slots.get(botId);
    if (existing) return existing;
    const handle = this.reservations.get(botId);
    if (!handle) throw new Error("Screen display is not reserved");
    if (!this.prepared.has(botId)) throw new Error("Screen display is not prepared");
    this.reservations.delete(botId);
    this.prepared.delete(botId);
    this.slots.set(botId, handle);
    return handle;
  }

  async rollback(botId: string, display?: number): Promise<void> {
    const handle = this.reservations.get(botId) ?? this.slots.get(botId);
    const ownedDisplay = handle?.display ?? display;
    if (!ownedDisplay) return;
    if (ownedDisplay > 1) {
      const discarded = await this.exec(["exec", this.name, DISPLAY_BIN, "discard", String(ownedDisplay)]);
      if (discarded.code !== 0) {
        throw new Error(discarded.stderr.trim() || `openbot-display discard ${ownedDisplay} failed`);
      }
    }
    this.reservations.delete(botId);
    this.prepared.delete(botId);
    this.slots.delete(botId);
  }

  async allocate(botId: string): Promise<DisplayHandle> {
    const existing = this.slots.get(botId);
    if (existing) return existing;
    this.reserve(botId);
    try {
      await this.prepare(botId);
      return this.commit(botId);
    } catch (error) {
      await this.rollback(botId);
      throw error;
    }
  }

  async release(botId: string): Promise<void> {
    const handle = this.slots.get(botId) ?? this.reservations.get(botId);
    if (!handle) return;
    if (handle.display > 1) {
      const stopped = await this.exec(["exec", this.name, DISPLAY_BIN, "stop", String(handle.display)]);
      if (stopped.code !== 0) {
        throw new Error(stopped.stderr.trim() || `openbot-display stop ${handle.display} failed`);
      }
    }
    this.reservations.delete(botId);
    this.prepared.delete(botId);
    this.slots.delete(botId);
  }

  pinchTab(botId: string): PinchTabBridge | undefined {
    const slot = this.slots.get(botId);
    if (!slot?.pinchTabUrl || !this.pinchTabTokenValue) return undefined;
    return { url: slot.pinchTabUrl, token: this.pinchTabTokenValue };
  }

  private async exec(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    if (args[0] === "run") {
      throw new Error("Talk does not docker run a per-Bot Screen");
    }
    if (args.some((item) => /^openbot-screen-.+/.test(item) && item !== this.name)) {
      throw new Error("Talk does not docker run a per-Bot Screen");
    }
    this.commands.push(args);
    return validateDockerResult(await this.docker(args), args);
  }
}
