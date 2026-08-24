import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { startBox, type RunningBox } from "../src/box.ts";
import { BotStore } from "../src/bots.ts";
import { MemoryComputerRuntime } from "../src/computer.ts";
import { kasmUpdateUserUrl } from "../src/kasm.ts";

const PASSWORD = "correct-horse";
const KASM_USER = "openbot";
const KASM_PASSWORD = "openbot";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");

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
    assert.equal(on.searchParams.get("write"), "true");
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

describe("Zoom HTTP seam",
  () => {
    let box: RunningBox;
    let computer: MemoryComputerRuntime;
    let stub: http.Server;
    let kasmWrites: string[] = [];
    let adaId = "";
    let benId = "";

    before(async () => {
      stub = http.createServer((req, res) => {
        const path = req.url ?? "/";
        if (path.startsWith("/api/update_user")) {
          const dest = new URL(path, "http://kasm.local");
          kasmWrites.push(dest.searchParams.get("write") ?? "");
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end("{}");
          return;
        }
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "www-authenticate": "Basic realm=kasm",
        });
        res.end("<html><title>KasmVNC</title><body>desktop-stub</body></html>");
      });
      await new Promise<void>((resolve, reject) => {
        stub.once("error", reject);
        stub.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = stub.address();
      if (!addr || typeof addr === "string") throw new Error("stub failed to bind");
      const upstream = `http://127.0.0.1:${addr.port}`;
      const workspace = await tempDir("openbot-zoom-ws-");
      const cookiesDir = join(await tempDir("openbot-zoom-cookies-"), "cookies");
      await mkdir(cookiesDir, { recursive: true });
      computer = new MemoryComputerRuntime({
        cookiesDir,
        upstreams: [upstream, upstream],
      });
      box = await startBox({
        password: PASSWORD,
        pwaDir: await emptyPwa(),
        host: "127.0.0.1",
        port: 0,
        workspaceDir: workspace,
        computer,
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
    });

    after(async () => {
      await box.close();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    });

    test("Screen never reports down after start", async () => {
      const cookie = await login(box.url);
      const api = await fetch(`${box.url}/api/computer?botId=${encodeURIComponent(adaId)}`, {
        headers: { cookie },
      });
      assert.ok(api.ok);
      const body = (await api.json()) as { ready?: boolean; path?: string };
      assert.equal(body.ready, true);
      assert.equal(body.path, `/screen/${adaId}/`);
    });

    test("two Bots have two display upstreams on one Computer", async () => {
      const ada = computer.display(adaId);
      const ben = computer.display(benId);
      assert.ok(ada);
      assert.ok(ben);
      assert.equal(ada.display, 1);
      assert.equal(ben.display, 2);
      assert.equal(computer.commands.some((args) => args[0] === "run"), false);
    });

    test("zoom enables Kasm write; close returns view-only", async () => {
      const cookie = await login(box.url);
      kasmWrites = [];
      const zoom = await fetch(`${box.url}/api/computer/zoom`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ botId: adaId, zoom: true }),
      });
      assert.equal(zoom.status, 200, `zoom failed: ${zoom.status}`);
      const zoomed = (await zoom.json()) as { write?: boolean; viewOnly?: boolean; zoom?: boolean };
      assert.equal(zoomed.write, true);
      assert.equal(zoomed.viewOnly, false);
      assert.equal(zoomed.zoom, true);
      assert.ok(kasmWrites.includes("true"));

      const computerApi = await fetch(`${box.url}/api/computer?botId=${encodeURIComponent(adaId)}`, {
        headers: { cookie },
      });
      const info = (await computerApi.json()) as { write?: boolean; viewOnly?: boolean; zoom?: boolean };
      assert.equal(info.write, true);
      assert.equal(info.viewOnly, false);
      assert.equal(info.zoom, true);

      const listed = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
      assert.ok(listed.ok);
      const listBody = (await listed.json()) as { bots: Array<{ id: string; write?: boolean; zoom?: boolean }> };
      const adaRow = listBody.bots.find((bot) => bot.id === adaId);
      assert.ok(adaRow);
      assert.equal(adaRow.write, true, "GET /api/bots must not keep Takeover write:false while zoomed");
      assert.equal(adaRow.zoom, true);

      const adaGet = await fetch(`${box.url}/api/bots/${adaId}`, { headers: { cookie } });
      const adaBody = (await adaGet.json()) as { write?: boolean; zoom?: boolean };
      assert.equal(adaBody.write, true);
      assert.equal(adaBody.zoom, true);

      kasmWrites = [];
      const close = await fetch(`${box.url}/api/computer/zoom`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ botId: adaId, zoom: false }),
      });
      assert.equal(close.status, 200);
      const closed = (await close.json()) as { write?: boolean; viewOnly?: boolean; zoom?: boolean };
      assert.equal(closed.write, false);
      assert.equal(closed.viewOnly, true);
      assert.equal(closed.zoom, false);
      assert.ok(kasmWrites.includes("false"));
    });

    test("there is no Takeover button route", async () => {
      const cookie = await login(box.url);
      const take = await fetch(`${box.url}/api/bots/${adaId}/takeover`, {
        method: "POST",
        headers: { cookie },
      });
      assert.equal(take.status, 404);
    });
  },
);

describe("Zoom pauses ACP child (injected spawn, no fake production ACP)", () => {
  test("zoom pauses, unzoom resumes, send is 409 while zoomed", async () => {
    const dir = await tempDir("openbot-zoom-acp-");
    const screens = new MemoryComputerRuntime({ cookiesDir: join(dir, "cookies") });
    const events: string[] = [];
    const store = new BotStore(dir, {
      computer: screens,
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
    const ada = await store.create("Ada");
    await store.pickHarness(ada.id, "codex");
    assert.equal(store.hasAcpChild(ada.id), true);
    store.zoom(ada.id);
    assert.ok(events.includes("pause"));
    await assert.rejects(() => store.send(ada.id, "hello"), (err: Error & { status?: number }) => {
      assert.equal(err.status, 409);
      return /zoom/i.test(err.message);
    });
    store.unzoom(ada.id);
    assert.ok(events.includes("resume"));
    store.close();
  });
});

describe("PWA has no Takeover button", () => {
  test("Computer and Messenger do not render Takeover", async () => {
    const computer = await readFile(join(repoRoot, "pwa/src/components/Computer.tsx"), "utf8");
    const messenger = await readFile(join(repoRoot, "pwa/src/components/Messenger.tsx"), "utf8");
    assert.doesNotMatch(computer, /Takeover/);
    assert.doesNotMatch(computer, /\/takeover/);
    assert.doesNotMatch(messenger, /Takeover/);
    assert.doesNotMatch(computer, /Screen is down/);
    assert.doesNotMatch(computer, /Wake this Bot/);
  });

  test("preview Open control is a real hit target and expanded iframe is writable", async () => {
    const computer = await readFile(join(repoRoot, "pwa/src/components/Computer.tsx"), "utf8");
    const messenger = await readFile(join(repoRoot, "pwa/src/components/Messenger.tsx"), "utf8");
    assert.match(messenger, /data-testid="open-computer"/);
    assert.match(messenger, /data-testid="open-computer-preview"/);
    assert.match(messenger, /data-testid=\{computerOpen \? "computer-expanded" : "computer-preview"\}/);
    assert.match(messenger, /aria-label="Open Computer"/);
    assert.match(
      messenger,
      /data-testid="open-computer-preview"[\s\S]*?className="absolute inset-0 z-30 flex cursor-pointer items-center justify-center bg-transparent"/,
    );
    assert.match(computer, /expanded \? "pointer-events-auto" : "pointer-events-none"/);
    assert.match(computer, /setComputerZoom\(botId, expanded\)/);
  });

  test("Computer iframe allows host clipboard into Screen", async () => {
    const computer = await readFile(join(repoRoot, "pwa/src/components/Computer.tsx"), "utf8");
    const yaml = await readFile(join(repoRoot, "screen/kasmvnc.yaml"), "utf8");
    assert.match(computer, /allow="[^"]*clipboard-read/);
    assert.match(computer, /allow="[^"]*clipboard-write/);
    assert.match(computer, /searchParams\.set\("clipboard_up", "true"\)/);
    assert.match(computer, /searchParams\.set\("clipboard_down", "true"\)/);
    assert.match(computer, /searchParams\.set\("clipboard_seamless", "true"\)/);
    assert.match(yaml, /client_to_server:[\s\S]*enabled:\s*true/);
    assert.match(yaml, /server_to_client:[\s\S]*enabled:\s*true/);
    assert.doesNotMatch(computer, /fake ACP/i);
    assert.doesNotMatch(yaml, /fake ACP/i);
  });
});
