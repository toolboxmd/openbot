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
import {
  immutableDockerRemovalArgs,
  LIVE_LABEL,
  OwnedCommandError,
  RUN_LABEL,
  runOwnedCommand,
  validateOwnedDockerSet,
  type DockerContainerInspect,
  type DockerImageInspect,
  type DockerNetworkInspect,
  type DockerOwnershipInput,
  type ExpectedDockerOwnership,
  type OwnedCommandResult,
} from "./live-screen-fixture.ts";

const LIVE_GRANT = "connected-pwa-shutdown";
const PASSWORD = "openbot-screen-live";
const BROWSER_WAIT_MS = 300_000;
const START_WAIT_MS = 300_000;
const SHUTDOWN_WAIT_MS = 30_000;
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

async function dockerAvailable(env: NodeJS.ProcessEnv): Promise<void> {
  await runOwnedCommand("docker", ["info"], {
    description: "Docker availability check",
    env,
    timeoutMs: DOCKER_INSPECT_WAIT_MS,
  });
}

const DOCKER_MISSING = {
  container: /No such (?:container|object)|not found/iu,
  image: /No such image|not found/iu,
  network: /No such network|not found/iu,
} as const;

async function optionalDockerInspect<T>(
  kind: keyof typeof DOCKER_MISSING,
  target: string,
  env: NodeJS.ProcessEnv,
): Promise<T | undefined> {
  let inspect: OwnedCommandResult;
  try {
    inspect = await runOwnedCommand("docker", [kind, "inspect", target], {
      description: `${kind} inspection for ${target}`,
      env,
      timeoutMs: DOCKER_INSPECT_WAIT_MS,
    });
  } catch (error) {
    if (
      error instanceof OwnedCommandError
      && error.result.code !== null
      && DOCKER_MISSING[kind].test(`${error.result.stdout}\n${error.result.stderr}`)
    ) {
      return undefined;
    }
    throw error;
  }
  const rows = JSON.parse(inspect.stdout) as T[];
  assert.equal(rows.length, 1, `${kind} inspection for ${target} returned ${rows.length} records`);
  return rows[0];
}

function sortedEntries(value: Record<string, unknown> | undefined): Array<[string, unknown]> {
  return Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right));
}

type ProtectedScreenSnapshot = {
  container: {
    configImage: unknown;
    id: unknown;
    imageId: unknown;
    labels: Array<[string, unknown]>;
    mounts: unknown[];
    name: unknown;
    networks: unknown[];
    ports: Array<[string, unknown]>;
    restartCount: unknown;
    restartPolicy: unknown;
    state: unknown;
  } | null;
  image: {
    id: unknown;
    labels: Array<[string, unknown]>;
    repoDigests: unknown[];
    repoTags: unknown[];
  } | null;
  networks: Array<{
    containers: Array<[string, unknown]>;
    id: unknown;
    labels: Array<[string, unknown]>;
    name: unknown;
  }>;
};

async function sharedScreenSnapshot(env: NodeJS.ProcessEnv): Promise<ProtectedScreenSnapshot> {
  const row = await optionalDockerInspect<{
    Config?: { Image?: unknown; Labels?: Record<string, unknown> };
    HostConfig?: { PortBindings?: Record<string, unknown>; RestartPolicy?: unknown };
    Id?: unknown;
    Image?: unknown;
    Mounts?: Array<{
      Destination?: unknown;
      Driver?: unknown;
      Mode?: unknown;
      Name?: unknown;
      Propagation?: unknown;
      RW?: unknown;
      Source?: unknown;
      Type?: unknown;
    }>;
    Name?: unknown;
    NetworkSettings?: { Networks?: Record<string, Record<string, unknown>> };
    RestartCount?: unknown;
    State?: Record<string, unknown>;
  }>("container", "openbot-screen", env);
  const image = await optionalDockerInspect<{
    Config?: { Labels?: Record<string, unknown> };
    Id?: unknown;
    RepoDigests?: unknown[];
    RepoTags?: unknown[];
  }>("image", "openbot-screen:latest", env);
  const networkAttachments = Object.entries(row?.NetworkSettings?.Networks ?? {})
    .sort(([left], [right]) => left.localeCompare(right));
  const networks = await Promise.all(networkAttachments.map(async ([, attachment]) => {
    const networkId = String(attachment.NetworkID ?? "");
    assert.notEqual(networkId, "", "protected Screen network has no immutable ID");
    const network = await optionalDockerInspect<{
      Containers?: Record<string, unknown> | null;
      Id?: unknown;
      Labels?: Record<string, unknown>;
      Name?: unknown;
    }>("network", networkId, env);
    assert.ok(network, `protected Screen network ${networkId} disappeared during inspection`);
    return {
      containers: sortedEntries(network.Containers ?? undefined),
      id: network.Id,
      labels: sortedEntries(network.Labels),
      name: network.Name,
    };
  }));
  return {
    container: row
      ? {
        configImage: row.Config?.Image,
        id: row.Id,
        imageId: row.Image,
        labels: sortedEntries(row.Config?.Labels),
        mounts: (row.Mounts ?? [])
          .map((mount) => ({
            destination: mount.Destination,
            driver: mount.Driver,
            mode: mount.Mode,
            name: mount.Name,
            propagation: mount.Propagation,
            rw: mount.RW,
            source: mount.Source,
            type: mount.Type,
          }))
          .sort((left, right) =>
            String(left.destination).localeCompare(String(right.destination))
            || String(left.source).localeCompare(String(right.source))
          ),
        name: row.Name,
        networks: networkAttachments.map(([name, value]) => ({
          endpointId: value.EndpointID,
          globalIpv6Address: value.GlobalIPv6Address,
          ipAddress: value.IPAddress,
          macAddress: value.MacAddress,
          name,
          networkId: value.NetworkID,
        })),
        ports: sortedEntries(row.HostConfig?.PortBindings),
        restartCount: row.RestartCount,
        restartPolicy: row.HostConfig?.RestartPolicy,
        state: row.State,
      }
      : null,
    image: image
      ? {
        id: image.Id,
        labels: sortedEntries(image.Config?.Labels),
        repoDigests: [...(image.RepoDigests ?? [])].sort(),
        repoTags: [...(image.RepoTags ?? [])].sort(),
      }
      : null,
    networks: networks.sort((left, right) => String(left.id).localeCompare(String(right.id))),
  };
}

function protectedDockerIds(snapshot: ProtectedScreenSnapshot): {
  containerId: string | null;
  imageIds: string[];
  networkIds: string[];
} {
  return {
    containerId: typeof snapshot.container?.id === "string" ? snapshot.container.id : null,
    imageIds: [snapshot.container?.imageId, snapshot.image?.id]
      .filter((value): value is string => typeof value === "string"),
    networkIds: snapshot.networks
      .map((network) => network.id)
      .filter((value): value is string => typeof value === "string"),
  };
}

async function inspectOwnedDockerInput(
  expected: ExpectedDockerOwnership,
  env: NodeJS.ProcessEnv,
): Promise<DockerOwnershipInput> {
  const [container, image, network] = await Promise.all([
    optionalDockerInspect<DockerContainerInspect>("container", expected.containerName, env),
    optionalDockerInspect<DockerImageInspect>("image", expected.imageName, env),
    optionalDockerInspect<DockerNetworkInspect>("network", expected.networkName, env),
  ]);
  return {
    ...(container ? { container } : {}),
    ...(image ? { image } : {}),
    ...(network ? { network } : {}),
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

async function assertDockerTargetsAbsent(
  kind: keyof typeof DOCKER_MISSING,
  targets: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  for (const target of new Set(targets)) {
    assert.equal(
      await optionalDockerInspect(kind, target, env),
      undefined,
      `${kind} target survived cleanup: ${target}`,
    );
  }
}

async function cleanupOwnedDockerResources(
  expected: ExpectedDockerOwnership,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  let owned = validateOwnedDockerSet(
    await inspectOwnedDockerInput(expected, env),
    expected,
    { requireComplete: false },
  );
  if (owned.containerId) {
    await cleanupOwnedCommand("docker", immutableDockerRemovalArgs("container", owned.containerId), {
      absentPattern: DOCKER_MISSING.container,
      description: "disposable Screen container cleanup",
      env,
    });
    await assertDockerTargetsAbsent(
      "container",
      [owned.containerId, expected.containerName],
      env,
    );
  }

  owned = validateOwnedDockerSet(
    await inspectOwnedDockerInput(expected, env),
    expected,
    { requireComplete: false },
  );
  if (owned.networkId) {
    await cleanupOwnedCommand("docker", immutableDockerRemovalArgs("network", owned.networkId), {
      absentPattern: DOCKER_MISSING.network,
      description: "disposable Screen network cleanup",
      env,
    });
    await assertDockerTargetsAbsent("network", [owned.networkId, expected.networkName], env);
  }

  owned = validateOwnedDockerSet(
    await inspectOwnedDockerInput(expected, env),
    expected,
    { requireComplete: false },
  );
  if (owned.imageId) {
    await cleanupOwnedCommand("docker", immutableDockerRemovalArgs("image", owned.imageId), {
      absentPattern: DOCKER_MISSING.image,
      description: "disposable Screen image cleanup",
      env,
    });
    await assertDockerTargetsAbsent("image", [owned.imageId, expected.imageName], env);
  }

  assert.deepEqual(
    validateOwnedDockerSet(
      await inspectOwnedDockerInput(expected, env),
      expected,
      { requireComplete: false },
    ),
    {},
    "disposable Docker resources survived cleanup",
  );
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
    let protectedBefore: ProtectedScreenSnapshot | undefined;
    let protectedSnapshotTaken = false;
    let dockerChecked = false;
    let dockerOwnership: ExpectedDockerOwnership | undefined;
    let tap: Awaited<ReturnType<typeof startScreenTap>> | undefined;
    let firstTalk: TalkProcess | undefined;
    let secondTalk: TalkProcess | undefined;
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
      const protectedIds = protectedDockerIds(protectedBefore);
      dockerOwnership = {
        containerName: container,
        imageName: image,
        liveLabel: LIVE_GRANT,
        networkName: network,
        protectedContainerId: protectedIds.containerId,
        protectedImageIds: protectedIds.imageIds,
        protectedNetworkIds: protectedIds.networkIds,
        runLabel: nonce,
      };
      assert.deepEqual(
        await inspectOwnedDockerInput(dockerOwnership, process.env),
        {},
        "disposable Docker names were already in use",
      );
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
      const liveLabels = { [LIVE_LABEL]: LIVE_GRANT, [RUN_LABEL]: nonce };
      await writeFile(override, JSON.stringify({
        services: {
          screen: {
            build: { labels: liveLabels },
            container_name: container,
            image,
            restart: "no",
            labels: liveLabels,
          },
        },
        networks: { default: { labels: liveLabels, name: network } },
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
      const composeConfigResult = await runOwnedCommand(
        "docker",
        [...composeArgs, "config", "--format", "json"],
        {
          description: "disposable Screen compose ownership preflight",
          env: composeEnv,
          timeoutMs: DOCKER_INSPECT_WAIT_MS,
        },
      );
      const composeConfig = JSON.parse(composeConfigResult.stdout) as {
        networks?: { default?: { labels?: Record<string, string>; name?: string } };
        services?: {
          screen?: {
            build?: { labels?: Record<string, string> };
            container_name?: string;
            image?: string;
            labels?: Record<string, string>;
            restart?: string;
          };
        };
      };
      assert.deepEqual(composeConfig.services?.screen?.build?.labels, liveLabels);
      assert.equal(composeConfig.services?.screen?.container_name, container);
      assert.equal(composeConfig.services?.screen?.image, image);
      assert.deepEqual(composeConfig.services?.screen?.labels, liveLabels);
      assert.equal(composeConfig.services?.screen?.restart, "no");
      assert.deepEqual(composeConfig.networks?.default?.labels, liveLabels);
      assert.equal(composeConfig.networks?.default?.name, network);
      await runOwnedCommand(
        "docker",
        [...composeArgs, "up", "--detach", "--build", "--force-recreate", "screen"],
        {
          description: "disposable Screen compose build and start",
          env: composeEnv,
          timeoutMs: DOCKER_BUILD_WAIT_MS,
        },
      );
      validateOwnedDockerSet(
        await inspectOwnedDockerInput(dockerOwnership, composeEnv),
        dockerOwnership,
        { requireComplete: true },
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
      if (dockerChecked && dockerOwnership) {
        try {
          await cleanupOwnedDockerResources(dockerOwnership, cleanupEnv);
        } catch (error) {
          cleanupFailures.push(error);
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
