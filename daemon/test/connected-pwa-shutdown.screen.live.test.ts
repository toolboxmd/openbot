import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { pickScreenPorts } from "../src/computer.ts";

const LIVE_GRANT = "connected-pwa-shutdown";
const PASSWORD = "openbot-screen-live";
const BROWSER_WAIT_MS = 300_000;
const START_WAIT_MS = 300_000;
const SHUTDOWN_WAIT_MS = 30_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 1_048_576;
const COMMAND_TERM_GRACE_MS = 250;
const COMMAND_KILL_OBSERVE_MS = 1_000;
const DOCKER_INSPECT_WAIT_MS = 5_000;
const DOCKER_BUILD_WAIT_MS = 600_000;
const DOCKER_CLEANUP_WAIT_MS = 120_000;
const PWA_BUILD_WAIT_MS = 120_000;

if (process.env.OPENBOT_SCREEN_LIVE_GRANT !== LIVE_GRANT) {
  throw new Error(
    `OPENBOT_SCREEN_LIVE_GRANT=${LIVE_GRANT} is required before the live Screen lane may create resources`,
  );
}
if (process.env.OPENBOT_SCREEN_LIVE_BROWSER !== "iab") {
  throw new Error(
    "OPENBOT_SCREEN_LIVE_BROWSER=iab is required; the connected-PWA checkpoint uses one isolated in-app Browser tab",
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");

type TapEvent = {
  at: number;
  kind: string;
  seq: number;
  requestPath?: string;
  httpStatus?: number;
  upgradeId?: number;
};

type OwnedCommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
};

class OwnedCommandError extends Error {
  readonly result: OwnedCommandResult;

  constructor(message: string, result: OwnedCommandResult) {
    super(message);
    this.name = "OwnedCommandError";
    this.result = result;
  }
}

type PublicComputer = {
  botId: string | null;
  display: number | null;
  ownership: string;
  path: string | null;
  ready: boolean;
  screenState: string;
};

type TalkProcess = {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  logs: () => string;
};

function bounded<T>(promise: Promise<T>, timeoutMs: number, message: () => string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${message()} after ${timeoutMs} ms`)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${message()} after ${timeoutMs} ms`);
}

function runOwnedCommand(
  command: string,
  args: string[],
  options: {
    description: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<OwnedCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      detached: process.platform !== "win32",
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ownedPid = child.pid;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let childClosed = false;
    let settled = false;
    let terminalError: Error | undefined;
    let termTimer: NodeJS.Timeout | undefined;
    let observeTimer: NodeJS.Timeout | undefined;
    let reapTimer: NodeJS.Timeout | undefined;

    const result = (
      code: number | null = child.exitCode,
      signal: NodeJS.Signals | null = child.signalCode,
    ): OwnedCommandResult => ({
      code,
      signal,
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdout: Buffer.concat(stdout).toString("utf8"),
    });
    const groupAlive = (): boolean => {
      if (!ownedPid) return false;
      if (process.platform === "win32") {
        return child.exitCode === null && child.signalCode === null;
      }
      try {
        process.kill(-ownedPid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (!ownedPid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-ownedPid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
      }
    };
    const clearTimers = (): void => {
      clearTimeout(deadlineTimer);
      if (termTimer) clearTimeout(termTimer);
      if (observeTimer) clearTimeout(observeTimer);
      if (reapTimer) clearInterval(reapTimer);
    };
    const finishFailureAfterClosure = (): void => {
      if (settled || !terminalError || !childClosed || groupAlive()) return;
      settled = true;
      clearTimers();
      reject(terminalError);
    };
    const finishFailureAtBound = (): void => {
      finishFailureAfterClosure();
      if (settled || !terminalError) return;
      settled = true;
      clearTimers();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      reject(terminalError);
    };
    const fail = (error: Error): void => {
      if (settled || terminalError) return;
      terminalError = error;
      clearTimeout(deadlineTimer);
      signalGroup("SIGTERM");
      termTimer = setTimeout(() => {
        if (groupAlive()) signalGroup("SIGKILL");
        observeTimer = setTimeout(finishFailureAtBound, COMMAND_KILL_OBSERVE_MS);
        observeTimer.unref();
        finishFailureAfterClosure();
      }, COMMAND_TERM_GRACE_MS);
      termTimer.unref();
      reapTimer = setInterval(finishFailureAfterClosure, 10);
      reapTimer.unref();
      finishFailureAfterClosure();
    };
    const append = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr"): void => {
      if (terminalError) return;
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > COMMAND_OUTPUT_LIMIT_BYTES) {
        fail(new OwnedCommandError(
          `${options.description} exceeded ${COMMAND_OUTPUT_LIMIT_BYTES} bytes of combined output`,
          result(),
        ));
        return;
      }
      target.push(chunk);
    };
    const deadlineTimer = setTimeout(() => {
      fail(new OwnedCommandError(
        `${options.description} timed out after ${options.timeoutMs} ms`,
        result(),
      ));
    }, options.timeoutMs);
    deadlineTimer.unref();

    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk, "stderr"));
    child.once("error", (error) => fail(error));
    child.once("close", (code, signal) => {
      childClosed = true;
      if (terminalError) {
        finishFailureAfterClosure();
        return;
      }
      const completed = result(code, signal);
      if (code !== 0) {
        fail(new OwnedCommandError(
          `${options.description} exited ${code ?? signal ?? "without status"}`,
          completed,
        ));
        return;
      }
      settled = true;
      clearTimers();
      resolve(completed);
    });
  });
}

async function dockerAvailable(env: NodeJS.ProcessEnv): Promise<void> {
  await runOwnedCommand("docker", ["info"], {
    description: "Docker availability check",
    env,
    timeoutMs: DOCKER_INSPECT_WAIT_MS,
  });
}

async function sharedScreenSnapshot(env: NodeJS.ProcessEnv): Promise<unknown> {
  let inspect: OwnedCommandResult;
  try {
    inspect = await runOwnedCommand("docker", ["container", "inspect", "openbot-screen"], {
      description: "protected Screen inspection",
      env,
      timeoutMs: DOCKER_INSPECT_WAIT_MS,
    });
  } catch (error) {
    if (
      error instanceof OwnedCommandError
      && error.result.code !== null
      && /No such (?:container|object)|not found/iu.test(`${error.result.stdout}\n${error.result.stderr}`)
    ) {
      return null;
    }
    throw error;
  }
  const row = (JSON.parse(inspect.stdout) as Array<Record<string, unknown>>)[0] as {
    Id?: unknown;
    Image?: unknown;
    RestartCount?: unknown;
    State?: { Running?: unknown; StartedAt?: unknown };
    HostConfig?: { PortBindings?: Record<string, unknown> };
    NetworkSettings?: { Networks?: Record<string, { NetworkID?: unknown }> };
  };
  return {
    id: row.Id,
    image: row.Image,
    restartCount: row.RestartCount,
    running: row.State?.Running,
    startedAt: row.State?.StartedAt,
    ports: Object.entries(row.HostConfig?.PortBindings ?? {}).sort(([left], [right]) =>
      left.localeCompare(right)
    ),
    networks: Object.entries(row.NetworkSettings?.Networks ?? {})
      .map(([name, value]) => [name, value.NetworkID])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  };
}

async function cleanupOwnedCommand(
  command: string,
  args: string[],
  options: {
    absentPattern?: RegExp;
    description: string;
    env: NodeJS.ProcessEnv;
  },
): Promise<void> {
  try {
    await runOwnedCommand(command, args, {
      description: options.description,
      env: options.env,
      timeoutMs: DOCKER_CLEANUP_WAIT_MS,
    });
  } catch (error) {
    if (
      error instanceof OwnedCommandError
      && error.result.code !== null
      && options.absentPattern?.test(`${error.result.stdout}\n${error.result.stderr}`)
    ) {
      return;
    }
    throw error;
  }
}

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

async function login(url: string): Promise<string> {
  const response = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, `login failed: ${response.status} ${body}`);
  const cookie = cookieHeader(response);
  assert.match(cookie, /^openbot=/u);
  return cookie;
}

async function createBot(url: string, cookie: string, name: string): Promise<string> {
  const response = await fetch(`${url}/api/bots`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const body = await response.text();
  assert.equal(response.status, 201, `Bot creation failed: ${response.status} ${body}`);
  const bot = JSON.parse(body) as { id?: unknown; display?: unknown };
  assert.equal(typeof bot.id, "string");
  assert.equal(bot.display, 1);
  return bot.id as string;
}

async function computer(url: string, cookie: string, botId: string): Promise<PublicComputer> {
  const response = await fetch(`${url}/api/computer?botId=${encodeURIComponent(botId)}`, {
    headers: { cookie },
  });
  const body = await response.text();
  assert.equal(response.status, 200, `Computer GET failed: ${response.status} ${body}`);
  return JSON.parse(body) as PublicComputer;
}

function assertViewOnlyComputer(value: PublicComputer, botId: string): void {
  assert.deepEqual({
    botId: value.botId,
    display: value.display,
    ownership: value.ownership,
    path: value.path,
    ready: value.ready,
    screenState: value.screenState,
  }, {
    botId,
    display: 1,
    ownership: "view-only",
    path: `/screen/${botId}/`,
    ready: true,
    screenState: "ready",
  });
}

function startTalk(env: NodeJS.ProcessEnv): TalkProcess {
  const tsx = join(repoRoot, "node_modules", ".bin", "tsx");
  let output = "";
  const child = spawn(tsx, ["daemon/src/index.ts"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-131_072);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, logs: () => output };
}

function signalTalk(talk: TalkProcess, signal: NodeJS.Signals): void {
  if (!talk.child.pid) throw new Error("Talk did not publish a PID");
  if (process.platform === "win32") {
    talk.child.kill(signal);
    return;
  }
  process.kill(-talk.child.pid, signal);
}

function talkGroupAlive(talk: TalkProcess): boolean {
  const pid = talk.child.pid;
  if (!pid) return false;
  if (process.platform === "win32") {
    return talk.child.exitCode === null && talk.child.signalCode === null;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function forceStopTalk(talk: TalkProcess): Promise<void> {
  if (talkGroupAlive(talk)) {
    try {
      signalTalk(talk, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  try {
    await bounded(talk.exited, 5_000, () => "forced Talk cleanup did not settle");
  } catch (error) {
    talk.child.stdout?.destroy();
    talk.child.stderr?.destroy();
    talk.child.unref();
    await waitUntil(() => !talkGroupAlive(talk), 5_000, () => "forced Talk process group survived cleanup");
    throw error;
  }
  await waitUntil(() => !talkGroupAlive(talk), 5_000, () => "forced Talk process group survived cleanup");
}

async function waitForTalk(url: string, talk: TalkProcess): Promise<void> {
  await waitUntil(async () => {
    try {
      const response = await fetch(`${url}/api/session`, { method: "GET" });
      await response.arrayBuffer();
      return true;
    } catch {
      return false;
    }
  }, START_WAIT_MS, () => `Talk did not bind; logs=${talk.logs()}`);
}

function startScreenTap(listenPort: number, targetPort: number): Promise<{
  events: TapEvent[];
  mark: (kind: string) => TapEvent;
  close: () => Promise<void>;
}> {
  const events: TapEvent[] = [];
  const sockets = new Set<Duplex>();
  const requests = new Set<http.ClientRequest>();
  let nextUpgradeId = 1;
  let nextSequence = 1;
  const record = (event: Omit<TapEvent, "at" | "seq">): TapEvent => {
    const recorded = { at: Date.now(), seq: nextSequence++, ...event };
    events.push(recorded);
    return recorded;
  };
  const server = http.createServer((request, response) => {
    const upstream = http.request({
      host: "127.0.0.1",
      port: targetPort,
      method: request.method,
      path: request.url,
      headers: request.headers,
    }, (upstreamResponse) => {
      record({
        kind: "http-response",
        requestPath: request.url,
        httpStatus: upstreamResponse.statusCode ?? 502,
      });
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    requests.add(upstream);
    upstream.once("close", () => requests.delete(upstream));
    upstream.once("error", () => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end("upstream unavailable");
    });
    request.pipe(upstream);
  });
  server.on("upgrade", (request, client, head) => {
    const upgradeId = nextUpgradeId++;
    const upstream = net.connect({ host: "127.0.0.1", port: targetPort });
    sockets.add(client);
    sockets.add(upstream);
    record({ kind: "upgrade-start", upgradeId, requestPath: request.url });
    client.once("error", () => upstream.destroy());
    upstream.once("error", () => client.destroy());
    client.once("close", () => {
      sockets.delete(client);
      record({ kind: "upgrade-client-close", upgradeId });
      upstream.destroy();
    });
    upstream.once("close", () => {
      sockets.delete(upstream);
      record({ kind: "upgrade-upstream-close", upgradeId });
      client.destroy();
    });
    upstream.once("connect", () => {
      const headers = Object.entries(request.headers).flatMap(([name, value]) =>
        Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : [`${name}: ${value ?? ""}`]
      ).join("\r\n");
      upstream.write(
        `${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`,
      );
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    let responseSeen = false;
    upstream.on("data", (chunk: Buffer) => {
      if (responseSeen) return;
      responseSeen = true;
      const status = /^HTTP\/\d\.\d\s+(\d+)/u.exec(
        chunk.toString("latin1", 0, Math.min(chunk.length, 256)),
      )?.[1];
      record({
        kind: "upgrade-response",
        upgradeId,
        requestPath: request.url,
        httpStatus: status ? Number(status) : undefined,
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: listenPort, exclusive: true }, () => {
      resolve({
        events,
        mark: (kind) => record({ kind }),
        close: async () => {
          for (const request of requests) request.destroy();
          for (const socket of sockets) socket.destroy();
          const closed = new Promise<void>((done) => server.close(() => done()));
          server.closeAllConnections();
          await bounded(closed, 5_000, () => "Screen tap did not close");
        },
      });
    });
  });
}

function checkpoint(value: Record<string, unknown>): void {
  process.stdout.write(`OPENBOT_SCREEN_LIVE_CHECKPOINT ${JSON.stringify(value)}\n`);
}

describe("Live connected PWA Screen shutdown", { timeout: 1_200_000 }, () => {
  test("revokes write before closing the active Screen connection and restarts view-only", async () => {
    const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
    const container = `openbot-screen-live-${nonce}`;
    const image = `openbot-screen-live-${nonce}:test`;
    const project = `openbot-screen-live-${nonce}`;
    const network = `openbot-screen-live-${nonce}`;
    let runtime: string | undefined;
    let composeArgs: string[] = [];
    let composeEnv: NodeJS.ProcessEnv | undefined;
    let protectedBefore: unknown;
    let protectedSnapshotTaken = false;
    let dockerChecked = false;
    let tap: Awaited<ReturnType<typeof startScreenTap>> | undefined;
    let firstTalk: TalkProcess | undefined;
    let secondTalk: TalkProcess | undefined;
    let composeAttempted = false;
    let bodyFailure: unknown = null;

    try {
      await dockerAvailable(process.env);
      dockerChecked = true;

      runtime = await mkdtemp(join(tmpdir(), `openbot-screen-live-${nonce}-`));
      const pwaDir = join(runtime, "pwa-dist");
      await runOwnedCommand(
        join(repoRoot, "node_modules", ".bin", "vite"),
        ["build", "--config", join(repoRoot, "pwa", "vite.config.ts"), "--outDir", pwaDir],
        {
          description: "fresh candidate PWA production build",
          env: process.env,
          timeoutMs: PWA_BUILD_WAIT_MS,
        },
      );
      assert.equal(
        existsSync(join(pwaDir, "index.html")),
        true,
        "the live lane did not produce a fresh candidate PWA",
      );

      protectedBefore = await sharedScreenSnapshot(process.env);
      protectedSnapshotTaken = true;
      const homeDir = join(runtime, "home");
      const workspaceDir = join(homeDir, "workspace");
      const cookiesDir = join(homeDir, "cookies");
      const passwordFile = join(runtime, "talk-password");
      const ports = await pickScreenPorts(18);
      const screenPorts = ports.slice(0, 8);
      const pinchTabPorts = ports.slice(8, 16);
      const tapPort = ports[16]!;
      const talkPort = ports[17]!;
      const talkUrl = `http://127.0.0.1:${talkPort}`;
      const override = join(runtime, "compose.override.json");
      composeArgs = [
        "compose",
        "--project-name",
        project,
        "--file",
        join(repoRoot, "docker-compose.yml"),
        "--file",
        override,
      ];

      mkdirSync(workspaceDir, { recursive: true });
      mkdirSync(cookiesDir, { recursive: true });
      writeFileSync(passwordFile, `${PASSWORD}\n`, { mode: 0o600, flag: "wx" });
      await writeFile(override, JSON.stringify({
        services: {
          screen: {
            container_name: container,
            image,
            restart: "no",
            labels: { "openbot.live": "connected-pwa-shutdown", "openbot.run": nonce },
          },
        },
        networks: { default: { name: network } },
      }));

      composeEnv = {
        ...process.env,
        OPENBOT_HOME: homeDir,
        OPENBOT_WORKSPACE: workspaceDir,
        OPENBOT_COOKIES: cookiesDir,
        OPENBOT_PASSWORD: PASSWORD,
        PINCHTAB_TOKEN: `screen-live-${nonce}`,
        SCREEN_PORTS: screenPorts.join(","),
        PINCHTAB_PORTS: pinchTabPorts.join(","),
      };
      screenPorts.forEach((port, index) => {
        composeEnv![`SCREEN_PORT_${index + 1}`] = String(port);
      });
      pinchTabPorts.forEach((port, index) => {
        composeEnv![`PINCHTAB_PORT_${index + 1}`] = String(port);
      });
      const talkScreenPorts = [tapPort, ...screenPorts.slice(1)];
      const talkEnv: NodeJS.ProcessEnv = {
        ...composeEnv,
        HOST: "127.0.0.1",
        PORT: String(talkPort),
        PWA_DIR: pwaDir,
        OPENBOT_SCREEN_CONTAINER: container,
        SCREEN_PORTS: talkScreenPorts.join(","),
      };

      tap = await startScreenTap(tapPort, screenPorts[0]!);
      composeAttempted = true;
      await runOwnedCommand(
        "docker",
        [...composeArgs, "up", "--detach", "--build", "--force-recreate", "screen"],
        {
          description: "disposable Screen compose build and start",
          env: composeEnv,
          timeoutMs: DOCKER_BUILD_WAIT_MS,
        },
      );
      assert.deepEqual(
        await sharedScreenSnapshot(process.env),
        protectedBefore,
        "disposable compose mutated protected Screen",
      );

      firstTalk = startTalk(talkEnv);
      await waitForTalk(talkUrl, firstTalk);
      const cookie = await login(talkUrl);
      const botId = await createBot(talkUrl, cookie, `Screen live ${nonce}`);
      await waitUntil(async () => {
        const value = await computer(talkUrl, cookie, botId);
        return value.ready && value.ownership === "view-only" && value.path === `/screen/${botId}/`;
      }, START_WAIT_MS, () => `Computer did not become view-only; Talk logs=${firstTalk?.logs() ?? ""}`);

      checkpoint({
        phase: "open-write",
        url: talkUrl,
        passwordFile,
        botId,
        expectedIframePath: `/screen/${botId}/`,
        instruction: "Authenticate in one fresh IAB tab, select the Bot, verify view-only, then invoke Open Computer once and keep the tab open.",
      });

      await waitUntil(() => tap!.events.some((event) =>
        event.kind === "http-response"
        && event.httpStatus === 200
        && event.requestPath?.includes("/api/update_user?")
        && event.requestPath.includes("write=true")
      ), BROWSER_WAIT_MS, () => "the connected PWA did not confirm write ownership");
      const writeTrue = [...tap.events].reverse().find((event) =>
        event.kind === "http-response"
        && event.httpStatus === 200
        && event.requestPath?.includes("write=true")
      )!;
      await waitUntil(() => tap!.events.some((event) =>
        event.kind === "upgrade-response"
        && event.httpStatus === 101
        && event.seq > writeTrue.seq
      ), BROWSER_WAIT_MS, () => "the write-mode PWA did not establish a Screen Upgrade");

      const activeUpgrade = tap.events.find((event) =>
        event.kind === "upgrade-response"
        && event.httpStatus === 101
        && event.seq > writeTrue.seq
      )!;
      const signalMark = tap.mark("talk-1-sigterm");
      signalTalk(firstTalk, "SIGTERM");
      const firstExit = await bounded(firstTalk.exited, SHUTDOWN_WAIT_MS, () =>
        `Talk did not close while the Browser tab stayed open; logs=${firstTalk?.logs() ?? ""}`
      );
      const exitMark = tap.mark("talk-1-exit");
      assert.deepEqual(firstExit, { code: 0, signal: null });

      const revoke = tap.events.find((event) =>
        event.kind === "http-response"
        && event.httpStatus === 200
        && event.seq > signalMark.seq
        && event.requestPath?.includes("write=false")
      );
      assert.ok(revoke, "shutdown did not confirm Kasm write=false");
      const clientClose = tap.events.find((event) =>
        event.kind === "upgrade-client-close"
        && event.upgradeId === activeUpgrade.upgradeId
        && event.seq > revoke.seq
      );
      const upstreamClose = tap.events.find((event) =>
        event.kind === "upgrade-upstream-close"
        && event.upgradeId === activeUpgrade.upgradeId
        && event.seq > revoke.seq
      );
      assert.ok(clientClose, "the connected PWA Screen side did not close after writer revoke");
      assert.ok(upstreamClose, "the Screen upstream did not close after writer revoke");
      assert.ok(clientClose.seq < exitMark.seq && upstreamClose.seq < exitMark.seq);
      assert.ok(exitMark.at - signalMark.at <= SHUTDOWN_WAIT_MS);

      const restartMark = tap.mark("talk-2-start");
      secondTalk = startTalk(talkEnv);
      await waitForTalk(talkUrl, secondTalk);
      const restartedCookie = await login(talkUrl);
      await waitUntil(async () => {
        const value = await computer(talkUrl, restartedCookie, botId);
        return value.ready && value.ownership === "view-only" && value.path === `/screen/${botId}/`;
      }, START_WAIT_MS, () => `restart did not restore view-only Computer; logs=${secondTalk?.logs() ?? ""}`);
      assertViewOnlyComputer(await computer(talkUrl, restartedCookie, botId), botId);
      assert.equal(
        tap.events.some((event) =>
          event.seq > restartMark.seq && event.requestPath?.includes("write=true")
        ),
        false,
      );

      checkpoint({
        phase: "reload-view-only",
        url: talkUrl,
        botId,
        expectedIframePath: `/screen/${botId}/`,
        instruction: "Reload the existing IAB tab, verify the same Bot is view-only, and keep the tab open until the next checkpoint.",
      });
      await waitUntil(() => tap!.events.some((event) =>
        event.kind === "upgrade-response"
        && event.httpStatus === 101
        && event.seq > restartMark.seq
      ), BROWSER_WAIT_MS, () => "the restarted view-only PWA did not establish a Screen Upgrade");
      const restartUpgrade = tap.events.find((event) =>
        event.kind === "upgrade-response"
        && event.httpStatus === 101
        && event.seq > restartMark.seq
      )!;
      assert.equal(
        tap.events.some((event) =>
          event.seq > restartMark.seq && event.requestPath?.includes("write=true")
        ),
        false,
      );

      checkpoint({
        phase: "close-browser",
        instruction: "Close only the live test IAB tab now. The test will observe both Screen Upgrade sides close before resource cleanup.",
      });
      await waitUntil(() => {
        const clientClosed = tap!.events.some((event) =>
          event.kind === "upgrade-client-close" && event.upgradeId === restartUpgrade.upgradeId
        );
        const upstreamClosed = tap!.events.some((event) =>
          event.kind === "upgrade-upstream-close" && event.upgradeId === restartUpgrade.upgradeId
        );
        return clientClosed && upstreamClosed;
      }, BROWSER_WAIT_MS, () => "the live Browser tab was not closed at the cleanup checkpoint");

      signalTalk(secondTalk, "SIGTERM");
      const secondExit = await bounded(secondTalk.exited, SHUTDOWN_WAIT_MS, () =>
        `restarted Talk did not close; logs=${secondTalk?.logs() ?? ""}`
      );
      assert.deepEqual(secondExit, { code: 0, signal: null });
    } catch (error) {
      bodyFailure = error;
    } finally {
      const cleanupFailures: unknown[] = [];
      for (const talk of [firstTalk, secondTalk]) {
        if (!talk) continue;
        try {
          await forceStopTalk(talk);
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      try {
        await tap?.close();
      } catch (error) {
        cleanupFailures.push(error);
      }
      const cleanupEnv = composeEnv ?? process.env;
      if (composeAttempted) {
        try {
          await cleanupOwnedCommand(
            "docker",
            [...composeArgs, "down", "--volumes", "--remove-orphans"],
            { description: "disposable Screen compose cleanup", env: cleanupEnv },
          );
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      if (dockerChecked) {
        for (const cleanup of [
          {
            args: ["container", "rm", "--force", container],
            description: "disposable Screen container cleanup",
            absentPattern: /No such (?:container|object)|not found/iu,
          },
          {
            args: ["network", "rm", network],
            description: "disposable Screen network cleanup",
            absentPattern: /No such network|not found/iu,
          },
          {
            args: ["image", "rm", image],
            description: "disposable Screen image cleanup",
            absentPattern: /No such image|not found/iu,
          },
        ]) {
          try {
            await cleanupOwnedCommand("docker", cleanup.args, {
              absentPattern: cleanup.absentPattern,
              description: cleanup.description,
              env: cleanupEnv,
            });
          } catch (error) {
            cleanupFailures.push(error);
          }
        }
      }
      if (runtime) {
        try {
          await rm(runtime, { recursive: true, force: true });
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      if (protectedSnapshotTaken) {
        try {
          assert.deepEqual(
            await sharedScreenSnapshot(process.env),
            protectedBefore,
            "protected Screen changed during live proof",
          );
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      if (bodyFailure && cleanupFailures.length > 0) {
        throw new AggregateError(
          [bodyFailure, ...cleanupFailures],
          "live Screen proof failed and cleanup did not complete cleanly",
        );
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(cleanupFailures, "live Screen cleanup did not complete cleanly");
      }
    }
    if (bodyFailure) throw bodyFailure;
  });
});
