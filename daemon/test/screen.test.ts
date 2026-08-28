import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { after, before, describe, mock, test } from "node:test";
import { startBox, type RunningBox } from "../src/box.ts";
import { DISPLAY_BIN, DockerComputerRuntime, MemoryComputerRuntime } from "../src/computer.ts";
import { HomeStore, defaultWorkspaceDir } from "../src/home.ts";

const PASSWORD = "correct-horse";
const KASM_USER = "kasm";
const KASM_PASSWORD = "kasm-secret";

function cookieHeader(res: Response): string {
  return res.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

async function login(url: string): Promise<string> {
  const res = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.ok(res.ok, `login failed: ${res.status}`);
  const cookie = cookieHeader(res);
  assert.ok(cookie, "login did not return a cookie");
  return cookie;
}

async function emptyPwa(): Promise<string> {
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-pwa-"));
  await writeFile(join(pwaDir, "index.html"), `<!doctype html><title>OpenBot</title>`);
  return pwaDir;
}

function kasmDocumentOfBytes(bytes: number): string {
  const prefix = "<!doctype html><html><head><title>KasmVNC</title></head><body>";
  const suffix = "</body></html>";
  const padding = bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  assert.ok(padding >= 0, "Kasm fixture size must cover its required markup");
  const body = `${prefix}${"x".repeat(padding)}${suffix}`;
  assert.equal(Buffer.byteLength(body), bytes);
  return body;
}

async function publicReadinessForDocument(document: string): Promise<{ reachable?: boolean; ready?: boolean }> {
  const stub = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(document);
  });
  await new Promise<void>((resolve, reject) => {
    stub.once("error", reject);
    stub.listen(0, "127.0.0.1", () => resolve());
  });
  const address = stub.address();
  if (!address || typeof address === "string") throw new Error("readiness document stub failed to bind");
  let box: RunningBox | undefined;
  try {
    box = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      screenUpstream: `http://127.0.0.1:${address.port}`,
      homeDir: await mkdtemp(join(tmpdir(), "openbot-document-readiness-home-")),
    });
    const cookie = await login(box.url);
    const api = await fetch(`${box.url}/api/computer`, { headers: { cookie } });
    assert.equal(api.status, 200);
    return api.json() as Promise<{ reachable?: boolean; ready?: boolean }>;
  } finally {
    await box?.close();
    await closeHttpServer(stub);
  }
}

async function startReadyKasmFixture(): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><title>KasmVNC</title></html>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Kasm fixture failed to bind");
  return { port: address.port, server };
}

async function closeHttpServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitForPath(file: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`fixture did not publish ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fixture process ${pid} survived cleanup`);
}

async function waitForComputerScreenState(
  url: string,
  cookie: string,
  botId: string,
  expected: string,
): Promise<Record<string, unknown>> {
  // Test-only contention margin for background persisted Screen recovery.
  const deadline = Date.now() + 5_000;
  let observed: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/computer?botId=${encodeURIComponent(botId)}`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    observed = (await response.json()) as Record<string, unknown>;
    if (observed.screenState === expected) return observed;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Screen did not settle as ${expected}: ${JSON.stringify(observed)}`);
}

describe("Computer Screen HTTP", () => {
  let box: RunningBox;
  let stub: http.Server;
  let lastAuth: string | undefined;
  let lastPath: string | undefined;
  let computer: MemoryComputerRuntime;
  let adaId = "";
  let benId = "";

  before(async () => {
    stub = http.createServer((req, res) => {
      lastAuth = req.headers.authorization;
      lastPath = req.url;
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "www-authenticate": "Basic realm=kasm",
        "cross-origin-embedder-policy": "require-corp",
        "cross-origin-opener-policy": "same-origin",
      });
      res.end("<html><title>KasmVNC</title><body>desktop-stub</body></html>");
    });
    stub.on("upgrade", (req, socket) => {
      lastAuth = req.headers.authorization;
      lastPath = req.url;
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      socket.end();
    });
    await new Promise<void>((resolve, reject) => {
      stub.once("error", reject);
      stub.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = stub.address();
    if (!addr || typeof addr === "string") throw new Error("stub failed to bind");
    const upstream = `http://127.0.0.1:${addr.port}`;
    const cookiesDir = join(await mkdtemp(join(tmpdir(), "openbot-screen-cookies-")), "cookies");
    await mkdir(cookiesDir, { recursive: true });
    computer = new MemoryComputerRuntime({
      cookiesDir,
      upstreams: [upstream, `${upstream}`],
    });
    box = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      screenUpstream: upstream,
      kasmUser: KASM_USER,
      kasmPassword: KASM_PASSWORD,
      homeDir: await mkdtemp(join(tmpdir(), "openbot-screen-home-")),
      computer,
    });
    const cookie = await login(box.url);
    const ada = await fetch(`${box.url}/api/bots`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada" }),
    });
    const ben = await fetch(`${box.url}/api/bots`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Ben" }),
    });
    adaId = ((await ada.json()) as { id: string }).id;
    benId = ((await ben.json()) as { id: string }).id;
  });

  after(async () => {
    await box.close();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  test("Computer API and Screen path need a session", async () => {
    const api = await fetch(`${box.url}/api/computer`);
    assert.ok(api.status >= 400, `unauthenticated /api/computer should fail, got ${api.status}`);
    const screen = await fetch(`${box.url}/screen/`);
    assert.ok(screen.status >= 400, `unauthenticated /screen/ should fail, got ${screen.status}`);
  });

  test("session can read Computer and open Screen under the same origin", async () => {
    const cookie = await login(box.url);
    const api = await fetch(`${box.url}/api/computer`, { headers: { cookie } });
    assert.ok(api.ok, `GET /api/computer failed: ${api.status}`);
    const body = (await api.json()) as { path?: string; ready?: boolean };
    assert.equal(body.path, "/screen/");
    assert.equal(body.ready, true);

    lastAuth = undefined;
    const screen = await fetch(`${box.url}/screen/`, { headers: { cookie } });
    assert.ok(screen.ok, `GET /screen/ failed: ${screen.status}`);
    const html = await screen.text();
    assert.match(html, /desktop-stub/);
    assert.doesNotMatch(html, /kasm-secret/);
    assert.equal(lastPath, "/");
    const expected = `Basic ${Buffer.from(`${KASM_USER}:${KASM_PASSWORD}`).toString("base64")}`;
    assert.equal(lastAuth, expected);
    const www = screen.headers.get("www-authenticate");
    assert.equal(www, null, "Kasm basic-auth challenge must not reach the browser");
    assert.equal(screen.headers.get("cross-origin-embedder-policy"), null);
    assert.equal(screen.headers.get("cross-origin-opener-policy"), null);
  });

  test("Talk does not disable clipboard via Permissions-Policy", async () => {
    const cookie = await login(box.url);
    const pwa = await fetch(`${box.url}/`, { headers: { cookie } });
    assert.ok(pwa.ok, `GET / failed: ${pwa.status}`);
    const screen = await fetch(`${box.url}/screen/`, { headers: { cookie } });
    assert.ok(screen.ok, `GET /screen/ failed: ${screen.status}`);
    for (const res of [pwa, screen]) {
      const policy = `${res.headers.get("permissions-policy") ?? ""} ${res.headers.get("feature-policy") ?? ""}`;
      assert.doesNotMatch(policy, /clipboard-(?:read|write)\s*=\s*\(\)/);
    }
  });

  test("session WebSocket upgrade is proxied with basic auth", async () => {
    const cookie = await login(box.url);
    lastAuth = undefined;
    lastPath = undefined;
    const dest = new URL(box.url);
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: dest.hostname,
          port: dest.port,
          path: "/screen/websockify",
          method: "GET",
          headers: {
            cookie,
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
          },
        },
        (res) => {
          reject(new Error(`expected upgrade, got ${res.statusCode}`));
        },
      );
      req.on("upgrade", (res, socket) => {
        try {
          assert.equal(res.statusCode, 101);
          assert.equal(lastPath, "/websockify");
          const expected = `Basic ${Buffer.from(`${KASM_USER}:${KASM_PASSWORD}`).toString("base64")}`;
          assert.equal(lastAuth, expected);
          socket.destroy();
          resolve();
        } catch (error) {
          socket.destroy();
          reject(error);
        }
      });
      req.on("error", reject);
      req.end();
    });
  });

  test("Kasm UI assets under /screen/ are not treated as Bot ids", async () => {
    const cookie = await login(box.url);
    lastPath = undefined;
    const asset = await fetch(`${box.url}/screen/assets/ui-BOjwDkC7.js`, { headers: { cookie } });
    assert.ok(asset.ok, `GET /screen/assets/ui.js failed: ${asset.status}`);
    assert.equal(lastPath, "/assets/ui-BOjwDkC7.js");
    lastPath = undefined;
    const css = await fetch(`${box.url}/screen/openbot.css`, { headers: { cookie } });
    assert.ok(css.ok, `GET /screen/openbot.css failed: ${css.status}`);
    assert.equal(lastPath, "/openbot.css");
  });

  test("Bot Screen assets stay on that Bot's Kasm path", async () => {
    const cookie = await login(box.url);
    lastPath = undefined;
    const asset = await fetch(`${box.url}/screen/${adaId}/assets/ui.js`, { headers: { cookie } });
    assert.ok(asset.ok, `GET /screen/{bot}/assets/ui.js failed: ${asset.status}`);
    assert.equal(lastPath, "/assets/ui.js");
  });

  test("two Bots proxy to their own display paths on one Computer", async () => {
    const cookie = await login(box.url);
    const ada = await fetch(`${box.url}/api/computer?botId=${encodeURIComponent(adaId)}`, { headers: { cookie } });
    const ben = await fetch(`${box.url}/api/computer?botId=${encodeURIComponent(benId)}`, { headers: { cookie } });
    const adaBody = (await ada.json()) as { path?: string; ready?: boolean; display?: number; container?: string };
    const benBody = (await ben.json()) as { path?: string; ready?: boolean; display?: number; container?: string };
    assert.equal(adaBody.ready, true);
    assert.equal(benBody.ready, true);
    assert.equal(adaBody.path, `/screen/${adaId}/`);
    assert.equal(benBody.path, `/screen/${benId}/`);
    assert.equal(adaBody.display, 1);
    assert.equal(benBody.display, 2);
    assert.equal(adaBody.container, benBody.container);
    assert.equal(computer.commands.filter((args) => args[0] === "run").length, 0);
  });
});

test("public Bot creation compensates a Docker timeout and retries the intended display", async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-docker-timeout-public-"));
  const binDir = join(root, "bin");
  const docker = join(binDir, "docker");
  const childReady = join(root, "docker-child.json");
  const homeDir = join(root, "home");
  const workspaceDir = defaultWorkspaceDir(homeDir);
  const pwaDir = join(root, "pwa");
  const kasm = await startReadyKasmFixture();
  let box: RunningBox | undefined;
  let timedOutPid = 0;

  try {
    await mkdir(binDir, { recursive: true });
    await mkdir(pwaDir, { recursive: true });
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    await writeFile(
      docker,
      `#!${process.execPath}\nconst { writeFileSync } = require("node:fs"); writeFileSync(process.env.OPENBOT_DOCKER_CHILD_READY, JSON.stringify({ pid: process.pid })); setInterval(() => {}, 60_000);\n`,
      { mode: 0o755 },
    );
    const computer = new DockerComputerRuntime({
      hostPorts: [kasm.port],
      cookiesDir: join(root, "cookies"),
      env: {
        ...process.env,
        OPENBOT_DOCKER_CHILD_READY: childReady,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      },
    });
    box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      workspaceDir,
      computer,
    });
    const cookie = await login(box.url);
    const failed = await fetch(`${box.url}/api/bots`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Timed out Bot" }),
    });
    await waitForPath(childReady);
    timedOutPid = (JSON.parse(await readFile(childReady, "utf8")) as { pid: number }).pid;
    await waitForPidExit(timedOutPid);
    const failedBody = (await failed.json()) as {
      error?: string;
      code?: string;
      recoverable?: boolean;
    };
    assert.equal(failed.status, 503);
    assert.deepEqual(failedBody, {
      error: "docker inspect timed out after 5 seconds; verify Docker is responsive and retry",
      code: "DOCKER_COMMAND_TIMEOUT",
      recoverable: true,
    });

    const listedAfterFailure = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
    assert.deepEqual(await listedAfterFailure.json(), { bots: [] });
    assert.deepEqual(computer.commands, [["inspect", "--format", "{{.State.Running}}", "openbot-screen"]]);
    assert.deepEqual(await readdir(join(workspaceDir, "bots")), []);
    const failedHome = new HomeStore(homeDir);
    assert.deepEqual(failedHome.listBots(), []);
    assert.deepEqual(failedHome.listBotProvisionings(), []);
    failedHome.close();

    await writeFile(
      docker,
      `#!${process.execPath}\nsetTimeout(() => process.stdout.write("true\\n"), 150);\n`,
      { mode: 0o755 },
    );
    const retryStartedAt = Date.now();
    const retried = await fetch(`${box.url}/api/bots`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Clean retry" }),
    });
    const retryElapsed = Date.now() - retryStartedAt;
    assert.equal(retried.status, 201);
    const retryBody = (await retried.json()) as { id: string; display?: number };
    assert.equal(retryBody.display, 1);
    assert.ok(retryElapsed >= 100, "slow Docker fixture did not exercise a sub-deadline wait");
    assert.ok(retryElapsed < 2_000, "slow Docker fixture exceeded its reasonable contention margin");
    assert.deepEqual(computer.commands, [
      ["inspect", "--format", "{{.State.Running}}", "openbot-screen"],
      ["inspect", "--format", "{{.State.Running}}", "openbot-screen"],
    ]);
    assert.deepEqual(await readdir(join(workspaceDir, "bots")), [retryBody.id]);
    const retriedHome = new HomeStore(homeDir);
    assert.deepEqual(retriedHome.listBots().map((bot) => [bot.id, retriedHome.botDisplay(bot.id)]), [
      [retryBody.id, 1],
    ]);
    assert.deepEqual(retriedHome.listBotProvisionings(), []);
    retriedHome.close();
  } finally {
    if (timedOutPid > 0) {
      try {
        process.kill(timedOutPid, "SIGKILL");
      } catch {
        // The production timeout should already have reaped it.
      }
      await waitForPidExit(timedOutPid);
    }
    await box?.close();
    await closeHttpServer(kasm.server);
    await rm(root, { recursive: true, force: true });
  }
});

describe("Computer Screen with an unreachable upstream", () => {
  let box: RunningBox;

  before(async () => {
    const cookiesDir = join(await mkdtemp(join(tmpdir(), "openbot-unreach-")), "cookies");
    await mkdir(cookiesDir, { recursive: true });
    box = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      homeDir: await mkdtemp(join(tmpdir(), "openbot-unreach-home-")),
      computer: new MemoryComputerRuntime({
        cookiesDir,
        upstreams: ["http://127.0.0.1:1"],
      }),
    });
  });

  after(async () => {
    await box.close();
  });

  test("Computer path is still present when Kasm has not answered yet", async () => {
    const cookie = await login(box.url);
    const api = await fetch(`${box.url}/api/computer`, { headers: { cookie } });
    assert.ok(api.ok);
    const body = (await api.json()) as { path?: string; ready?: boolean };
    assert.equal(body.path, "/screen/");
    assert.equal(body.ready, false);
  });
});

describe("Computer Screen readiness semantics", () => {
  test("public readiness accepts the real 70,673-byte Kasm application document", async () => {
    const body = await publicReadinessForDocument(kasmDocumentOfBytes(70_673));
    assert.equal(body.reachable, true);
    assert.equal(body.ready, true);
  });

  test("public readiness accepts a valid Kasm application document at exactly 128 KiB", async () => {
    const body = await publicReadinessForDocument(kasmDocumentOfBytes(128 * 1024));
    assert.equal(body.reachable, true);
    assert.equal(body.ready, true);
  });

  test("public readiness rejects a valid Kasm application document at 128 KiB plus one", async () => {
    const body = await publicReadinessForDocument(kasmDocumentOfBytes((128 * 1024) + 1));
    assert.equal(body.reachable, true);
    assert.equal(body.ready, false);
  });

  test("public readiness aborts an oversized Kasm stream near the bounded body ceiling", async (t) => {
    let bytesWritten = 0;
    let streaming = true;
    let resolveClosed: (bytes: number) => void = () => undefined;
    const responseClosed = new Promise<number>((resolve) => {
      resolveClosed = resolve;
    });
    const stub = http.createServer((_req, res) => {
      const prefix = "<!doctype html><html><head><title>KasmVNC</title></head><body>";
      const chunk = Buffer.alloc(8 * 1024, "x");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      bytesWritten += Buffer.byteLength(prefix);
      res.write(prefix);
      const writeChunk = () => {
        if (!streaming) return;
        bytesWritten += chunk.length;
        if (res.write(chunk)) {
          setImmediate(writeChunk);
        } else {
          res.once("drain", () => setImmediate(writeChunk));
        }
      };
      res.once("close", () => {
        streaming = false;
        resolveClosed(bytesWritten);
      });
      setImmediate(writeChunk);
    });
    await new Promise<void>((resolve, reject) => {
      stub.once("error", reject);
      stub.listen(0, "127.0.0.1", () => resolve());
    });
    t.after(async () => {
      streaming = false;
      await closeHttpServer(stub);
    });
    const address = stub.address();
    if (!address || typeof address === "string") throw new Error("streaming readiness stub failed to bind");
    const box = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      screenUpstream: `http://127.0.0.1:${address.port}`,
      homeDir: await mkdtemp(join(tmpdir(), "openbot-streaming-readiness-home-")),
    });
    t.after(() => box.close());

    const cookie = await login(box.url);
    const api = await fetch(`${box.url}/api/computer`, { headers: { cookie } });
    assert.equal(api.status, 200);
    const body = (await api.json()) as { reachable?: boolean; ready?: boolean };
    assert.equal(body.reachable, true);
    assert.equal(body.ready, false);
    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("readiness client did not abort the oversized stream")), 1_000).unref();
    });
    const abortedAt = await Promise.race([responseClosed, timeout]);
    assert.ok(abortedAt <= 256 * 1024, `readiness buffered ${abortedAt} bytes before aborting`);
  });

  test("invalid endpoint configuration cannot publish and corrected pairs survive restart", async (t) => {
    const firstKasm = await startReadyKasmFixture();
    const secondKasm = await startReadyKasmFixture();
    t.after(async () => {
      await Promise.all([
        closeHttpServer(firstKasm.server),
        closeHttpServer(secondKasm.server),
      ]);
    });
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-duplicate-screen-home-"));
    const cookieDir = join(homeDir, "computer-cookies");
    let invalidDockerCalls = 0;
    assert.throws(
      () => new DockerComputerRuntime({
        hostPorts: [firstKasm.port, secondKasm.port],
        pinchTabHostPorts: [19867, 19867],
        cookiesDir: cookieDir,
        docker: async () => {
          invalidDockerCalls += 1;
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
      /PINCHTAB_PORTS.*duplicate/iu,
    );
    assert.equal(invalidDockerCalls, 0);

    const correctedDockerCalls: string[][] = [];
    const correctedComputer = new DockerComputerRuntime({
      hostPorts: [firstKasm.port, secondKasm.port],
      pinchTabHostPorts: [19867, 19868],
      pinchTabToken: "endpoint-map-token",
      cookiesDir: cookieDir,
      docker: async (args) => {
        correctedDockerCalls.push(args);
        return { code: 0, stdout: args[0] === "inspect" ? "true\n" : "", stderr: "" };
      },
    });
    const correctedBox = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer: correctedComputer,
    });
    let firstBotId = "";
    let secondBotId = "";

    try {
      const cookie = await login(correctedBox.url);
      const create = async (name: string) => {
        const response = await fetch(`${correctedBox.url}/api/bots`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
        assert.equal(response.status, 201);
        return response.json() as Promise<{ id: string; display?: number }>;
      };
      const firstBot = await create("Corrected Screen 1");
      const secondBot = await create("Corrected Screen 2");
      firstBotId = firstBot.id;
      secondBotId = secondBot.id;
      assert.equal(firstBot.display, 1);
      assert.equal(secondBot.display, 2);
      assert.equal(correctedComputer.upstream(firstBot.id), `http://127.0.0.1:${firstKasm.port}`);
      assert.equal(correctedComputer.upstream(secondBot.id), `http://127.0.0.1:${secondKasm.port}`);
      assert.deepEqual(correctedComputer.pinchTab(firstBot.id), {
        url: "http://127.0.0.1:19867",
        token: "endpoint-map-token",
      });
      assert.deepEqual(correctedComputer.pinchTab(secondBot.id), {
        url: "http://127.0.0.1:19868",
        token: "endpoint-map-token",
      });
      assert.equal(
        correctedDockerCalls.filter((args) =>
          args[0] === "exec"
          && args[2] === DISPLAY_BIN
          && args[3] === "start"
          && args[4] === "2").length,
        1,
      );
    } finally {
      await correctedBox.close();
    }

    const restartComputer = new DockerComputerRuntime({
      hostPorts: [firstKasm.port, secondKasm.port],
      pinchTabHostPorts: [19867, 19868],
      pinchTabToken: "endpoint-map-token",
      cookiesDir: cookieDir,
      docker: async (args) => ({
        code: 0,
        stdout: args[0] === "inspect" ? "true\n" : "",
        stderr: "",
      }),
    });
    const restartedBox = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer: restartComputer,
    });
    try {
      const cookie = await login(restartedBox.url);
      const response = await fetch(`${restartedBox.url}/api/bots`, { headers: { cookie } });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { bots?: Array<{ id: string; display?: number }> };
      assert.deepEqual(
        body.bots?.map((bot) => ({ id: bot.id, display: bot.display })),
        [
          { id: firstBotId, display: 1 },
          { id: secondBotId, display: 2 },
        ],
      );
      assert.equal(restartComputer.display(firstBotId)?.display, 1);
      assert.equal(restartComputer.display(secondBotId)?.display, 2);
      assert.equal(restartComputer.pinchTab(firstBotId)?.url, "http://127.0.0.1:19867");
      assert.equal(restartComputer.pinchTab(secondBotId)?.url, "http://127.0.0.1:19868");
    } finally {
      await restartedBox.close();
    }
  });

  test("restart keeps Talk available when a persisted Bot Screen is not application-ready", async (t) => {
    const kasm = await startReadyKasmFixture();
    t.after(() => closeHttpServer(kasm.server));
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-restart-unready-screen-home-"));
    const cookiesDir = join(homeDir, "computer-cookies");
    const docker = async (args: string[]) => ({
      code: 0,
      stdout: args[0] === "inspect" ? "true\n" : "",
      stderr: "",
    });
    const seedComputer = new DockerComputerRuntime({ hostPorts: [kasm.port], cookiesDir, docker });
    const seedBox = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer: seedComputer,
    });
    let botId = "";

    try {
      const cookie = await login(seedBox.url);
      const created = await fetch(`${seedBox.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Persisted Screen" }),
      });
      assert.equal(created.status, 201);
      const bot = (await created.json()) as { id: string; display?: number };
      botId = bot.id;
      assert.equal(bot.display, 1);
    } finally {
      await seedBox.close();
    }

    await closeHttpServer(kasm.server);
    const restartComputer = new DockerComputerRuntime({ hostPorts: [kasm.port], cookiesDir, docker });
    const restartedBox = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer: restartComputer,
    });

    try {
      const cookie = await login(restartedBox.url);
      const list = await fetch(`${restartedBox.url}/api/bots`, { headers: { cookie } });
      assert.equal(list.status, 200);
      const body = (await list.json()) as { bots?: Array<{ id: string; display?: number }> };
      assert.deepEqual(body.bots?.map((bot) => ({ id: bot.id, display: bot.display })), [{ id: botId, display: 1 }]);
      const state = await waitForComputerScreenState(
        restartedBox.url,
        cookie,
        botId,
        "unavailable",
      );
      assert.equal(state.display, 1);
      assert.equal(state.path, null);
      assert.equal(state.reachable, false);
      assert.equal(state.ready, false);
      assert.equal(state.ownership, "unknown");
      assert.deepEqual(state.screenError, {
        stage: "readiness",
        code: "SCREEN_NOT_READY",
        message: "Screen application did not become ready.",
      });
      assert.equal(restartComputer.display(botId), undefined);
      assert.equal(restartComputer.upstream(botId), `http://127.0.0.1:${kasm.port}`);
      assert.equal(
        (await fetch(`${restartedBox.url}/screen/${botId}/`, { headers: { cookie } })).status,
        503,
      );
    } finally {
      await restartedBox.close();
    }
  });

  test("public readiness distinguishes HTTP transport from a valid Kasm application", async () => {
    let response = { status: 503, type: "text/html; charset=utf-8", body: "<title>KasmVNC</title>" };
    const stub = http.createServer((_req, res) => {
      res.writeHead(response.status, { "content-type": response.type });
      res.end(response.body);
    });
    await new Promise<void>((resolve, reject) => {
      stub.once("error", reject);
      stub.listen(0, "127.0.0.1", () => resolve());
    });
    const address = stub.address();
    if (!address || typeof address === "string") throw new Error("readiness stub failed to bind");
    const box = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      screenUpstream: `http://127.0.0.1:${address.port}`,
      homeDir: await mkdtemp(join(tmpdir(), "openbot-readiness-home-")),
    });

    try {
      const cookie = await login(box.url);
      const read = async () => {
        const api = await fetch(`${box.url}/api/computer`, { headers: { cookie } });
        assert.equal(api.status, 200);
        return api.json() as Promise<{ reachable?: boolean; ready?: boolean }>;
      };

      const failedStatus = await read();
      assert.equal(failedStatus.reachable, true);
      assert.equal(failedStatus.ready, false);
      const zoom = await fetch(`${box.url}/api/computer/zoom`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ zoom: false }),
      });
      assert.equal(zoom.status, 200);
      const zoomBody = (await zoom.json()) as { reachable?: boolean; ready?: boolean };
      assert.equal(zoomBody.reachable, true);
      assert.equal(zoomBody.ready, false);

      response = { status: 200, type: "text/html; charset=utf-8", body: "<title>Login proxy</title>" };
      const invalidPayload = await read();
      assert.equal(invalidPayload.reachable, true);
      assert.equal(invalidPayload.ready, false);

      response = { status: 200, type: "text/html; charset=utf-8", body: "<html><title>KasmVNC</title></html>" };
      const ready = await read();
      assert.equal(ready.reachable, true);
      assert.equal(ready.ready, true);
    } finally {
      await box.close();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });

  test("Bot publication waits for application readiness and retry reuses display 1", async () => {
    let ready = false;
    const stub = http.createServer((_req, res) => {
      res.writeHead(ready ? 200 : 503, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><title>KasmVNC</title></html>");
    });
    await new Promise<void>((resolve, reject) => {
      stub.once("error", reject);
      stub.listen(0, "127.0.0.1", () => resolve());
    });
    const address = stub.address();
    if (!address || typeof address === "string") throw new Error("provisioning readiness stub failed to bind");
    const upstream = `http://127.0.0.1:${address.port}`;
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-provision-readiness-home-"));
    const computer = new MemoryComputerRuntime({
      cookiesDir: join(homeDir, "cookies"),
      upstreams: [upstream],
      requiresReadiness: true,
    });
    const box = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer,
    });

    try {
      const cookie = await login(box.url);
      const create = (name: string) => fetch(`${box.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });

      const failed = await create("Not ready");
      assert.equal(failed.status, 503);
      const failedBody = (await failed.json()) as { code?: string; recoverable?: boolean };
      assert.equal(failedBody.code, "SCREEN_NOT_READY");
      assert.equal(failedBody.recoverable, true);
      const afterFailure = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
      const failedList = (await afterFailure.json()) as { bots?: unknown[] };
      assert.deepEqual(failedList.bots, []);

      ready = true;
      const retried = await create("Ready");
      assert.equal(retried.status, 201);
      const bot = (await retried.json()) as { display?: number };
      assert.equal(bot.display, 1);
    } finally {
      await box.close();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });

  test("readiness body stall remains transport-reachable but not application-ready", async () => {
    const stub = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.write("<html><title>KasmVNC</title>");
    });
    await new Promise<void>((resolve, reject) => {
      stub.once("error", reject);
      stub.listen(0, "127.0.0.1", () => resolve());
    });
    const address = stub.address();
    if (!address || typeof address === "string") throw new Error("readiness stall stub failed to bind");
    const box = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      screenUpstream: `http://127.0.0.1:${address.port}`,
      homeDir: await mkdtemp(join(tmpdir(), "openbot-readiness-stall-home-")),
    });

    try {
      const cookie = await login(box.url);
      const startedAt = Date.now();
      const api = await fetch(`${box.url}/api/computer`, { headers: { cookie } });
      const body = (await api.json()) as { reachable?: boolean; ready?: boolean };
      assert.equal(body.reachable, true);
      assert.equal(body.ready, false);
      assert.ok(Date.now() - startedAt < 1_500);
    } finally {
      await box.close();
      stub.closeAllConnections();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });
});

describe("Computer Screen proxy deadlines", () => {
  test("header, body, and total stalls end within their configured bounds", async () => {
    const intervals = new Set<NodeJS.Timeout>();
    const stub = http.createServer((req, res) => {
      if (req.url === "/headers") return;
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("start");
      if (req.url === "/total") {
        const interval = setInterval(() => res.write("."), 25);
        intervals.add(interval);
        res.once("close", () => {
          clearInterval(interval);
          intervals.delete(interval);
        });
      }
    });
    await new Promise<void>((resolve, reject) => {
      stub.once("error", reject);
      stub.listen(0, "127.0.0.1", () => resolve());
    });
    const address = stub.address();
    if (!address || typeof address === "string") throw new Error("deadline stub failed to bind");
    const box = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      screenUpstream: `http://127.0.0.1:${address.port}`,
      homeDir: await mkdtemp(join(tmpdir(), "openbot-deadline-home-")),
      screenProxyDeadlines: { connectMs: 80, headerMs: 80, bodyMs: 80, totalMs: 180 },
    });

    const readStalledBody = async (pathname: string): Promise<{ outcome: string; elapsedMs: number }> => {
      const dest = new URL(box.url);
      const started = Date.now();
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (outcome: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(clientTimer);
          resolve({ outcome, elapsedMs: Date.now() - started });
        };
        const clientTimer = setTimeout(() => finish("client-timeout"), 800);
        const request = http.request(
          {
            hostname: dest.hostname,
            port: dest.port,
            path: `/screen/${pathname}`,
            headers: { cookie },
          },
          (response) => {
            response.resume();
            response.on("end", () => finish("ended"));
            response.on("aborted", () => finish("closed"));
            response.on("error", () => finish("closed"));
          },
        );
        request.on("error", (error) => {
          if (settled) return;
          reject(error);
        });
        request.end();
      });
    };

    const cookie = await login(box.url);
    try {
      const headerStarted = Date.now();
      const header = await fetch(`${box.url}/screen/headers`, {
        headers: { cookie },
        signal: AbortSignal.timeout(800),
      });
      assert.equal(header.status, 504);
      assert.match(await header.text(), /headers/i);
      assert.ok(Date.now() - headerStarted < 500);

      const body = await readStalledBody("body");
      assert.equal(body.outcome, "closed");
      assert.ok(body.elapsedMs < 500, `body deadline overran: ${body.elapsedMs}ms`);

      const total = await readStalledBody("total");
      assert.equal(total.outcome, "closed");
      assert.ok(total.elapsedMs >= 120, `total deadline fired too early: ${total.elapsedMs}ms`);
      assert.ok(total.elapsedMs < 500, `total deadline overran: ${total.elapsedMs}ms`);
    } finally {
      for (const interval of intervals) clearInterval(interval);
      intervals.clear();
      stub.closeAllConnections();
      await box.close();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });

  test("late HTTP responses and upgrades have no side effects after a terminal deadline", async () => {
    const box = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      screenUpstream: "http://late-upstream.invalid",
      homeDir: await mkdtemp(join(tmpdir(), "openbot-late-event-home-")),
      screenProxyDeadlines: { connectMs: 40, headerMs: 40, bodyMs: 40, totalMs: 120 },
    });
    const cookie = await login(box.url);
    type Delivery = {
      response: http.IncomingMessage;
      socket?: PassThrough;
      error?: unknown;
    };
    let resolveHttp!: (delivery: Delivery) => void;
    let resolveUpgrade!: (delivery: Delivery) => void;
    const lateHttp = new Promise<Delivery>((resolve) => (resolveHttp = resolve));
    const lateUpgrade = new Promise<Delivery>((resolve) => (resolveUpgrade = resolve));

    const fakeRequest = ((...args: unknown[]) => {
      const callback = typeof args[2] === "function" ? (args[2] as (res: http.IncomingMessage) => void) : undefined;
      const request = new PassThrough() as unknown as http.ClientRequest;
      queueMicrotask(() => request.emit("socket", { connecting: false }));
      const response = Readable.from(["late"]) as unknown as http.IncomingMessage;
      response.statusCode = 200;
      response.statusMessage = "OK";
      response.headers = { "content-type": "text/plain" };
      setTimeout(() => {
        if (callback) {
          try {
            callback(response);
            resolveHttp({ response });
          } catch (error) {
            resolveHttp({ response, error });
          }
          return;
        }
        const connectedSocket = new PassThrough();
        try {
          request.emit("upgrade", response, connectedSocket, Buffer.alloc(0));
          resolveUpgrade({ response, socket: connectedSocket });
        } catch (error) {
          resolveUpgrade({ response, socket: connectedSocket, error });
        }
      }, 90);
      return request;
    }) as typeof http.request;

    mock.method(http, "request", fakeRequest);
    try {
      const httpResponse = await fetch(`${box.url}/screen/late`, { headers: { cookie } });
      assert.equal(httpResponse.status, 504);
      assert.match(await httpResponse.text(), /headers/i);
      const deliveredHttp = await lateHttp;
      assert.equal(deliveredHttp.error, undefined);
      assert.equal(deliveredHttp.response.destroyed, true, "late HTTP response was not discarded");

      const dest = new URL(box.url);
      const rawUpgrade = new Promise<string>((resolve, reject) => {
        const socket = net.createConnection(Number(dest.port), dest.hostname);
        let received = "";
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error("timed out waiting for proxy upgrade deadline"));
        }, 800);
        socket.on("connect", () => {
          socket.write(
            `GET /screen/websockify HTTP/1.1\r\nHost: ${dest.host}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
          );
        });
        socket.on("data", (chunk) => (received += chunk.toString("utf8")));
        socket.on("error", reject);
        socket.on("close", () => {
          clearTimeout(timer);
          resolve(received);
        });
      });
      assert.match(await rawUpgrade, /^HTTP\/1\.1 504 Gateway Timeout/);
      const deliveredUpgrade = await lateUpgrade;
      assert.equal(deliveredUpgrade.error, undefined);
      assert.equal(deliveredUpgrade.response.destroyed, true, "late upgrade response was not discarded");
      assert.equal(deliveredUpgrade.socket?.destroyed, true, "late upgraded socket was not discarded");

      const stillUp = await fetch(`${box.url}/`);
      assert.equal(stillUp.status, 200);
    } finally {
      mock.restoreAll();
      await box.close();
    }
  });

  test("an upstream upgrade error returns one actionable 502 response before closing", async () => {
    const box = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      screenUpstream: "http://upgrade-error.invalid",
      homeDir: await mkdtemp(join(tmpdir(), "openbot-upgrade-error-home-")),
      screenProxyDeadlines: { connectMs: 80, headerMs: 80, bodyMs: 80, totalMs: 200 },
    });
    const cookie = await login(box.url);
    const fakeRequest = (() => {
      const request = new PassThrough() as unknown as http.ClientRequest;
      queueMicrotask(() => request.emit("socket", { connecting: false }));
      setImmediate(() => request.emit("error", new Error("upstream refused upgrade")));
      return request;
    }) as typeof http.request;
    mock.method(http, "request", fakeRequest);
    try {
      const dest = new URL(box.url);
      const raw = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection(Number(dest.port), dest.hostname);
        let received = "";
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          resolve(received);
        };
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error("timed out waiting for upstream upgrade error response"));
        }, 800);
        socket.on("connect", () => {
          socket.write(
            `GET /screen/websockify HTTP/1.1\r\nHost: ${dest.host}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
          );
        });
        socket.on("data", (chunk) => (received += chunk.toString("utf8")));
        socket.on("error", finish);
        socket.on("close", finish);
      });

      assert.match(raw, /^HTTP\/1\.1 502 Bad Gateway\r\n/u);
      assert.match(raw, /\r\nConnection: close\r\n/iu);
      assert.equal(raw.match(/HTTP\/1\.1/gu)?.length, 1, raw);
      const stillUp = await fetch(`${box.url}/`);
      assert.equal(stillUp.status, 200);
    } finally {
      mock.restoreAll();
      await box.close();
    }
  });
});
