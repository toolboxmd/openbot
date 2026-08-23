import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startBox, type RunningBox } from "../src/box.ts";
import { BotStore } from "../src/bots.ts";
import { kasmUpdateUserUrl } from "../src/kasm.ts";
import { MemoryScreenRuntime } from "../src/screens.ts";

const PASSWORD = "correct-horse";
const KASM_USER = "openbot";
const KASM_PASSWORD = "openbot";

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
  return cookieHeader(res);
}

async function emptyPwa(): Promise<string> {
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-pwa-"));
  await writeFile(join(pwaDir, "index.html"), `<!doctype html><title>OpenBot</title>`);
  return pwaDir;
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("Kasm write URL", () => {
  test("update_user sets write true or false on the real Kasm path", () => {
    const on = kasmUpdateUserUrl({
      upstream: "http://127.0.0.1:16901",
      user: "openbot",
      password: "openbot",
      name: "openbot",
      write: true,
    });
    assert.equal(on.pathname, "/api/update_user");
    assert.equal(on.searchParams.get("name"), "openbot");
    assert.equal(on.searchParams.get("write"), "true");
    assert.equal(on.searchParams.get("read"), "true");
    const off = kasmUpdateUserUrl({
      upstream: "http://127.0.0.1:16901",
      user: "openbot",
      password: "openbot",
      name: "openbot",
      write: false,
    });
    assert.equal(off.searchParams.get("write"), "false");
  });
});

describe("Takeover HTTP seam", () => {
  let box: RunningBox;
  let screens: MemoryScreenRuntime;
  let stub: http.Server;
  let kasmPaths: string[] = [];
  let kasmWrites: string[] = [];
  let adaId = "";
  let benId = "";

  before(async () => {
    stub = http.createServer((req, res) => {
      const path = req.url ?? "/";
      kasmPaths.push(path);
      if (path.startsWith("/api/update_user")) {
        const dest = new URL(path, "http://kasm.local");
        kasmWrites.push(dest.searchParams.get("write") ?? "");
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "www-authenticate": "Basic realm=kasm" });
      res.end("<html><title>KasmVNC</title><body>desktop-stub</body></html>");
    });
    await new Promise<void>((resolve, reject) => {
      stub.once("error", reject);
      stub.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = stub.address();
    if (!addr || typeof addr === "string") throw new Error("stub failed to bind");
    const workspace = await tempDir("openbot-takeover-ws-");
    const cookiesDir = join(await tempDir("openbot-takeover-cookies-"), "cookies");
    await mkdir(cookiesDir, { recursive: true });
    screens = new MemoryScreenRuntime({
      cookiesDir,
      upstreamFor: () => `http://127.0.0.1:${addr.port}`,
    });
    box = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      workspaceDir: workspace,
      screens,
      kasmUser: KASM_USER,
      kasmPassword: KASM_PASSWORD,
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
    const woke = await fetch(`${box.url}/api/bots/${adaId}/wake`, { method: "POST", headers: { cookie } });
    assert.ok(woke.ok, `wake failed: ${woke.status}`);
  });

  after(async () => {
    await box.close();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  test("after takeover computer reports write true / viewOnly false and Kasm update_user write=true", async () => {
    const cookie = await login(box.url);
    kasmWrites = [];
    const take = await fetch(`${box.url}/api/bots/${adaId}/takeover`, { method: "POST", headers: { cookie } });
    assert.equal(take.status, 200, `takeover failed: ${take.status}`);
    const bot = (await take.json()) as { takeover?: boolean; eyes: { mode: string } };
    assert.equal(bot.takeover, true);
    assert.equal(bot.eyes.mode, "needs-you");

    const computer = await fetch(`${box.url}/api/computer?botId=${encodeURIComponent(adaId)}`, { headers: { cookie } });
    assert.ok(computer.ok);
    const info = (await computer.json()) as { write?: boolean; viewOnly?: boolean; takeover?: boolean };
    assert.equal(info.write, true);
    assert.equal(info.viewOnly, false);
    assert.equal(info.takeover, true);
    assert.ok(kasmWrites.includes("true"), `expected Kasm write=true, got ${JSON.stringify(kasmWrites)}`);
  });

  test("after release computer is view-only and Kasm update_user write=false", async () => {
    const cookie = await login(box.url);
    kasmWrites = [];
    const rel = await fetch(`${box.url}/api/bots/${adaId}/release`, { method: "POST", headers: { cookie } });
    assert.equal(rel.status, 200, `release failed: ${rel.status}`);
    const bot = (await rel.json()) as { takeover?: boolean };
    assert.equal(bot.takeover, false);

    const computer = await fetch(`${box.url}/api/computer?botId=${encodeURIComponent(adaId)}`, { headers: { cookie } });
    const info = (await computer.json()) as { write?: boolean; viewOnly?: boolean; takeover?: boolean };
    assert.equal(info.write, false);
    assert.equal(info.viewOnly, true);
    assert.equal(info.takeover, false);
    assert.ok(kasmWrites.includes("false"), `expected Kasm write=false, got ${JSON.stringify(kasmWrites)}`);
  });

  test("second takeover on another bot while one is held is 409", async () => {
    const cookie = await login(box.url);
    const first = await fetch(`${box.url}/api/bots/${adaId}/takeover`, { method: "POST", headers: { cookie } });
    assert.equal(first.status, 200, `takeover failed: ${first.status}`);
    const second = await fetch(`${box.url}/api/bots/${benId}/takeover`, { method: "POST", headers: { cookie } });
    assert.equal(second.status, 409);
    const body = (await second.json()) as { error?: string };
    assert.match(String(body.error ?? ""), /Takeover|Wake/i);
    await fetch(`${box.url}/api/bots/${adaId}/release`, { method: "POST", headers: { cookie } });
  });

  test("agent-requested needs-you does not set write", async () => {
    const cookie = await login(box.url);
    kasmWrites = [];
    const needs = await fetch(`${box.url}/api/bots/${adaId}/needs-you`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ reason: "2fa" }),
    });
    assert.equal(needs.status, 200, `needs-you failed: ${needs.status}`);
    const bot = (await needs.json()) as {
      takeover?: boolean;
      eyes: { mode: string };
      needsYou: { reason: string } | null;
    };
    assert.equal(bot.takeover, false);
    assert.equal(bot.eyes.mode, "needs-you");
    assert.equal(bot.needsYou?.reason, "2fa");

    const computer = await fetch(`${box.url}/api/computer?botId=${encodeURIComponent(adaId)}`, { headers: { cookie } });
    const info = (await computer.json()) as { write?: boolean; viewOnly?: boolean };
    assert.equal(info.write, false);
    assert.equal(info.viewOnly, true);
    assert.equal(kasmWrites.length, 0, "agent-requested needs-you must not call Kasm write");
  });

  test("Kasm basic-auth challenge still does not reach the browser during takeover", async () => {
    const cookie = await login(box.url);
    await fetch(`${box.url}/api/bots/${adaId}/takeover`, { method: "POST", headers: { cookie } });
    const screen = await fetch(`${box.url}/screen/${adaId}/`, { headers: { cookie } });
    assert.ok(screen.ok);
    assert.equal(screen.headers.get("www-authenticate"), null);
    await fetch(`${box.url}/api/bots/${adaId}/release`, { method: "POST", headers: { cookie } });
  });
});

describe("Takeover pauses ACP child (injected spawn, no fake production ACP)", () => {
  test("takeover pauses, release resumes, send is 409 while held", async () => {
    const dir = await tempDir("openbot-takeover-acp-");
    const screens = new MemoryScreenRuntime({ cookiesDir: join(dir, "cookies") });
    const events: string[] = [];
    const store = new BotStore(dir, {
      screens,
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: () => ({
        close() {
          events.push("close");
        },
        pause() {
          events.push("pause");
        },
        resume() {
          events.push("resume");
        },
        async initialize() {
          return {};
        },
        async newSession() {
          return "s1";
        },
        async prompt() {
          return "ok";
        },
        respondPermission() {},
      }),
    });
    const ada = store.create("Ada");
    const ben = store.create("Ben");
    await store.wake(ada.id);
    await store.pickHarness(ada.id, "codex");
    assert.equal(store.hasAcpChild(ada.id), true);

    const taken = store.takeover(ada.id);
    assert.equal(taken.takeover, true);
    assert.equal(taken.eyes.mode, "needs-you");
    assert.ok(events.includes("pause"));

    await assert.rejects(() => store.send(ada.id, "hello"), (err: Error & { status?: number }) => {
      assert.equal(err.status, 409);
      return /Takeover/i.test(err.message);
    });

    assert.throws(
      () => store.takeover(ben.id),
      (err: Error & { status?: number }) => {
        assert.equal(err.status, 409);
        return true;
      },
    );

    store.release(ada.id);
    assert.ok(events.includes("resume"));
    assert.equal(store.isTakeover(ada.id), false);
    store.close();
  });

  test("agent-requested needs-you does not pause or grant takeover write", async () => {
    const dir = await tempDir("openbot-needsyou-");
    const screens = new MemoryScreenRuntime({ cookiesDir: join(dir, "cookies") });
    const events: string[] = [];
    const store = new BotStore(dir, {
      screens,
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: () => ({
        close() {},
        pause() {
          events.push("pause");
        },
        resume() {
          events.push("resume");
        },
        async initialize() {
          return {};
        },
        async newSession() {
          return "s1";
        },
        async prompt() {
          return "ok";
        },
        respondPermission() {},
      }),
    });
    const ada = store.create("Ada");
    await store.wake(ada.id);
    await store.pickHarness(ada.id, "codex");
    const bot = store.requestNeedsYou(ada.id, "2fa");
    assert.equal(bot.takeover, false);
    assert.equal(bot.eyes.mode, "needs-you");
    assert.equal(bot.needsYou?.reason, "2fa");
    assert.equal(events.includes("pause"), false);
    assert.equal(store.isTakeover(ada.id), false);
    store.close();
  });
});
