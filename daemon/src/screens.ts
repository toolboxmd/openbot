import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

/** Host loopback floor. Never publish Screen on 6901 (agent desktop often owns it). */
export const HOST_PORT_FLOOR = 16901;
export const CONTAINER_PORT = 6901;
export const SCREEN_IMAGE = "openbot-screen";
export const COOKIE_MOUNT = "/computer/cookies";
export const WORKSPACE_MOUNT = "/workspace";
export const HOME_MOUNT = "/home/openbot";

export type ScreenHandle = {
  botId: string;
  name: string;
  port: number;
  upstream: string;
};

export type ScreenRuntime = {
  wake(botId: string): Promise<ScreenHandle>;
  sleep(botId: string): Promise<void>;
  running(botId: string): boolean;
  upstream(botId: string): string | undefined;
  cookieJar(): string;
  hydrate?(): Promise<void>;
};

export type DockerFn = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export function containerName(botId: string): string {
  return `openbot-screen-${botId}`;
}

export function homeVolume(botId: string): string {
  return `openbot-screen-${botId}-home`;
}

export function defaultCookieJar(cwd = process.cwd()): string {
  return path.resolve(cwd, "computer/cookies");
}

export async function freeLoopbackPort(avoid: number[] = [CONTAINER_PORT]): Promise<number> {
  const blocked = new Set(avoid);
  for (let i = 0; i < 40; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          server.close();
          reject(new Error("port bind failed"));
          return;
        }
        const chosen = addr.port;
        server.close((err) => (err ? reject(err) : resolve(chosen)));
      });
    });
    if (!blocked.has(port)) return port;
  }
  throw new Error("could not allocate a loopback port for Screen");
}

export class MemoryScreenRuntime implements ScreenRuntime {
  readonly started: string[] = [];
  readonly stopped: string[] = [];
  private live = new Map<string, ScreenHandle>();
  private cookieDir: string;
  private delayMs: number;
  private upstreamFor?: (botId: string) => string;

  constructor(
    opts: {
      cookiesDir?: string;
      delayMs?: number;
      upstreamFor?: (botId: string) => string;
    } = {},
  ) {
    this.cookieDir = opts.cookiesDir ?? defaultCookieJar();
    this.delayMs = opts.delayMs ?? 0;
    this.upstreamFor = opts.upstreamFor;
    fs.mkdirSync(this.cookieDir, { recursive: true });
  }

  async wake(botId: string): Promise<ScreenHandle> {
    this.started.push(botId);
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    const upstream = this.upstreamFor?.(botId) ?? `http://127.0.0.1:${HOST_PORT_FLOOR}`;
    const url = new URL(upstream);
    const port = Number(url.port || "80");
    const handle: ScreenHandle = {
      botId,
      name: containerName(botId),
      port,
      upstream,
    };
    this.live.set(botId, handle);
    return handle;
  }

  async sleep(botId: string): Promise<void> {
    this.stopped.push(botId);
    this.live.delete(botId);
  }

  running(botId: string): boolean {
    return this.live.has(botId);
  }

  upstream(botId: string): string | undefined {
    return this.live.get(botId)?.upstream;
  }

  cookieJar(): string {
    return this.cookieDir;
  }
}

export class NoopScreenRuntime implements ScreenRuntime {
  private cookieDir: string;
  constructor(cookiesDir = defaultCookieJar()) {
    this.cookieDir = cookiesDir;
    fs.mkdirSync(this.cookieDir, { recursive: true });
  }
  async wake(botId: string): Promise<ScreenHandle> {
    return {
      botId,
      name: containerName(botId),
      port: HOST_PORT_FLOOR,
      upstream: `http://127.0.0.1:${HOST_PORT_FLOOR}`,
    };
  }
  async sleep(_botId: string): Promise<void> {}
  running(_botId: string): boolean {
    return false;
  }
  upstream(_botId: string): string | undefined {
    return undefined;
  }
  cookieJar(): string {
    return this.cookieDir;
  }
}

export type DockerScreenOptions = {
  image?: string;
  cookiesDir?: string;
  workspaceDir?: string;
  password?: string;
  docker?: DockerFn;
  env?: NodeJS.ProcessEnv;
  pickPort?: () => Promise<number>;
};

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

function parsePublishedPort(inspectJson: string): number | undefined {
  try {
    const rows = JSON.parse(inspectJson) as Array<{
      NetworkSettings?: { Ports?: Record<string, Array<{ HostPort?: string }> | null> };
    }>;
    const ports = rows[0]?.NetworkSettings?.Ports?.["6901/tcp"];
    const host = ports?.[0]?.HostPort;
    if (host) return Number(host);
  } catch {
    /* ignore */
  }
  return undefined;
}

function parseRunning(inspectJson: string): boolean {
  try {
    const rows = JSON.parse(inspectJson) as Array<{ State?: { Running?: boolean } }>;
    return Boolean(rows[0]?.State?.Running);
  } catch {
    return false;
  }
}

export class DockerScreenRuntime implements ScreenRuntime {
  readonly commands: string[][] = [];
  private live = new Map<string, ScreenHandle>();
  private image: string;
  private cookiesDir: string;
  private workspaceDir: string;
  private password: string;
  private docker: DockerFn;
  private pickPort: () => Promise<number>;

  constructor(opts: DockerScreenOptions = {}) {
    this.image = opts.image ?? process.env.OPENBOT_SCREEN_IMAGE ?? SCREEN_IMAGE;
    this.cookiesDir = opts.cookiesDir ?? defaultCookieJar();
    this.workspaceDir = opts.workspaceDir ?? path.resolve(process.cwd(), "workspace");
    this.password = opts.password ?? process.env.OPENBOT_PASSWORD ?? "openbot";
    this.docker = opts.docker ?? defaultDocker(opts.env ?? process.env);
    this.pickPort = opts.pickPort ?? (() => freeLoopbackPort());
    fs.mkdirSync(this.cookiesDir, { recursive: true });
    fs.mkdirSync(this.workspaceDir, { recursive: true });
  }

  cookieJar(): string {
    return this.cookiesDir;
  }

  running(botId: string): boolean {
    return this.live.has(botId);
  }

  upstream(botId: string): string | undefined {
    return this.live.get(botId)?.upstream;
  }

  async hydrate(): Promise<void> {
    const listed = await this.exec(["ps", "-a", "--filter", "name=openbot-screen-", "--format", "{{.Names}}"]);
    const names = listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const name of names) {
      if (!name.startsWith("openbot-screen-")) continue;
      const botId = name.slice("openbot-screen-".length);
      const inspect = await this.exec(["inspect", name]);
      if (inspect.code !== 0) continue;
      if (!parseRunning(inspect.stdout)) continue;
      const port = parsePublishedPort(inspect.stdout);
      if (!port || port === CONTAINER_PORT) continue;
      this.live.set(botId, {
        botId,
        name,
        port,
        upstream: `http://127.0.0.1:${port}`,
      });
    }
  }

  async wake(botId: string): Promise<ScreenHandle> {
    const name = containerName(botId);
    const inspect = await this.exec(["inspect", name]);
    if (inspect.code === 0) {
      const running = parseRunning(inspect.stdout);
      if (!running) {
        const started = await this.exec(["start", name]);
        if (started.code !== 0) {
          throw new Error(started.stderr.trim() || `docker start ${name} failed`);
        }
      }
      const again = await this.exec(["inspect", name]);
      let port = parsePublishedPort(again.stdout);
      if (!port || port === CONTAINER_PORT) port = await this.pickPort();
      const handle: ScreenHandle = { botId, name, port, upstream: `http://127.0.0.1:${port}` };
      this.live.set(botId, handle);
      return handle;
    }

    const port = await this.pickPort();
    if (port === CONTAINER_PORT) {
      throw new Error("refusing to publish Screen on 6901");
    }
    const args = [
      "run",
      "-d",
      "--name",
      name,
      "--shm-size",
      "1g",
      "-p",
      `127.0.0.1:${port}:6901`,
      "-e",
      "VNC_USER=openbot",
      "-e",
      `VNC_PASSWORD=${this.password}`,
      "-e",
      `BOT_ID=${botId}`,
      "-e",
      "CHROME_USER_DATA_DIR=/home/openbot/.config/chromium",
      "-v",
      `${homeVolume(botId)}:${HOME_MOUNT}`,
      "-v",
      `${this.cookiesDir}:${COOKIE_MOUNT}`,
      "-v",
      `${this.workspaceDir}:${WORKSPACE_MOUNT}`,
      "--restart",
      "unless-stopped",
      this.image,
    ];
    const ran = await this.exec(args);
    if (ran.code !== 0) {
      throw new Error(ran.stderr.trim() || `docker run ${name} failed`);
    }
    const handle: ScreenHandle = { botId, name, port, upstream: `http://127.0.0.1:${port}` };
    this.live.set(botId, handle);
    return handle;
  }

  async sleep(botId: string): Promise<void> {
    const name = containerName(botId);
    const stopped = await this.exec(["stop", name]);
    if (stopped.code !== 0 && !/no such container/i.test(stopped.stderr)) {
      // still mark asleep; missing container is a no-op
    }
    this.live.delete(botId);
  }

  private async exec(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    this.commands.push(args);
    if (args[0] === "pause" || args.includes("pause")) {
      throw new Error("Sleep is docker stop, not pause");
    }
    return this.docker(args);
  }
}
