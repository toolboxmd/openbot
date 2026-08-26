import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { startBox, type RunningBox } from "../src/box.ts";
import { pickScreenPorts, DockerComputerRuntime, DISPLAY_BIN } from "../src/computer.ts";
import { listHarnessesOnPath, spawnSpec } from "../src/harness.ts";
import { defaultWorkspaceDir } from "../src/home.ts";
import { pinchTabHealthy, pinchTabMcpServers, resolvePinchTabBin } from "../src/pinchtab.ts";

const PASSWORD = "correct-horse";
const POLL_MS = 180_000;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const PINCHTAB_RELEASE = "v0.15.2";

function cookieHeader(res: Response): string {
  return res.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

function liveCodexAvailable(): boolean {
  if (!listHarnessesOnPath().some((item) => item.id === "codex")) return false;
  try {
    spawnSpec("codex");
    return true;
  } catch {
    return false;
  }
}

if (!liveCodexAvailable()) {
  throw new Error("codex is required on PATH for PinchTab Talk MCP live Done; do not skip");
}

function dockerOk(): boolean {
  const probe = spawnSync("docker", ["info"], { stdio: "ignore" });
  return probe.status === 0;
}

if (!dockerOk()) {
  throw new Error("docker is required for PinchTab Talk MCP live Done; do not skip");
}

function pinchTabAssetName(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return `pinchtab-${os}-${arch}`;
}

function ensureHostPinchTab(): string {
  const existing = resolvePinchTabBin();
  if (existing) return existing;
  const destDir = join(homedir(), ".local", "bin");
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, "pinchtab");
  const url = `https://github.com/pinchtab/pinchtab/releases/download/${PINCHTAB_RELEASE}/${pinchTabAssetName()}`;
  const curl = spawnSync("curl", ["-fsSL", "-o", dest, url], { encoding: "utf8" });
  if (curl.status !== 0) {
    throw new Error(`failed to install host pinchtab from ${url}: ${curl.stderr}`);
  }
  chmodSync(dest, 0o755);
  const again = resolvePinchTabBin();
  if (!again) throw new Error("host pinchtab installed but not executable");
  return again;
}

async function emptyPwa(): Promise<string> {
  const dist = join(repoRoot, "pwa", "dist");
  if (existsSync(join(dist, "index.html"))) return dist;
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-pt-live-pwa-"));
  await writeFile(join(pwaDir, "index.html"), `<!doctype html><title>OpenBot</title>`);
  return pwaDir;
}

async function login(url: string): Promise<string> {
  const res = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const body = await res.text();
  assert.ok(res.ok, `login failed: ${res.status} ${body}`);
  const cookie = cookieHeader(res);
  assert.ok(cookie, "login did not return a cookie");
  return cookie;
}

type PublicMessage = { id: string; role: "user" | "assistant"; text: string; kind?: string };

type PublicBot = {
  id: string;
  write?: boolean;
  needsYou?: { reason?: string } | null;
  permission?: { title?: string; options?: Array<{ optionId: string; name?: string }>; hostGrant?: unknown } | null;
  messages?: PublicMessage[];
};

async function getBot(url: string, cookie: string, botId: string): Promise<PublicBot> {
  const res = await fetch(`${url}/api/bots/${botId}`, { headers: { cookie } });
  const body = await res.text();
  if (!res.ok) throw new Error(`GET bot failed: ${res.status} ${body}`);
  return JSON.parse(body) as PublicBot;
}

function assistantText(messages: PublicMessage[], afterCount = 0): string {
  return messages
    .filter((message) => message.role === "assistant" && message.text)
    .slice(afterCount)
    .map((message) => message.text)
    .join("\n");
}

function allText(messages: PublicMessage[]): string {
  return messages.map((message) => message.text).join("\n");
}

async function pollIdle(url: string, cookie: string, botId: string, timeoutMs = POLL_MS): Promise<PublicBot> {
  const start = Date.now();
  let last: PublicBot | null = null;
  while (Date.now() - start < timeoutMs) {
    last = await getBot(url, cookie, botId);
    const optionId = last.permission?.options?.find((option) => /allow/i.test(option.optionId))?.optionId;
    if (last.permission && optionId && !last.permission.hostGrant) {
      await fetch(`${url}/api/bots/${botId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ optionId }),
      });
    }
    if (last.write === false) return last;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`timed out waiting for idle; last=${JSON.stringify(last)}`);
}

async function createBot(url: string, cookie: string, name: string): Promise<string> {
  const created = await fetch(`${url}/api/bots`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const createdBody = await created.text();
  assert.equal(created.status, 201, `create ${name} failed: ${created.status} ${createdBody}`);
  const bot = JSON.parse(createdBody) as { id: string };
  const picked = await fetch(`${url}/api/bots/${bot.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ harness: "codex" }),
  });
  const pickedBody = await picked.text();
  assert.ok(picked.ok, `pick harness failed: ${picked.status} ${pickedBody}`);
  return bot.id;
}

async function postText(url: string, cookie: string, botId: string, text: string): Promise<void> {
  const posted = await fetch(`${url}/api/bots/${botId}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const postedBody = await posted.text();
  if (!posted.ok) assert.fail(`POST messages failed: ${posted.status} ${postedBody}`);
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${cmd} ${args.join(" ")} exited ${code}\n${Buffer.concat(out).toString("utf8")}\n${Buffer.concat(err).toString("utf8")}`,
        ),
      );
    });
  });
}

async function waitHealth(url: string, token: string, timeoutMs = 180_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pinchTabHealthy(url, token, 2000)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`PinchTab bridge was not healthy at ${url}`);
}

function startCookieServer(secret: string): Promise<{ origin: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/login") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": `openbot_pt=${secret}; Path=/; SameSite=Lax`,
        });
        res.end(
          `<!doctype html><html><body>LOGIN-PAGE-OK You are logged in.<script>document.cookie="openbot_pt=${secret};path=/"</script></body></html>`,
        );
        return;
      }
      if (url.pathname === "/whoami") {
        const cookies = String(req.headers.cookie ?? "");
        const ok = cookies.split(";").some((part) => part.trim() === `openbot_pt=${secret}`);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          ok
            ? "<html><body>WHOAMI-COOKIE-OK You are logged in.</body></html>"
            : "<html><body>WHOAMI-COOKIE-MISSING Please log in.</body></html>",
        );
        return;
      }
      res.writeHead(404);
      res.end("no");
    });
    server.listen(0, "0.0.0.0", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("cookie server failed to bind"));
        return;
      }
      resolve({
        origin: `http://host.docker.internal:${addr.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe("Live PinchTab Talk MCP", { timeout: 1_200_000 }, () => {
  let box: RunningBox;
  let cookie = "";
  let adaId = "";
  let homeDir = "";
  let workspaceDir = "";
  let token = "";
  let kasmPort = 0;
  let pinchTabPorts: number[] = [];
  const container = "openbot-screen";
  let cookieServer: { origin: string; close: () => Promise<void> } | undefined;
  const cookieSecret = `pt59-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  before(async () => {
    ensureHostPinchTab();
    token = `live-${Date.now().toString(16)}`;
    const screenPorts = await pickScreenPorts(8);
    pinchTabPorts = await pickScreenPorts(8, screenPorts);
    kasmPort = screenPorts[0]!;
    mkdirSync(join(homedir(), ".openbot-pt-live"), { recursive: true });
    homeDir = await mkdtemp(join(homedir(), ".openbot-pt-live", "home-"));
    workspaceDir = defaultWorkspaceDir(homeDir);
    const cookiesDir = join(homeDir, "cookies");
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(cookiesDir, { recursive: true });
    cookieServer = await startCookieServer(cookieSecret);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENBOT_PASSWORD: PASSWORD,
      OPENBOT_HOME: homeDir,
      OPENBOT_WORKSPACE: workspaceDir,
      OPENBOT_COOKIES: cookiesDir,
      PINCHTAB_TOKEN: token,
      SCREEN_PORTS: screenPorts.join(","),
      PINCHTAB_PORTS: pinchTabPorts.join(","),
    };
    screenPorts.forEach((port, i) => {
      env[`SCREEN_PORT_${i + 1}`] = String(port);
    });
    pinchTabPorts.forEach((port, i) => {
      env[`PINCHTAB_PORT_${i + 1}`] = String(port);
    });
    await run("docker", ["compose", "up", "--detach", "--build", "--force-recreate", "screen"], env);
    await waitHealth(`http://127.0.0.1:${pinchTabPorts[0]}`, token);
    const computer = new DockerComputerRuntime({
      containerName: container,
      hostPorts: screenPorts,
      pinchTabHostPorts: pinchTabPorts,
      pinchTabToken: token,
      cookiesDir,
      workspaceDir,
    });
    box = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      homeDir,
      workspaceDir,
      screenUpstream: `http://127.0.0.1:${kasmPort}`,
      kasmUser: "openbot",
      kasmPassword: PASSWORD,
      computer,
    });
    cookie = await login(box.url);
    adaId = await createBot(box.url, cookie, "Ada");
    const bridge = computer.pinchTab(adaId);
    if (!bridge) throw new Error("Ada Screen has no PinchTab handle");
    const servers = await pinchTabMcpServers(computer, adaId);
    if (servers.length === 0) {
      throw new Error(
        `PinchTab MCP not attached bin=${resolvePinchTabBin()} url=${bridge.url} token=${bridge.token ? "set" : "missing"}`,
      );
    }
    await writeFile(
      join(workspaceDir, "bots", adaId, "AGENTS.md"),
      `# This Bot\nUse PinchTab MCP for the browser. Do not exec pinchtab from PATH. Do not open host Chrome. Do not use Playwright.\n`,
    );
    await postText(box.url, cookie, adaId, "Reply with the exact word READY.");
    await pollIdle(box.url, cookie, adaId);
  });

  after(async () => {
    await box?.close();
    await cookieServer?.close();
  });

  test("Isolated Ada Session lists only allowlisted PinchTab tools", async () => {
    const prior = ((await getBot(box.url, cookie, adaId)).messages ?? []).filter(
      (message) => message.role === "assistant" && message.text,
    ).length;
    await postText(
      box.url,
      cookie,
      adaId,
      "List every PinchTab MCP tool you can call. Reply with the exact tool names, one per line. If you have no PinchTab tools, reply with the exact words NO-PINCHTAB. Do not invent tools.",
    );
    const idle = await pollIdle(box.url, cookie, adaId);
    assert.equal(idle.needsYou, null, `login/auth failed: ${JSON.stringify(idle.needsYou)}`);
    const text = assistantText(idle.messages ?? [], prior);
    assert.doesNotMatch(text, /NO-PINCHTAB/);
    assert.match(text, /navigate/i);
    assert.match(text, /get_text|gettext/i);
    assert.match(text, /snapshot/i);
    assert.match(text, /screenshot/i);
    assert.doesNotMatch(text, /pinchtab_cookies/i);
    assert.doesNotMatch(text, /pinchtab_eval/i);
    assert.doesNotMatch(text, /pinchtab_scrape/i);
    assert.doesNotMatch(text, /pinchtab_pdf/i);
    assert.doesNotMatch(text, /pinchtab_capture/i);
    assert.doesNotMatch(text, /pinchtab_record/i);
    assert.doesNotMatch(text, /network[_-]route/i);
  });

  test("Ada opens a public page on Screen Chrome; Computer preview shows it", async () => {
    await postText(
      box.url,
      cookie,
      adaId,
      "Using PinchTab MCP, open https://example.com. Use get_text first, then snapshot. Screenshot only if you must. Reply with the page title and one short quote from the text. Do not exec pinchtab from PATH. Do not open host Chrome.",
    );
    const idle = await pollIdle(box.url, cookie, adaId);
    const text = assistantText(idle.messages ?? []);
    assert.match(text, /example/i);
    const computer = await fetch(`${box.url}/api/computer?botId=${encodeURIComponent(adaId)}`, {
      headers: { cookie },
    });
    const computerBody = await computer.text();
    assert.ok(computer.ok, computerBody);
    const body = JSON.parse(computerBody) as { path?: string; ready?: boolean };
    assert.equal(body.ready, true);
    assert.equal(body.path, `/screen/${adaId}/`);
    const screen = await fetch(`${box.url}${body.path}`, { headers: { cookie } });
    assert.ok(screen.ok, `GET ${body.path} failed: ${screen.status}`);
    await postText(
      box.url,
      cookie,
      adaId,
      "Take one PinchTab screenshot of the current page if you can, then reply with the exact word SCREENSHOT-OK. If screenshot is unavailable, say SCREENSHOT-NO.",
    );
    const shot = await pollIdle(box.url, cookie, adaId);
    const shotText = assistantText(shot.messages ?? []);
    assert.match(shotText, /SCREENSHOT-OK|SCREENSHOT-NO/i);
  });

  test("cookie jar: Ada login reaches Ben after Ben's Screen starts; chat has no cookie values", async () => {
    assert.ok(cookieServer);
    await postText(
      box.url,
      cookie,
      adaId,
      `Using PinchTab, navigate exactly to ${cookieServer.origin}/login and no other URL. Then get_text. Reply with the visible page text. The right page says LOGIN-PAGE-OK. Do not print cookie values.`,
    );
    const adaIdle = await pollIdle(box.url, cookie, adaId);
    const adaText = assistantText(adaIdle.messages ?? []);
    assert.doesNotMatch(allText(adaIdle.messages ?? []), new RegExp(cookieSecret));
    assert.match(adaText, /LOGIN-PAGE-OK/);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    let copied = spawnSync("docker", ["exec", container, DISPLAY_BIN, "cookies-out", "1"], { encoding: "utf8" });
    for (let i = 0; i < 4 && copied.status !== 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      copied = spawnSync("docker", ["exec", container, DISPLAY_BIN, "cookies-out", "1"], { encoding: "utf8" });
    }
    assert.equal(copied.status, 0, copied.stderr);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const benId = await createBot(box.url, cookie, "Ben");
    await waitHealth(`http://127.0.0.1:${pinchTabPorts[1]}`, token);
    await writeFile(
      join(workspaceDir, "bots", benId, "AGENTS.md"),
      `# This Bot\nUse PinchTab MCP for the browser. Do not print cookie values.\n`,
    );
    await postText(
      box.url,
      cookie,
      benId,
      `Using PinchTab, navigate exactly to ${cookieServer.origin}/whoami and no other URL. Then get_text. Reply with the visible page text. Do not print cookie values.`,
    );
    const benIdle = await pollIdle(box.url, cookie, benId);
    const benText = assistantText(benIdle.messages ?? []);
    assert.match(benText, /WHOAMI-COOKIE-OK/);
    assert.doesNotMatch(allText(benIdle.messages ?? []), new RegExp(cookieSecret));
    assert.doesNotMatch(allText(adaIdle.messages ?? []), new RegExp(cookieSecret));
  });

  test("captcha path is screenshot and clicks then Open computer, not a solver", async () => {
    const before = (await getBot(box.url, cookie, adaId)).messages ?? [];
    const prior = before.filter((message) => message.role === "assistant" && message.text).length;
    await postText(
      box.url,
      cookie,
      adaId,
      "If a captcha appears, which PinchTab tools do you use, in order? Do you have pinchtab_eval or cookie tools? Reply in a few short sentences. Name Open computer if that is the fallback.",
    );
    const idle = await pollIdle(box.url, cookie, adaId);
    const text = assistantText(idle.messages ?? [], prior);
    assert.match(text, /screenshot/i);
    assert.match(text, /click/i);
    assert.match(text, /Open computer/i);
    assert.doesNotMatch(text, /capsolver|2captcha/i);
    assert.doesNotMatch(text, /use pinchtab_eval/i);
  });

  test("PinchTab stopped: Ada does not drive host Chrome; she asks to Open computer", async () => {
    const killed = spawnSync("docker", ["exec", container, "pkill", "-f", "pinchtab"], { encoding: "utf8" });
    assert.ok(killed.status === 0 || killed.status === 1, killed.stderr);
    const switched = await fetch(`${box.url}/api/bots/${adaId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ configMode: "host" }),
    });
    assert.ok(switched.ok, await switched.text());
    const isolated = await fetch(`${box.url}/api/bots/${adaId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ configMode: "isolated" }),
    });
    assert.ok(isolated.ok, await isolated.text());
    await postText(
      box.url,
      cookie,
      adaId,
      "Open https://example.com in the browser now. If PinchTab is down, do not open host Chrome and do not use Playwright. Ask me to Open computer if you cannot browse.",
    );
    const idle = await pollIdle(box.url, cookie, adaId);
    const text = assistantText(idle.messages ?? []);
    assert.match(text, /Open computer|Computer/i);
    assert.doesNotMatch(text, /Playwright/i);
  });
});
