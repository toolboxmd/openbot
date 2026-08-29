import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PASSWORD = "daemon-shutdown-test-password";
const KASM_DOCUMENT = "<!doctype html><html><head><title>KasmVNC</title></head><body>KasmVNC</body></html>";
const PRIVATE_FAILURE_PAYLOAD = "HH58-PRIVATE-SHUTDOWN-PAYLOAD";

type KasmWriteEvent = {
  write: boolean;
};

type ExitResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function bounded<T>(promise: Promise<T>, message: string, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
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

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("loopback fixture did not bind"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function writeFakeDocker(root: string): Promise<string> {
  const binDir = path.join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const docker = path.join(binDir, "docker");
  await writeFile(
    docker,
    `#!${process.execPath}\nif (process.argv[2] === "inspect") { process.stdout.write("true\\n"); process.exit(0); }\nprocess.stderr.write("unexpected docker command\\n");\nprocess.exit(97);\n`,
    "utf8",
  );
  await chmod(docker, 0o755);
  return binDir;
}

function exitOf(child: ChildProcessWithoutNullStreams): Promise<ExitResult> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function startProductionDaemon(input: {
  root: string;
  screenPort: number;
}): Promise<{
  child: ChildProcessWithoutNullStreams;
  url: string;
  stderr: () => string;
}> {
  const homeDir = path.join(input.root, "home");
  const workspaceDir = path.join(homeDir, "workspace");
  const cookiesDir = path.join(input.root, "cookies");
  const pwaDir = path.join(input.root, "pwa");
  await Promise.all([
    mkdir(workspaceDir, { recursive: true }),
    mkdir(cookiesDir, { recursive: true }),
    mkdir(pwaDir, { recursive: true }),
  ]);
  await writeFile(path.join(pwaDir, "index.html"), "<!doctype html><title>OpenBot test</title>", "utf8");
  const binDir = await writeFakeDocker(input.root);

  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(repoRoot, "daemon/src/index.ts")],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        HOST: "127.0.0.1",
        PORT: "0",
        OPENBOT_HOME: homeDir,
        OPENBOT_WORKSPACE: workspaceDir,
        OPENBOT_COOKIES: cookiesDir,
        OPENBOT_PASSWORD: PASSWORD,
        KASM_USER: "openbot",
        KASM_PASSWORD: PASSWORD,
        SCREEN_PORTS: String(input.screenPort),
        OPENBOT_SCREEN_CONTAINER: "openbot-daemon-shutdown-test",
        PWA_DIR: pwaDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-64 * 1024);
  });
  const started = new Promise<string>((resolve, reject) => {
    const onStdout = (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-64 * 1024);
      const match = stdout.match(/OpenBot box listening on (http:\/\/127\.0\.0\.1:\d+)/u);
      if (match) resolve(match[1]);
    };
    child.stdout.on("data", onStdout);
    child.once("exit", (code, signal) => {
      reject(new Error(`production daemon exited before listening: ${code ?? signal}; ${stderr}`));
    });
  });

  return {
    child,
    url: await bounded(started, "production daemon did not bind"),
    stderr: () => stderr,
  };
}

async function login(url: string): Promise<string> {
  const response = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  return cookie;
}

async function createWritableBot(url: string, cookie: string): Promise<{ id: string }> {
  const createdResponse = await fetch(`${url}/api/bots`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Shutdown Bot" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as { id: string; display: number };
  assert.equal(created.display, 1);

  const computerResponse = await fetch(
    `${url}/api/computer?botId=${encodeURIComponent(created.id)}`,
    { headers: { cookie } },
  );
  assert.equal(computerResponse.status, 200);
  const computer = await computerResponse.json() as { ownershipEpoch: string };
  assert.equal(typeof computer.ownershipEpoch, "string");

  const zoomResponse = await fetch(`${url}/api/computer/zoom`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      botId: created.id,
      zoom: true,
      ownershipEpoch: computer.ownershipEpoch,
    }),
  });
  assert.equal(zoomResponse.status, 200);
  const zoomed = await zoomResponse.json() as { write: boolean };
  assert.equal(zoomed.write, true);
  return created;
}

async function waitForViewOnlyComputer(
  url: string,
  cookie: string,
  botId: string,
): Promise<{
  botId: string;
  display: number | null;
  ownership: string;
  path: string | null;
  ready: boolean;
  screenState: string;
}> {
  return bounded((async () => {
    while (true) {
      const response = await fetch(
        `${url}/api/computer?botId=${encodeURIComponent(botId)}`,
        { headers: { cookie } },
      );
      assert.equal(response.status, 200);
      const computer = await response.json() as {
        botId: string;
        display: number | null;
        ownership: string;
        path: string | null;
        ready: boolean;
        screenState: string;
      };
      if (
        computer.botId === botId
        && computer.display === 1
        && computer.ownership === "view-only"
        && computer.path === `/screen/${botId}/`
        && computer.ready
        && computer.screenState === "ready"
      ) {
        return computer;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  })(), "restarted Computer did not become view-only");
}

function openScreenUpgrade(url: string, cookie: string, botId: string): Promise<net.Socket> {
  const target = new URL(url);
  return bounded(new Promise((resolve, reject) => {
    const socket = net.connect(Number(target.port), target.hostname);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write([
        `GET /screen/${encodeURIComponent(botId)}/websockify HTTP/1.1`,
        `Host: ${target.host}`,
        `Cookie: ${cookie}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: ZGFlbW9uLXNoaXBkb3du",
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (!response.includes("\r\n\r\n")) return;
      if (!response.startsWith("HTTP/1.1 101")) {
        reject(new Error(`Screen upgrade failed: ${response.slice(0, 200)}`));
        socket.destroy();
        return;
      }
      socket.removeAllListeners("data");
      resolve(socket);
    });
    socket.once("error", reject);
  }), "Screen upgrade did not connect");
}

function openPartialScreenUpgrade(
  url: string,
  cookie: string,
  botId: string,
): Promise<{
  socket: net.Socket;
  complete: () => void;
  upgraded: Promise<boolean>;
}> {
  const target = new URL(url);
  return bounded(new Promise((resolve, reject) => {
    const socket = net.connect(Number(target.port), target.hostname);
    const upgradeResult = deferred<boolean>();
    let resultSettled = false;
    let response = "";
    function settleUpgraded(value: boolean): void {
      if (resultSettled) return;
      resultSettled = true;
      upgradeResult.resolve(value);
    }
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response.includes("\r\n\r\n")) {
        settleUpgraded(response.startsWith("HTTP/1.1 101"));
      }
    });
    socket.once("close", () => settleUpgraded(false));
    socket.once("error", (error) => {
      settleUpgraded(false);
      reject(error);
    });
    socket.once("connect", () => {
      const partialHeaders = [
        `GET /screen/${encodeURIComponent(botId)}/websockify HTTP/1.1`,
        `Host: ${target.host}`,
        `Cookie: ${cookie}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: bGF0ZS11cGdyYWRlLXJhY2U=",
        "",
      ].join("\r\n");
      socket.write(partialHeaders, () => {
        resolve({
          socket,
          complete: () => {
            if (!socket.destroyed) socket.write("\r\n");
          },
          upgraded: upgradeResult.promise,
        });
      });
    });
  }), "partial Screen upgrade did not connect");
}

function openPipelinedScreenRequests(
  url: string,
  cookie: string,
  botId: string,
  firstBody: string,
  secondBody: string,
): Promise<{
  socket: net.Socket;
  firstComplete: Promise<boolean>;
  secondComplete: Promise<boolean>;
}> {
  const target = new URL(url);
  return bounded(new Promise((resolve, reject) => {
    const socket = net.connect(Number(target.port), target.hostname);
    const firstResult = deferred<boolean>();
    const secondResult = deferred<boolean>();
    let firstSettled = false;
    let secondSettled = false;
    let response = "";
    function settleFirst(value: boolean): void {
      if (firstSettled) return;
      firstSettled = true;
      firstResult.resolve(value);
    }
    function settleSecond(value: boolean): void {
      if (secondSettled) return;
      secondSettled = true;
      secondResult.resolve(value);
    }
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response.includes(firstBody)) settleFirst(true);
      if (response.includes(secondBody)) settleSecond(true);
    });
    socket.once("close", () => {
      settleFirst(response.includes(firstBody));
      settleSecond(response.includes(secondBody));
    });
    socket.once("error", (error) => {
      settleFirst(false);
      settleSecond(false);
      reject(error);
    });
    socket.once("connect", () => {
      const request = (screenPath: string) => [
        `GET /screen/${encodeURIComponent(botId)}/${screenPath} HTTP/1.1`,
        `Host: ${target.host}`,
        `Cookie: ${cookie}`,
        "Connection: keep-alive",
        "",
        "",
      ].join("\r\n");
      socket.write(`${request("pipeline-first")}${request("pipeline-second")}`, () => {
        resolve({
          socket,
          firstComplete: firstResult.promise,
          secondComplete: secondResult.promise,
        });
      });
    });
  }), "pipelined Screen requests did not connect");
}

function openScreenResponseThenUpgrade(
  url: string,
  cookie: string,
  botId: string,
  responseBody: string,
  completeUpgradeBeforeShutdown: boolean,
): Promise<{
  socket: net.Socket;
  completeUpgrade: () => void;
  responseComplete: Promise<boolean>;
  upgradeAccepted: Promise<boolean>;
}> {
  const target = new URL(url);
  return bounded(new Promise((resolve, reject) => {
    const socket = net.connect(Number(target.port), target.hostname);
    const responseResult = deferred<boolean>();
    const upgradeResult = deferred<boolean>();
    let responseSettled = false;
    let upgradeSettled = false;
    let received = "";
    function settleResponse(value: boolean): void {
      if (responseSettled) return;
      responseSettled = true;
      responseResult.resolve(value);
    }
    function settleUpgrade(value: boolean): void {
      if (upgradeSettled) return;
      upgradeSettled = true;
      upgradeResult.resolve(value);
    }
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.includes(responseBody)) settleResponse(true);
      if (received.includes("HTTP/1.1 101")) settleUpgrade(true);
    });
    socket.once("close", () => {
      settleResponse(received.includes(responseBody));
      settleUpgrade(received.includes("HTTP/1.1 101"));
    });
    socket.once("error", (error) => {
      settleResponse(false);
      settleUpgrade(false);
      reject(error);
    });
    socket.once("connect", () => {
      const ordinary = [
        `GET /screen/${encodeURIComponent(botId)}/mixed-response HTTP/1.1`,
        `Host: ${target.host}`,
        `Cookie: ${cookie}`,
        "Connection: keep-alive",
        "",
        "",
      ].join("\r\n");
      const partialUpgrade = [
        `GET /screen/${encodeURIComponent(botId)}/websockify HTTP/1.1`,
        `Host: ${target.host}`,
        `Cookie: ${cookie}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: bWl4ZWQtaHR0cC11cGdyYWRl",
        "",
      ].join("\r\n");
      socket.write(
        `${ordinary}${partialUpgrade}${completeUpgradeBeforeShutdown ? "\r\n" : ""}`,
        () => {
          resolve({
            socket,
            completeUpgrade: () => {
              if (!socket.destroyed) socket.write("\r\n");
            },
            responseComplete: responseResult.promise,
            upgradeAccepted: upgradeResult.promise,
          });
        },
      );
    });
  }), "mixed Screen response and Upgrade did not connect");
}

const cleanShutdownScenarios: Array<{ title: string; signals: NodeJS.Signals[] }> = [
  {
    title: "SIGINT revokes an active Kasm writer before the production daemon exits",
    signals: ["SIGINT"],
  },
  {
    title: "SIGTERM revokes an active Kasm writer before the production daemon exits",
    signals: ["SIGTERM"],
  },
  {
    title: "repeated concurrent shutdown signals revoke an active Kasm writer exactly once",
    signals: ["SIGINT", "SIGTERM", "SIGTERM"],
  },
];

for (const scenario of cleanShutdownScenarios) {
  test(scenario.title, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openbot-daemon-shutdown-"));
    const writeEvents: KasmWriteEvent[] = [];
    const upstreamSockets = new Set<import("node:stream").Duplex>();
    const kasm = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/update_user") {
        writeEvents.push({ write: url.searchParams.get("write") === "true" });
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(KASM_DOCUMENT);
    });
    kasm.on("upgrade", (_req, socket) => {
      upstreamSockets.add(socket);
      socket.once("close", () => upstreamSockets.delete(socket));
      socket.on("error", () => socket.destroy());
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    });

    let child: ChildProcessWithoutNullStreams | undefined;
    let upgraded: net.Socket | undefined;
    try {
      const screenPort = await listen(kasm);
      const daemon = await startProductionDaemon({ root, screenPort });
      child = daemon.child;
      const exited = exitOf(child);
      const cookie = await login(daemon.url);
      const bot = await createWritableBot(daemon.url, cookie);
      assert.equal(writeEvents.at(-1)?.write, true);
      const grantIndex = writeEvents.length - 1;
      upgraded = await openScreenUpgrade(daemon.url, cookie, bot.id);

      for (const signal of scenario.signals) assert.equal(child.kill(signal), true);
      const result = await bounded(exited, `production daemon did not exit; stderr: ${daemon.stderr()}`);
      assert.deepEqual(
        result,
        { code: 0, signal: null },
        `production daemon shutdown failed: ${daemon.stderr()}`,
      );
      assert.deepEqual(writeEvents.slice(grantIndex + 1), [{ write: false }]);
    } finally {
      upgraded?.destroy();
      for (const socket of upstreamSockets) socket.destroy();
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closeServer(kasm);
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("a connected Screen client closes after writer revoke and restart stays view-only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openbot-daemon-connected-restart-"));
  const writeEvents: KasmWriteEvent[] = [];
  const revokeSeen = deferred<void>();
  const allowRevoke = deferred<void>();
  const upstreamSockets = new Set<import("node:stream").Duplex>();
  let holdRevoke = false;
  const kasm = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/update_user") {
      const write = url.searchParams.get("write") === "true";
      writeEvents.push({ write });
      if (!write && holdRevoke) {
        revokeSeen.resolve();
        void allowRevoke.promise.then(() => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("ok");
        });
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(KASM_DOCUMENT);
  });
  kasm.on("upgrade", (_req, socket) => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  });

  let firstChild: ChildProcessWithoutNullStreams | undefined;
  let secondChild: ChildProcessWithoutNullStreams | undefined;
  let upgraded: net.Socket | undefined;
  try {
    const screenPort = await listen(kasm);
    const first = await startProductionDaemon({ root, screenPort });
    firstChild = first.child;
    const firstExited = exitOf(firstChild);
    const cookie = await login(first.url);
    const bot = await createWritableBot(first.url, cookie);
    assert.equal(writeEvents.at(-1)?.write, true);
    const grantIndex = writeEvents.length - 1;
    upgraded = await openScreenUpgrade(first.url, cookie, bot.id);
    const downstreamClosed = new Promise<void>((resolve) => upgraded?.once("close", resolve));
    holdRevoke = true;

    assert.equal(firstChild.kill("SIGTERM"), true);
    await bounded(revokeSeen.promise, "shutdown did not dispatch the Kasm revoke");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(upgraded.destroyed, false, "Screen client closed before writer revoke completed");
    assert.equal(upstreamSockets.size, 1, "Screen upstream closed before writer revoke completed");

    holdRevoke = false;
    allowRevoke.resolve();
    await bounded(downstreamClosed, "shutdown did not close the connected Screen client");
    const firstResult = await bounded(
      firstExited,
      `production daemon did not exit; stderr: ${first.stderr()}`,
    );
    assert.deepEqual(firstResult, { code: 0, signal: null });
    assert.deepEqual(writeEvents.slice(grantIndex + 1), [{ write: false }]);

    const second = await startProductionDaemon({ root, screenPort });
    secondChild = second.child;
    const secondExited = exitOf(secondChild);
    const computer = await waitForViewOnlyComputer(second.url, cookie, bot.id);
    assert.deepEqual({
      botId: computer.botId,
      display: computer.display,
      ownership: computer.ownership,
      path: computer.path,
      ready: computer.ready,
      screenState: computer.screenState,
    }, {
      botId: bot.id,
      display: 1,
      ownership: "view-only",
      path: `/screen/${bot.id}/`,
      ready: true,
      screenState: "ready",
    });
    assert.equal(writeEvents.slice(grantIndex + 1).some(({ write }) => write), false);

    assert.equal(secondChild.kill("SIGTERM"), true);
    const secondResult = await bounded(
      secondExited,
      `restarted production daemon did not exit; stderr: ${second.stderr()}`,
    );
    assert.deepEqual(secondResult, { code: 0, signal: null });
  } finally {
    allowRevoke.resolve();
    upgraded?.destroy();
    for (const socket of upstreamSockets) socket.destroy();
    if (firstChild && firstChild.exitCode === null && firstChild.signalCode === null) {
      firstChild.kill("SIGKILL");
    }
    if (secondChild && secondChild.exitCode === null && secondChild.signalCode === null) {
      secondChild.kill("SIGKILL");
    }
    await closeServer(kasm);
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup failure is sanitized, reported, and exits nonzero after one revoke attempt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openbot-daemon-shutdown-failure-"));
  const writeEvents: KasmWriteEvent[] = [];
  const upstreamSockets = new Set<import("node:stream").Duplex>();
  let failRevoke = false;
  const kasm = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/update_user") {
      const write = url.searchParams.get("write") === "true";
      writeEvents.push({ write });
      if (!write && failRevoke) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(PRIVATE_FAILURE_PAYLOAD);
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(KASM_DOCUMENT);
  });
  kasm.on("upgrade", (_req, socket) => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  });

  let child: ChildProcessWithoutNullStreams | undefined;
  let upgraded: net.Socket | undefined;
  try {
    const screenPort = await listen(kasm);
    const daemon = await startProductionDaemon({ root, screenPort });
    child = daemon.child;
    const exited = exitOf(child);
    const cookie = await login(daemon.url);
    const bot = await createWritableBot(daemon.url, cookie);
    assert.equal(writeEvents.at(-1)?.write, true);
    const grantIndex = writeEvents.length - 1;
    upgraded = await openScreenUpgrade(daemon.url, cookie, bot.id);
    failRevoke = true;

    assert.equal(child.kill("SIGTERM"), true);
    const result = await bounded(exited, `production daemon did not exit; stderr: ${daemon.stderr()}`);
    assert.deepEqual(result, { code: 1, signal: null });
    assert.deepEqual(writeEvents.slice(grantIndex + 1), [{ write: false }]);
    assert.match(daemon.stderr(), /OpenBot shutdown failed during cleanup\./u);
    assert.doesNotMatch(daemon.stderr(), new RegExp(PRIVATE_FAILURE_PAYLOAD, "u"));
    assert.doesNotMatch(daemon.stderr(), new RegExp(bot.id, "u"));
    assert.doesNotMatch(daemon.stderr(), new RegExp(PASSWORD, "u"));
  } finally {
    upgraded?.destroy();
    for (const socket of upstreamSockets) socket.destroy();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closeServer(kasm);
    await rm(root, { recursive: true, force: true });
  }
});

test("a Screen Upgrade completed after shutdown begins cannot escape Box cleanup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openbot-daemon-late-upgrade-"));
  const writeEvents: KasmWriteEvent[] = [];
  const revokeSeen = deferred<void>();
  const allowRevoke = deferred<void>();
  const upstreamSockets = new Set<import("node:stream").Duplex>();
  let delayRevoke = false;
  const kasm = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/update_user") {
      const write = url.searchParams.get("write") === "true";
      writeEvents.push({ write });
      if (!write && delayRevoke) {
        revokeSeen.resolve();
        void allowRevoke.promise.then(() => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("ok");
        });
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(KASM_DOCUMENT);
  });
  kasm.on("upgrade", (_req, socket) => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  });

  let child: ChildProcessWithoutNullStreams | undefined;
  let partial: Awaited<ReturnType<typeof openPartialScreenUpgrade>> | undefined;
  try {
    const screenPort = await listen(kasm);
    const daemon = await startProductionDaemon({ root, screenPort });
    child = daemon.child;
    const exited = exitOf(child);
    const cookie = await login(daemon.url);
    const bot = await createWritableBot(daemon.url, cookie);
    assert.equal(writeEvents.at(-1)?.write, true);
    const grantIndex = writeEvents.length - 1;
    partial = await openPartialScreenUpgrade(daemon.url, cookie, bot.id);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    delayRevoke = true;

    assert.equal(child.kill("SIGTERM"), true);
    await bounded(revokeSeen.promise, "shutdown did not dispatch the Kasm revoke");
    partial.complete();
    assert.equal(
      await bounded(partial.upgraded, "late Screen upgrade did not settle"),
      false,
      "Screen upgraded after Box shutdown began",
    );
    allowRevoke.resolve();
    const result = await bounded(exited, `production daemon did not exit; stderr: ${daemon.stderr()}`);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.deepEqual(writeEvents.slice(grantIndex + 1), [{ write: false }]);
  } finally {
    allowRevoke.resolve();
    partial?.socket.destroy();
    for (const socket of upstreamSockets) socket.destroy();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closeServer(kasm);
    await rm(root, { recursive: true, force: true });
  }
});

test("an accepted incomplete Screen Upgrade cannot keep production shutdown open", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openbot-daemon-incomplete-upgrade-"));
  const writeEvents: KasmWriteEvent[] = [];
  const kasm = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/update_user") {
      writeEvents.push({ write: url.searchParams.get("write") === "true" });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(KASM_DOCUMENT);
  });

  let child: ChildProcessWithoutNullStreams | undefined;
  let partial: Awaited<ReturnType<typeof openPartialScreenUpgrade>> | undefined;
  try {
    const screenPort = await listen(kasm);
    const daemon = await startProductionDaemon({ root, screenPort });
    child = daemon.child;
    const exited = exitOf(child);
    const cookie = await login(daemon.url);
    const bot = await createWritableBot(daemon.url, cookie);
    assert.equal(writeEvents.at(-1)?.write, true);
    const grantIndex = writeEvents.length - 1;
    partial = await openPartialScreenUpgrade(daemon.url, cookie, bot.id);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    assert.equal(child.kill("SIGTERM"), true);
    const result = await bounded(exited, `production daemon did not exit; stderr: ${daemon.stderr()}`);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(await bounded(partial.upgraded, "incomplete Screen upgrade did not close"), false);
    assert.deepEqual(writeEvents.slice(grantIndex + 1), [{ write: false }]);
  } finally {
    partial?.socket.destroy();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closeServer(kasm);
    await rm(root, { recursive: true, force: true });
  }
});

test("shutdown preserves an already-active ordinary Screen HTTP response", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openbot-daemon-active-http-"));
  const writeEvents: KasmWriteEvent[] = [];
  const revokeSeen = deferred<void>();
  const responseStarted = deferred<void>();
  const allowResponse = deferred<void>();
  let watchRevoke = false;
  const kasm = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/update_user") {
      const write = url.searchParams.get("write") === "true";
      writeEvents.push({ write });
      if (!write && watchRevoke) revokeSeen.resolve();
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (url.pathname === "/slow-response") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("before-");
      responseStarted.resolve();
      void allowResponse.promise.then(() => res.end("after"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(KASM_DOCUMENT);
  });

  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const screenPort = await listen(kasm);
    const daemon = await startProductionDaemon({ root, screenPort });
    child = daemon.child;
    const exited = exitOf(child);
    const cookie = await login(daemon.url);
    const bot = await createWritableBot(daemon.url, cookie);
    assert.equal(writeEvents.at(-1)?.write, true);
    const grantIndex = writeEvents.length - 1;
    watchRevoke = true;
    const responsePromise = fetch(`${daemon.url}/screen/${encodeURIComponent(bot.id)}/slow-response`, {
      headers: { cookie },
    });
    await bounded(responseStarted.promise, "ordinary Screen response did not start");
    const response = await bounded(responsePromise, "ordinary Screen response headers did not arrive");
    assert.equal(response.status, 200);

    assert.equal(child.kill("SIGTERM"), true);
    await bounded(revokeSeen.promise, "shutdown did not dispatch the Kasm revoke");
    allowResponse.resolve();
    assert.equal(await bounded(response.text(), "ordinary Screen response did not finish"), "before-after");
    const result = await bounded(exited, `production daemon did not exit; stderr: ${daemon.stderr()}`);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.deepEqual(writeEvents.slice(grantIndex + 1), [{ write: false }]);
  } finally {
    allowResponse.resolve();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closeServer(kasm);
    await rm(root, { recursive: true, force: true });
  }
});

test("shutdown preserves every active pipelined Screen HTTP response on one socket", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openbot-daemon-pipelined-http-"));
  const firstBody = "first-pipelined-screen-response";
  const secondBody = "second-pipelined-screen-response";
  const writeEvents: KasmWriteEvent[] = [];
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const allowFirst = deferred<void>();
  const allowSecond = deferred<void>();
  const revokeSeen = deferred<void>();
  const allowRevoke = deferred<void>();
  let watchRevoke = false;
  const kasm = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/update_user") {
      const write = url.searchParams.get("write") === "true";
      writeEvents.push({ write });
      if (!write && watchRevoke) {
        revokeSeen.resolve();
        void allowRevoke.promise.then(() => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("ok");
        });
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (url.pathname === "/pipeline-first") {
      firstStarted.resolve();
      void allowFirst.promise.then(() => {
        res.writeHead(200, {
          "content-length": Buffer.byteLength(firstBody),
          "content-type": "text/plain",
        });
        res.end(firstBody);
      });
      return;
    }
    if (url.pathname === "/pipeline-second") {
      secondStarted.resolve();
      void allowSecond.promise.then(() => {
        res.writeHead(200, {
          "content-length": Buffer.byteLength(secondBody),
          "content-type": "text/plain",
        });
        res.end(secondBody);
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(KASM_DOCUMENT);
  });

  let child: ChildProcessWithoutNullStreams | undefined;
  let pipeline: Awaited<ReturnType<typeof openPipelinedScreenRequests>> | undefined;
  try {
    const screenPort = await listen(kasm);
    const daemon = await startProductionDaemon({ root, screenPort });
    child = daemon.child;
    const exited = exitOf(child);
    const cookie = await login(daemon.url);
    const bot = await createWritableBot(daemon.url, cookie);
    assert.equal(writeEvents.at(-1)?.write, true);
    const grantIndex = writeEvents.length - 1;
    pipeline = await openPipelinedScreenRequests(
      daemon.url,
      cookie,
      bot.id,
      firstBody,
      secondBody,
    );
    await Promise.all([
      bounded(firstStarted.promise, "first pipelined Screen handler did not start"),
      bounded(secondStarted.promise, "second pipelined Screen handler did not start"),
    ]);
    allowFirst.resolve();
    assert.equal(await bounded(pipeline.firstComplete, "first pipelined response did not finish"), true);
    watchRevoke = true;

    assert.equal(child.kill("SIGTERM"), true);
    await bounded(revokeSeen.promise, "shutdown did not dispatch the Kasm revoke");
    allowSecond.resolve();
    allowRevoke.resolve();
    assert.equal(
      await bounded(pipeline.secondComplete, "second pipelined response did not settle"),
      true,
      "shutdown truncated an already-active pipelined Screen response",
    );
    const result = await bounded(exited, `production daemon did not exit; stderr: ${daemon.stderr()}`);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.deepEqual(writeEvents.slice(grantIndex + 1), [{ write: false }]);
  } finally {
    allowFirst.resolve();
    allowSecond.resolve();
    allowRevoke.resolve();
    pipeline?.socket.destroy();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closeServer(kasm);
    await rm(root, { recursive: true, force: true });
  }
});

const mixedUpgradeScenarios: Array<{
  title: string;
  completeUpgradeAfterShutdown: boolean;
}> = [
  {
    title: "a pipelined Screen Upgrade cannot override an active ordinary response",
    completeUpgradeAfterShutdown: false,
  },
  {
    title: "a late Screen Upgrade on an active-response socket closes after that response",
    completeUpgradeAfterShutdown: true,
  },
];

for (const scenario of mixedUpgradeScenarios) {
  test(scenario.title, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openbot-daemon-mixed-upgrade-"));
    const responseBody = "protected-ordinary-screen-response";
    const writeEvents: KasmWriteEvent[] = [];
    const responseStarted = deferred<void>();
    const allowResponse = deferred<void>();
    const revokeSeen = deferred<void>();
    const allowRevoke = deferred<void>();
    const upstreamSockets = new Set<import("node:stream").Duplex>();
    let upstreamUpgradeCount = 0;
    let watchRevoke = false;
    const kasm = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/update_user") {
        const write = url.searchParams.get("write") === "true";
        writeEvents.push({ write });
        if (!write && watchRevoke) {
          revokeSeen.resolve();
          void allowRevoke.promise.then(() => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("ok");
          });
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      if (url.pathname === "/mixed-response") {
        responseStarted.resolve();
        void allowResponse.promise.then(() => {
          res.writeHead(200, {
            "content-length": Buffer.byteLength(responseBody),
            "content-type": "text/plain",
          });
          res.end(responseBody);
        });
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(KASM_DOCUMENT);
    });
    kasm.on("upgrade", (_req, socket) => {
      upstreamUpgradeCount += 1;
      upstreamSockets.add(socket);
      socket.once("close", () => upstreamSockets.delete(socket));
      socket.on("error", () => socket.destroy());
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    });

    let child: ChildProcessWithoutNullStreams | undefined;
    let mixed: Awaited<ReturnType<typeof openScreenResponseThenUpgrade>> | undefined;
    try {
      const screenPort = await listen(kasm);
      const daemon = await startProductionDaemon({ root, screenPort });
      child = daemon.child;
      const exited = exitOf(child);
      const cookie = await login(daemon.url);
      const bot = await createWritableBot(daemon.url, cookie);
      assert.equal(writeEvents.at(-1)?.write, true);
      const grantIndex = writeEvents.length - 1;
      mixed = await openScreenResponseThenUpgrade(
        daemon.url,
        cookie,
        bot.id,
        responseBody,
        !scenario.completeUpgradeAfterShutdown,
      );
      await bounded(responseStarted.promise, "ordinary Screen handler did not start");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      watchRevoke = true;

      assert.equal(child.kill("SIGTERM"), true);
      await bounded(revokeSeen.promise, "shutdown did not dispatch the Kasm revoke");
      if (scenario.completeUpgradeAfterShutdown) mixed.completeUpgrade();
      allowResponse.resolve();
      allowRevoke.resolve();
      assert.equal(
        await bounded(mixed.responseComplete, "ordinary Screen response did not settle"),
        true,
        "mixed Upgrade truncated an already-active ordinary Screen response",
      );
      assert.equal(await bounded(mixed.upgradeAccepted, "mixed Upgrade did not settle"), false);
      const result = await bounded(exited, `production daemon did not exit; stderr: ${daemon.stderr()}`);
      assert.deepEqual(
        result,
        { code: 0, signal: null },
        `production daemon shutdown failed: ${daemon.stderr()}`,
      );
      assert.equal(upstreamUpgradeCount, 0, "mixed Upgrade reached the upstream Screen");
      assert.deepEqual(writeEvents.slice(grantIndex + 1), [{ write: false }]);
    } finally {
      allowResponse.resolve();
      allowRevoke.resolve();
      mixed?.socket.destroy();
      for (const socket of upstreamSockets) socket.destroy();
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closeServer(kasm);
      await rm(root, { recursive: true, force: true });
    }
  });
}
