import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startBox, type RunningBox } from "../src/box.ts";
import { MemoryScreenRuntime } from "../src/screens.ts";

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

describe("Computer Screen HTTP", () => {
  let box: RunningBox;
  let stub: http.Server;
  let lastAuth: string | undefined;
  let lastPath: string | undefined;
  let screens: MemoryScreenRuntime;
  let botId: string;

  before(async () => {
    stub = http.createServer((req, res) => {
      lastAuth = req.headers.authorization;
      lastPath = req.url;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "www-authenticate": "Basic realm=kasm" });
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
    const workspaceDir = await mkdtemp(join(tmpdir(), "openbot-screen-ws-"));
    screens = new MemoryScreenRuntime({
      cookiesDir: join(workspaceDir, "cookies"),
      upstreamFor: () => `http://127.0.0.1:${addr.port}`,
    });
    box = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      workspaceDir,
      screens,
      kasmUser: KASM_USER,
      kasmPassword: KASM_PASSWORD,
    });
    const cookie = await login(box.url);
    const created = await fetch(`${box.url}/api/bots`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada" }),
    });
    const bot = (await created.json()) as { id: string };
    botId = bot.id;
    const woke = await fetch(`${box.url}/api/bots/${botId}/wake`, { method: "POST", headers: { cookie } });
    assert.ok(woke.ok, `wake failed: ${woke.status}`);
  });

  after(async () => {
    await box.close();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  test("Computer API and Screen path need a session", async () => {
    const api = await fetch(`${box.url}/api/computer`);
    assert.ok(api.status >= 400, `unauthenticated /api/computer should fail, got ${api.status}`);
    const screen = await fetch(`${box.url}/screen/${botId}/`);
    assert.ok(screen.status >= 400, `unauthenticated /screen/${botId}/ should fail, got ${screen.status}`);
  });

  test("session can read Computer and open that Bot's Screen under the same origin", async () => {
    const cookie = await login(box.url);
    const api = await fetch(`${box.url}/api/computer?botId=${encodeURIComponent(botId)}`, { headers: { cookie } });
    assert.ok(api.ok, `GET /api/computer failed: ${api.status}`);
    const body = (await api.json()) as { path?: string; ready?: boolean; botId?: string };
    assert.equal(body.botId, botId);
    assert.equal(body.path, `/screen/${botId}/`);
    assert.equal(body.ready, true);

    lastAuth = undefined;
    const screen = await fetch(`${box.url}/screen/${botId}/`, { headers: { cookie } });
    assert.ok(screen.ok, `GET /screen/${botId}/ failed: ${screen.status}`);
    const html = await screen.text();
    assert.match(html, /desktop-stub/);
    assert.doesNotMatch(html, /kasm-secret/);
    assert.equal(lastPath, "/");
    const expected = `Basic ${Buffer.from(`${KASM_USER}:${KASM_PASSWORD}`).toString("base64")}`;
    assert.equal(lastAuth, expected);
    const www = screen.headers.get("www-authenticate");
    assert.equal(www, null, "Kasm basic-auth challenge must not reach the browser");
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
          path: `/screen/${botId}/websockify`,
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
});

describe("Computer Screen without an upstream", () => {
  let box: RunningBox;

  before(async () => {
    box = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      workspaceDir: await mkdtemp(join(tmpdir(), "openbot-noup-")),
    });
  });

  after(async () => {
    await box.close();
  });

  test("session sees Computer not ready and Screen is unavailable", async () => {
    const cookie = await login(box.url);
    const api = await fetch(`${box.url}/api/computer`, { headers: { cookie } });
    assert.ok(api.ok);
    const body = (await api.json()) as { path?: string | null; ready?: boolean };
    assert.equal(body.ready, false);
    assert.equal(body.path, null);
    const created = await fetch(`${box.url}/api/bots`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada" }),
    });
    const bot = (await created.json()) as { id: string };
    const screen = await fetch(`${box.url}/screen/${bot.id}/`, { headers: { cookie } });
    assert.equal(screen.status, 503);
  });
});

describe("Computer Screen with an unreachable upstream", () => {
  let box: RunningBox;
  let botId: string;

  before(async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "openbot-unreach-"));
    const screens = new MemoryScreenRuntime({
      cookiesDir: join(workspaceDir, "cookies"),
      upstreamFor: () => "http://127.0.0.1:1",
    });
    box = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      workspaceDir,
      screens,
    });
    const cookie = await login(box.url);
    const created = await fetch(`${box.url}/api/bots`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada" }),
    });
    const bot = (await created.json()) as { id: string };
    botId = bot.id;
    await fetch(`${box.url}/api/bots/${botId}/wake`, { method: "POST", headers: { cookie } });
  });

  after(async () => {
    await box.close();
  });

  test("Computer is not ready when Screen does not answer", async () => {
    const cookie = await login(box.url);
    const api = await fetch(`${box.url}/api/computer?botId=${encodeURIComponent(botId)}`, { headers: { cookie } });
    assert.ok(api.ok);
    const body = (await api.json()) as { path?: string; ready?: boolean; botId?: string };
    assert.equal(body.path, `/screen/${botId}/`);
    assert.equal(body.ready, false);
  });
});
