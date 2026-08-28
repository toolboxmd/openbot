import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { after, before, describe, mock, test } from "node:test";
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
