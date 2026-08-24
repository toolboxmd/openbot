import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startBox, type RunningBox } from "../src/box.ts";
import { MemoryComputerRuntime } from "../src/computer.ts";

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
      workspaceDir: await mkdtemp(join(tmpdir(), "openbot-screen-ws-")),
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
