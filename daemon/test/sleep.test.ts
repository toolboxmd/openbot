import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startBox, type RunningBox } from "../src/box.ts";
import { BotStore } from "../src/bots.ts";
import {
  CONTAINER_PORT,
  COOKIE_MOUNT,
  DockerScreenRuntime,
  HOME_MOUNT,
  HOST_PORT_FLOOR,
  MemoryScreenRuntime,
  containerName,
  homeVolume,
} from "../src/screens.ts";

const PASSWORD = "correct-horse";

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

describe("two Bots, private Screens, Sleep", () => {
  let box: RunningBox;
  let screens: MemoryScreenRuntime;
  let stub: http.Server;
  let stubPort = 0;
  let lastPath: string | undefined;
  let workspace: string;
  let cookiesDir: string;

  before(async () => {
    stub = http.createServer((req, res) => {
      lastPath = req.url;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><title>KasmVNC</title><body>desktop-stub</body></html>");
    });
    stub.on("upgrade", (req, socket) => {
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
    stubPort = addr.port;
    workspace = await tempDir("openbot-sleep-ws-");
    cookiesDir = join(await tempDir("openbot-sleep-cookies-"), "cookies");
    await mkdir(cookiesDir, { recursive: true });
    screens = new MemoryScreenRuntime({
      cookiesDir,
      upstreamFor: () => `http://127.0.0.1:${stubPort}`,
    });
    box = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      workspaceDir: workspace,
      screens,
    });
  });

  after(async () => {
    await box.close();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  test("two Bots get different Eyes and start asleep", async () => {
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
    assert.equal(ada.status, 201);
    assert.equal(ben.status, 201);
    const a = (await ada.json()) as {
      id: string;
      name: string;
      screen: string;
      eyes: { color: string; shape: string; mode: string };
    };
    const b = (await ben.json()) as {
      id: string;
      name: string;
      screen: string;
      eyes: { color: string; shape: string; mode: string };
    };
    assert.equal(a.name, "Ada");
    assert.equal(b.name, "Ben");
    assert.notEqual(a.eyes.color, b.eyes.color);
    assert.notEqual(a.eyes.shape, b.eyes.shape);
    assert.equal(a.screen, "asleep");
    assert.equal(b.screen, "asleep");
    assert.equal(a.eyes.mode, "sleep");
    assert.equal(b.eyes.mode, "sleep");

    const listed = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
    const body = (await listed.json()) as { bots: Array<{ id: string }> };
    assert.equal(body.bots.length, 2);
  });

  test("wake starts that Screen; computer path is per-bot; sleep stops it", async () => {
    const cookie = await login(box.url);
    const listed = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
    const { bots } = (await listed.json()) as {
      bots: Array<{ id: string; name: string }>;
    };
    const ada = bots.find((bot) => bot.name === "Ada");
    const ben = bots.find((bot) => bot.name === "Ben");
    assert.ok(ada && ben);

    const wake = await fetch(`${box.url}/api/bots/${ada.id}/wake`, {
      method: "POST",
      headers: { cookie },
    });
    assert.ok(wake.ok, `wake failed: ${wake.status}`);
    const woke = (await wake.json()) as { id: string; screen: string; eyes: { mode: string } };
    assert.equal(woke.screen, "active");
    assert.ok(screens.started.includes(ada.id));
    assert.equal(screens.running(ada.id), true);

    const computer = await fetch(`${box.url}/api/computer?botId=${encodeURIComponent(ada.id)}`, {
      headers: { cookie },
    });
    assert.ok(computer.ok);
    const info = (await computer.json()) as {
      path?: string;
      ready?: boolean;
      botId?: string;
      cookieJar?: string;
    };
    assert.equal(info.botId, ada.id);
    assert.equal(info.path, `/screen/${ada.id}/`);
    assert.equal(info.ready, true);
    assert.equal(info.cookieJar, cookiesDir);

    lastPath = undefined;
    const screen = await fetch(`${box.url}/screen/${ada.id}/`, { headers: { cookie } });
    assert.ok(screen.ok, `GET /screen/${ada.id}/ failed: ${screen.status}`);
    assert.match(await screen.text(), /desktop-stub/);
    assert.equal(lastPath, "/");

    const other = await fetch(`${box.url}/api/computer?botId=${encodeURIComponent(ben.id)}`, {
      headers: { cookie },
    });
    const otherInfo = (await other.json()) as { path?: string; ready?: boolean; botId?: string };
    assert.equal(otherInfo.botId, ben.id);
    assert.equal(otherInfo.path, `/screen/${ben.id}/`);
    assert.equal(otherInfo.ready, false);

    const sleep = await fetch(`${box.url}/api/bots/${ada.id}/sleep`, {
      method: "POST",
      headers: { cookie },
    });
    assert.ok(sleep.ok, `sleep failed: ${sleep.status}`);
    const slept = (await sleep.json()) as { screen: string; eyes: { mode: string } };
    assert.equal(slept.screen, "asleep");
    assert.equal(slept.eyes.mode, "sleep");
    assert.ok(screens.stopped.includes(ada.id));
    assert.equal(screens.running(ada.id), false);

    const after = await fetch(`${box.url}/api/computer?botId=${encodeURIComponent(ada.id)}`, {
      headers: { cookie },
    });
    const afterInfo = (await after.json()) as { ready?: boolean };
    assert.equal(afterInfo.ready, false);
    const gone = await fetch(`${box.url}/screen/${ada.id}/`, { headers: { cookie } });
    assert.equal(gone.status, 503);
  });

  test("waking B sleeps A so only one Screen is Active", async () => {
    const cookie = await login(box.url);
    const listed = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
    const { bots } = (await listed.json()) as { bots: Array<{ id: string; name: string; screen: string }> };
    const ada = bots.find((bot) => bot.name === "Ada");
    const ben = bots.find((bot) => bot.name === "Ben");
    assert.ok(ada && ben);

    const wakeA = await fetch(`${box.url}/api/bots/${ada.id}/wake`, { method: "POST", headers: { cookie } });
    assert.ok(wakeA.ok);
    const wakeB = await fetch(`${box.url}/api/bots/${ben.id}/wake`, { method: "POST", headers: { cookie } });
    assert.ok(wakeB.ok);
    const b = (await wakeB.json()) as { screen: string };
    assert.equal(b.screen, "active");

    const again = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
    const body = (await again.json()) as {
      bots: Array<{ id: string; name: string; screen: string }>;
    };
    const adaNow = body.bots.find((bot) => bot.name === "Ada");
    const benNow = body.bots.find((bot) => bot.name === "Ben");
    assert.equal(adaNow?.screen, "asleep");
    assert.equal(benNow?.screen, "active");
    assert.equal(screens.running(ada.id), false);
    assert.equal(screens.running(ben.id), true);
  });
});

describe("Sleep kills the ACP child (injected spawn, no Docker)", () => {
  test("sleeping Bot has no ACP child", async () => {
    const dir = await tempDir("openbot-acp-");
    const screens = new MemoryScreenRuntime({ cookiesDir: join(dir, "cookies") });
    const closed: boolean[] = [];
    const store = new BotStore(dir, {
      screens,
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: () => {
        const client = {
          close() {
            closed.push(true);
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
        };
        return client;
      },
    });
    const bot = store.create("Ada");
    assert.equal(store.hasAcpChild(bot.id), false);
    await store.wake(bot.id);
    await store.pickHarness(bot.id, "codex");
    assert.equal(store.hasAcpChild(bot.id), true);
    await store.sleep(bot.id);
    assert.equal(store.hasAcpChild(bot.id), false);
    assert.equal(closed.length >= 1, true);
    const publicBot = store.get(bot.id);
    assert.equal(publicBot?.screen, "asleep");
    assert.equal(publicBot?.eyes.mode, "sleep");
    store.close();
  });

  test("Eyes go sleep then waking while Screen starts", async () => {
    const dir = await tempDir("openbot-wake-");
    const screens = new MemoryScreenRuntime({ cookiesDir: join(dir, "cookies"), delayMs: 40 });
    const store = new BotStore(dir, { screens });
    const bot = store.create("Ada");
    assert.equal(store.get(bot.id)?.eyes.mode, "sleep");
    const waking = store.wake(bot.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(store.get(bot.id)?.screen, "waking");
    assert.equal(store.get(bot.id)?.eyes.mode, "waking");
    await waking;
    assert.equal(store.get(bot.id)?.screen, "active");
    store.close();
  });
});

describe("Docker Screen runtime (injected docker, no daemon)", () => {
  test("wake docker-runs unique name, loopback port not 6901, cookie jar and home volumes", async () => {
    const cookiesDir = join(await tempDir("openbot-dock-"), "cookies");
    const workspaceDir = await tempDir("openbot-ws-");
    const calls: string[][] = [];
    const runtime = new DockerScreenRuntime({
      image: "openbot-screen",
      cookiesDir,
      workspaceDir,
      password: "openbot",
      pickPort: async () => HOST_PORT_FLOOR,
      docker: async (args) => {
        calls.push(args);
        if (args[0] === "inspect") return { code: 1, stdout: "", stderr: "Error: No such object" };
        if (args[0] === "run") return { code: 0, stdout: "abc\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const botId = "11111111-1111-1111-1111-111111111111";
    const handle = await runtime.wake(botId);
    assert.equal(handle.port, HOST_PORT_FLOOR);
    assert.notEqual(handle.port, CONTAINER_PORT);
    assert.equal(handle.name, containerName(botId));
    const run = calls.find((args) => args[0] === "run");
    assert.ok(run, "expected docker run");
    assert.equal(run.includes("pause"), false);
    assert.ok(run.includes(`127.0.0.1:${HOST_PORT_FLOOR}:6901`));
    assert.ok(run.includes(`${cookiesDir}:${COOKIE_MOUNT}`));
    assert.ok(run.includes(`${homeVolume(botId)}:${HOME_MOUNT}`));
    assert.ok(run.includes(`${workspaceDir}:/workspace`));
    assert.equal(runtime.running(botId), true);
  });

  test("sleep is docker stop, not pause, and volumes are not removed", async () => {
    const cookiesDir = join(await tempDir("openbot-dock-"), "cookies");
    const calls: string[][] = [];
    const runtime = new DockerScreenRuntime({
      cookiesDir,
      workspaceDir: await tempDir("openbot-ws-"),
      pickPort: async () => HOST_PORT_FLOOR,
      docker: async (args) => {
        calls.push(args);
        if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ State: { Running: true }, NetworkSettings: { Ports: { "6901/tcp": [{ HostPort: "16901" }] } } }]), stderr: "" };
        if (args[0] === "run") return { code: 0, stdout: "id\n", stderr: "" };
        if (args[0] === "stop") return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "pause") return { code: 1, stdout: "", stderr: "pause forbidden" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const botId = "22222222-2222-2222-2222-222222222222";
    await runtime.wake(botId);
    await runtime.sleep(botId);
    const stop = calls.filter((args) => args[0] === "stop");
    const pause = calls.filter((args) => args[0] === "pause" || args.includes("pause"));
    const rm = calls.filter((args) => args[0] === "rm" || args.includes("-v"));
    assert.equal(stop.length, 1);
    assert.deepEqual(stop[0], ["stop", containerName(botId)]);
    assert.equal(pause.length, 0);
    assert.equal(
      rm.filter((args) => args[0] === "rm" || args[0] === "volume").length,
      0,
    );
    assert.equal(runtime.running(botId), false);
  });
});
