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

export type DisplayHandle = {
  botId: string;
  display: number;
  containerPort: number;
  hostPort: number;
  upstream: string;
};

export type ComputerRuntime = {
  allocate(botId: string): Promise<DisplayHandle>;
  upstream(botId: string): string | undefined;
  display(botId: string): DisplayHandle | undefined;
  computerUpstream(): string | undefined;
  cookieJar(): string;
  containerName(): string;
  commands: string[][];
};

export type DockerFn = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export function defaultCookieJar(cwd = process.cwd()): string {
  return path.resolve(cwd, "computer/cookies");
}

export function parseScreenPorts(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
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
      child.stdout.on("data", (chunk) => out.push(chunk));
      child.stderr.on("data", (chunk) => err.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
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
  private slots = new Map<string, DisplayHandle>();
  private nextDisplay = 1;
  private cookieDir: string;
  private upstreams: string[];
  private name: string;

  constructor(
    opts: {
      cookiesDir?: string;
      upstreams?: string[];
      containerName?: string;
    } = {},
  ) {
    this.cookieDir = opts.cookiesDir ?? defaultCookieJar();
    this.upstreams = opts.upstreams ?? [`http://127.0.0.1:${HOST_PORT_FLOOR}`];
    this.name = opts.containerName ?? COMPUTER_CONTAINER;
    fs.mkdirSync(this.cookieDir, { recursive: true });
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

  async allocate(botId: string): Promise<DisplayHandle> {
    const existing = this.slots.get(botId);
    if (existing) return existing;
    if (this.nextDisplay > DISPLAY_MAX) {
      throw Object.assign(new Error("Computer is out of displays"), { status: 409 });
    }
    const display = this.nextDisplay++;
    const containerPort = CONTAINER_PORT_BASE + display - 1;
    const upstream = this.upstreams[display - 1] ?? this.upstreams[0];
    const url = new URL(upstream);
    const hostPort = Number(url.port || "80");
    if (isForbiddenHostPort(hostPort)) {
      throw new Error("refusing to publish Screen on 6901");
    }
    if (display === 1) {
      this.commands.push(["inspect", this.name]);
    } else {
      this.commands.push(["exec", this.name, DISPLAY_BIN, "start", String(display)]);
    }
    const handle: DisplayHandle = { botId, display, containerPort, hostPort, upstream };
    this.slots.set(botId, handle);
    return handle;
  }
}

export class NoopComputerRuntime implements ComputerRuntime {
  readonly commands: string[][] = [];
  private cookieDir: string;
  private base?: string;

  constructor(cookiesDir = defaultCookieJar(), upstream?: string) {
    this.cookieDir = cookiesDir;
    this.base = upstream;
    fs.mkdirSync(this.cookieDir, { recursive: true });
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

  upstream(_botId: string): string | undefined {
    return this.base;
  }

  display(_botId: string): DisplayHandle | undefined {
    return undefined;
  }

  async allocate(botId: string): Promise<DisplayHandle> {
    const hostPort = this.base ? Number(new URL(this.base).port || HOST_PORT_FLOOR) : HOST_PORT_FLOOR;
    return {
      botId,
      display: 1,
      containerPort: CONTAINER_PORT_BASE,
      hostPort,
      upstream: this.base ?? `http://127.0.0.1:${HOST_PORT_FLOOR}`,
    };
  }
}

export type DockerComputerOptions = {
  containerName?: string;
  hostPorts?: number[];
  cookiesDir?: string;
  workspaceDir?: string;
  password?: string;
  docker?: DockerFn;
  env?: NodeJS.ProcessEnv;
};

export class DockerComputerRuntime implements ComputerRuntime {
  readonly commands: string[][] = [];
  private slots = new Map<string, DisplayHandle>();
  private nextDisplay = 1;
  private name: string;
  private hostPorts: number[];
  private cookiesDir: string;
  private docker: DockerFn;

  constructor(opts: DockerComputerOptions = {}) {
    this.name = opts.containerName ?? process.env.OPENBOT_SCREEN_CONTAINER ?? COMPUTER_CONTAINER;
    this.hostPorts = opts.hostPorts ?? parseScreenPorts(process.env.SCREEN_PORTS);
    this.cookiesDir = opts.cookiesDir ?? defaultCookieJar();
    this.docker = opts.docker ?? defaultDocker(opts.env ?? process.env);
    fs.mkdirSync(this.cookiesDir, { recursive: true });
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

  async allocate(botId: string): Promise<DisplayHandle> {
    const existing = this.slots.get(botId);
    if (existing) return existing;
    if (this.nextDisplay > DISPLAY_MAX) {
      throw Object.assign(new Error("Computer is out of displays"), { status: 409 });
    }
    const display = this.nextDisplay++;
    const containerPort = CONTAINER_PORT_BASE + display - 1;
    const hostPort = this.hostPorts[display - 1];
    if (!hostPort) {
      throw new Error("SCREEN_PORTS does not cover this display");
    }
    if (isForbiddenHostPort(hostPort) || isForbiddenHostPort(containerPort) && hostPort === FORBIDDEN_HOST_PORT) {
      throw new Error("refusing to publish Screen on 6901");
    }
    if (isForbiddenHostPort(hostPort)) {
      throw new Error("refusing to publish Screen on 6901");
    }
    if (display > 1) {
      const started = await this.exec(["exec", this.name, DISPLAY_BIN, "start", String(display)]);
      if (started.code !== 0) {
        throw new Error(started.stderr.trim() || `openbot-display start ${display} failed`);
      }
    } else {
      await this.exec(["inspect", this.name]);
    }
    const handle: DisplayHandle = {
      botId,
      display,
      containerPort,
      hostPort,
      upstream: `http://127.0.0.1:${hostPort}`,
    };
    this.slots.set(botId, handle);
    return handle;
  }

  private async exec(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    if (args[0] === "run") {
      throw new Error("Talk does not docker run a per-Bot Screen");
    }
    if (args.some((item) => /^openbot-screen-.+/.test(item) && item !== this.name)) {
      throw new Error("Talk does not docker run a per-Bot Screen");
    }
    this.commands.push(args);
    return this.docker(args);
  }
}
