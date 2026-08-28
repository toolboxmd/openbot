import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { startBox, type RunningBox } from "../src/box.ts";
import { pickScreenPorts, DockerComputerRuntime, DISPLAY_BIN } from "../src/computer.ts";
import { listHarnessesOnPath, spawnSpec } from "../src/harness.ts";
import { defaultWorkspaceDir } from "../src/home.ts";
import {
  pinchTabHealthy,
  pinchTabMcpServers,
  pinchTabWrapperCommand,
  resolvePinchTabBin,
  waitForPinchTabBridge,
} from "../src/pinchtab.ts";

const PASSWORD = "correct-horse";
const POLL_MS = 180_000;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const LIVE_SCOPE = process.env.OPENBOT_PINCHTAB_LIVE_SCOPE ?? "acceptance";
const SUPERVISION_SCOPE = LIVE_SCOPE === "supervision";

if (!SUPERVISION_SCOPE && LIVE_SCOPE !== "acceptance") {
  throw new Error(`unknown OPENBOT_PINCHTAB_LIVE_SCOPE=${LIVE_SCOPE}`);
}

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

if (!SUPERVISION_SCOPE && !liveCodexAvailable()) {
  throw new Error("codex is required on PATH for PinchTab Talk MCP live Done; do not skip");
}

function dockerOk(): boolean {
  const probe = spawnSync("docker", ["info"], { stdio: "ignore" });
  return probe.status === 0;
}

if (!dockerOk()) {
  throw new Error("docker is required for PinchTab Talk MCP live Done; do not skip");
}

function requireHostPinchTab(): string {
  const existing = resolvePinchTabBin();
  if (existing) return existing;
  throw new Error("host pinchtab is required for live proof; this test never installs it");
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

function writeRpc(child: { stdin: { write: (s: string) => boolean } | null }, id: number, method: string, params: unknown = {}): void {
  child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function readRpc(child: { stdout: NodeJS.ReadableStream }, id: number, timeoutMs = 12_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for rpc ${id}`)), timeoutMs);
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const text = buf.toString("utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("Content-Length")) continue;
        const json = trimmed.includes("{") ? trimmed.slice(trimmed.indexOf("{")) : trimmed;
        try {
          const msg = JSON.parse(json) as { id?: unknown };
          if (msg.id === id) {
            clearTimeout(timer);
            child.stdout.off("data", onData);
            resolve(msg as Record<string, unknown>);
            return;
          }
        } catch {
          /* wait */
        }
      }
      const headerEnd = buf.indexOf(Buffer.from("\r\n\r\n"));
      if (headerEnd !== -1) {
        const header = buf.subarray(0, headerEnd).toString("utf8");
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (match) {
          const len = Number(match[1]);
          const start = headerEnd + 4;
          if (buf.length >= start + len) {
            try {
              const msg = JSON.parse(buf.subarray(start, start + len).toString("utf8")) as { id?: unknown };
              if (msg.id === id) {
                clearTimeout(timer);
                child.stdout.off("data", onData);
                resolve(msg as Record<string, unknown>);
              }
            } catch {
              /* wait */
            }
          }
        }
      }
    };
    child.stdout.on("data", onData);
  });
}

async function listWrapperTools(server: string, token: string): Promise<string[]> {
  const wrapper = pinchTabWrapperCommand();
  const bin = resolvePinchTabBin();
  if (!wrapper || !bin) return [];
  const child = spawn(wrapper.command, [...wrapper.args, "--bin", bin, "--server", server], {
    env: {
      ...process.env,
      OPENBOT_PINCHTAB: bin,
      OPENBOT_PINCHTAB_SERVER: server,
      PINCHTAB_TOKEN: token,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    writeRpc(child, 1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "openbot-live" },
    });
    await readRpc(child, 1);
    writeRpc(child, 2, "tools/list");
    const listed = await readRpc(child, 2);
    return ((listed.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((tool) => tool.name);
  } finally {
    child.kill("SIGTERM");
  }
}

async function runLiveWrapperSequence(
  bin: string,
  server: string,
  token: string,
  targetUrl: string,
  expectedText: string,
): Promise<void> {
  const wrapper = pinchTabWrapperCommand();
  if (!wrapper) throw new Error("PinchTab MCP wrapper is unavailable");
  const child = spawn(wrapper.command, [...wrapper.args, "--bin", bin, "--server", server], {
    env: {
      ...process.env,
      OPENBOT_PINCHTAB: bin,
      OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "30000",
      OPENBOT_PINCHTAB_SERVER: server,
      PINCHTAB_TOKEN: token,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    writeRpc(child, 1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "openbot-pt94-live" },
    });
    const initialized = await readRpc(child, 1, 30_000);
    assert.equal(initialized.error, undefined, JSON.stringify(initialized));

    writeRpc(child, 2, "tools/list");
    const listed = await readRpc(child, 2, 30_000);
    assert.equal(listed.error, undefined, JSON.stringify(listed));
    const tools = ((listed.result as { tools?: Array<{ name?: string }> })?.tools ?? [])
      .map((tool) => tool.name ?? "")
      .filter(Boolean);
    const navigate = tools.find((name) => /navigate/i.test(name));
    const getText = tools.find((name) => /get[_-]?text|gettext/i.test(name));
    assert.ok(navigate, `live wrapper has no navigate tool: ${tools.join(",")}`);
    assert.ok(getText, `live wrapper has no get_text tool: ${tools.join(",")}`);

    const navigatedPromise = readRpc(child, 3, 60_000);
    const textPromise = readRpc(child, 4, 60_000);
    writeRpc(child, 3, "tools/call", { name: navigate, arguments: { url: targetUrl } });
    writeRpc(child, 4, "tools/call", { name: getText, arguments: {} });
    const [navigated, text] = await Promise.all([navigatedPromise, textPromise]);
    assert.equal(navigated.error, undefined, JSON.stringify(navigated));
    assert.equal(text.error, undefined, JSON.stringify(text));
    assert.match(JSON.stringify(text.result ?? {}), new RegExp(expectedText));
  } finally {
    child.kill("SIGTERM");
  }
}

function dockerChecked(args: string[]): string {
  const result = spawnSync("docker", args, { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, `docker ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

type SharedScreenSnapshot = {
  container: {
    id: string;
    imageId: string;
    portBindings: unknown;
    restartCount: number;
    running: boolean;
    startedAt: string;
    status: string;
  } | null;
  tagImageId: string | null;
};

function optionalDockerInspect<T>(args: string[], missing: RegExp): T | undefined {
  const result = spawnSync("docker", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status === 0) {
    const values = JSON.parse(result.stdout) as T[];
    assert.equal(values.length, 1, `docker ${args.join(" ")} returned ${values.length} objects`);
    return values[0];
  }
  assert.equal(result.status, 1, `docker ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, missing, `docker ${args.join(" ")} failed unexpectedly`);
  return undefined;
}

function sharedScreenSnapshot(): SharedScreenSnapshot {
  const container = optionalDockerInspect<{
    Id: string;
    Image: string;
    HostConfig: { PortBindings: unknown };
    RestartCount: number;
    State: { Running: boolean; StartedAt: string; Status: string };
  }>(["container", "inspect", "openbot-screen"], /no such container/iu);
  const image = optionalDockerInspect<{
    Id: string;
  }>(["image", "inspect", "openbot-screen:latest"], /no such image/iu);
  return {
    container: container
      ? {
          id: container.Id,
          imageId: container.Image,
          portBindings: container.HostConfig.PortBindings,
          restartCount: container.RestartCount,
          running: container.State.Running,
          startedAt: container.State.StartedAt,
          status: container.State.Status,
        }
      : null,
    tagImageId: image?.Id ?? null,
  };
}

function composeImages(composeArgs: string[], env: NodeJS.ProcessEnv): string[] {
  const result = spawnSync("docker", [...composeArgs, "config", "--images"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `docker ${[...composeArgs, "config", "--images"].join(" ")} failed\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function dockerImageExists(image: string): boolean {
  return optionalDockerInspect(["image", "inspect", image], /no such image/iu) !== undefined;
}

type LiveOwner = {
  display: number;
  port: number;
  supervisorPid: number;
  supervisorStart: string;
  childPid: number;
  childStart: string;
  binary: string;
  config: string;
};

function liveOwner(container: string, screenHome: string, display: number): LiveOwner {
  return JSON.parse(
    dockerChecked(["exec", container, "cat", `${screenHome}/.pinchtab-d${display}/bridge-owner.json`]),
  ) as LiveOwner;
}

function assertSingleLiveOwner(container: string, display: number, owner: LiveOwner): void {
  const processes = dockerChecked(["exec", container, "ps", "-eo", "pid=,args="])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const child = processes.filter(
    (line) => line.includes("pinchtab bridge") && line.includes(`--port ${9866 + display}`),
  );
  const supervisor = processes.filter(
    (line) => line.includes("openbot-display") && line.includes(`pinchtab-supervise ${display}`),
  );
  assert.equal(child.length, 1, `display ${display} bridge processes: ${child.join(" | ")}`);
  assert.equal(supervisor.length, 1, `display ${display} supervisors: ${supervisor.join(" | ")}`);
  assert.match(child[0] ?? "", new RegExp(`^${owner.childPid}\\s`));
  assert.match(supervisor[0] ?? "", new RegExp(`^${owner.supervisorPid}\\s`));
}

async function waitScreen(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastObservation = "no HTTP response";
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(2_000, remainingMs))),
      });
      lastObservation = `HTTP ${response.status}`;
      void response.body?.cancel().catch(() => undefined);
      if (screenHttpReady(response.status)) return;
    } catch (error) {
      lastObservation =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    const retryDelayMs = Math.min(500, Math.max(0, deadline - Date.now()));
    if (retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw new Error(
    `Screen did not become ready at ${url} within ${timeoutMs}ms; last observation: ${lastObservation}`,
  );
}

function screenHttpReady(status: number): boolean {
  return status === 401 || (status >= 200 && status < 300);
}

function startLiveProofPage(
  marker: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>PinchTab 94</title><main>${marker}</main>`);
    });
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("live proof page failed to bind"));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function startCookieServer(
  secret: string,
): Promise<{ port: number; setHost: (host: string) => string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/login") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": `openbot_pt=${secret}; Path=/; SameSite=Lax; Max-Age=86400`,
        });
        res.end(
          `<!doctype html><html><body>LOGIN-PAGE-OK You are logged in.<script>document.cookie="openbot_pt=${secret};path=/;max-age=86400"</script></body></html>`,
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
        port: addr.port,
        setHost: (host: string) => `http://${host}:${addr.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const COOKIE_HOST = "openbot-cookies.test";
const ADA_CHROME_PROFILE = "/home/openbot/.config/google-chrome";

function cookieHostsFromDb(dbPath: string): string[] {
  if (!existsSync(dbPath)) return [];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare("select distinct host_key from cookies").all() as Array<{ host_key?: string }>;
      return rows.map((row) => String(row.host_key ?? "")).filter(Boolean);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function currentCookieSnapshot(jar: string): string {
  return resolve(jar, readlinkSync(join(jar, "current")));
}

function listChromeCookieFiles(containerName: string, profile: string): string {
  const listing = spawnSync(
    "docker",
    ["exec", containerName, "ls", "-la", `${profile}/Default`, `${profile}/Default/Network`],
    { encoding: "utf8" },
  );
  return `${listing.stdout}\n${listing.stderr}`;
}

function dockerCp(containerName: string, src: string, dest: string): void {
  spawnSync("docker", ["cp", `${containerName}:${src}`, dest], { encoding: "utf8" });
}

function copyChromeCookieDbs(containerName: string, profile: string, dest: string): string[] {
  rmSync(dest, { recursive: true, force: true });
  const networkDest = join(dest, "Network");
  const legacyDest = join(dest, "Legacy");
  mkdirSync(networkDest, { recursive: true });
  mkdirSync(legacyDest, { recursive: true });
  dockerCp(containerName, `${profile}/Default/Network/.`, `${networkDest}/`);
  for (const name of ["Cookies", "Cookies-journal", "Cookies-wal", "Cookies-shm"]) {
    dockerCp(containerName, `${profile}/Default/${name}`, join(legacyDest, name));
  }
  return [...cookieHostsFromDb(join(networkDest, "Cookies")), ...cookieHostsFromDb(join(legacyDest, "Cookies"))];
}

async function waitForNetworkCookieHost(
  containerName: string,
  profile: string,
  dest: string,
  host: string,
  timeoutMs = 20_000,
): Promise<string[]> {
  const start = Date.now();
  let hosts: string[] = [];
  while (Date.now() - start < timeoutMs) {
    hosts = copyChromeCookieDbs(containerName, profile, dest);
    if (hosts.some((item) => item.includes(host))) return hosts;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Ada Chrome cookie DBs missing ${host} hosts=${hosts.join(",")} files=${listChromeCookieFiles(containerName, profile)}`,
  );
}

if (SUPERVISION_SCOPE) {
  describe("Screen HTTP readiness contract", () => {
    test("accepts exactly 2xx or the KasmVNC 401 challenge", () => {
      for (const status of [200, 204, 299, 401]) {
        assert.equal(screenHttpReady(status), true, `expected HTTP ${status} to be ready`);
      }
      for (const status of [199, 300, 400, 403, 404, 500]) {
        assert.equal(screenHttpReady(status), false, `expected HTTP ${status} not to be ready`);
      }
    });

    test("reports the last non-ready status within the total deadline", async () => {
      const server = http.createServer((_req, res) => {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("starting");
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");

      try {
        const startedAt = Date.now();
        await assert.rejects(
          waitScreen(`http://127.0.0.1:${address.port}`, 100),
          /within 100ms; last observation: HTTP 503/,
        );
        assert.ok(Date.now() - startedAt < 750, "Screen readiness exceeded its total deadline bound");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe("Live Screen and PinchTab supervision", { timeout: 1_200_000 }, () => {
    const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
    const container = `openbot-screen-pt94-${nonce}`;
    const disposableImage = `openbot-screen-pt94-${nonce}:live`;
    const project = `openbot-pt94-${nonce}`;
    const vncUser = `pt94${nonce.slice(0, 8)}`;
    const screenHome = `/home/${vncUser}`;
    const display = 2 + (Number.parseInt(nonce.slice(0, 2), 16) % 7);
    const marker = `PINCHTAB-94-LIVE-${nonce}`;
    let runtimeRoot = "";
    let composeArgs: string[] = [];
    let env: NodeJS.ProcessEnv = {};
    let hostBin = "";
    let screenPorts: number[] = [];
    let pinchTabPorts: number[] = [];
    let token = "";
    let proofPage: { port: number; close: () => Promise<void> } | undefined;
    let sharedBefore: SharedScreenSnapshot | undefined;

    before(async () => {
      sharedBefore = sharedScreenSnapshot();
      assert.equal(
        dockerImageExists(disposableImage),
        false,
        `disposable image already exists: ${disposableImage}`,
      );
      hostBin = requireHostPinchTab();
      runtimeRoot = await mkdtemp(join(tmpdir(), "openbot-pt94-live-"));
      const homeDir = join(runtimeRoot, "home");
      const workspaceDir = defaultWorkspaceDir(homeDir);
      const cookiesDir = join(homeDir, "cookies");
      mkdirSync(workspaceDir, { recursive: true });
      mkdirSync(cookiesDir, { recursive: true });
      screenPorts = await pickScreenPorts(8);
      pinchTabPorts = await pickScreenPorts(8, screenPorts);
      token = `pt94-${nonce}-${randomUUID()}`;
      const override = join(runtimeRoot, "compose.override.json");
      await writeFile(
        override,
        JSON.stringify({
          services: {
            screen: {
              container_name: container,
              image: disposableImage,
              restart: "no",
              environment: { VNC_USER: vncUser },
            },
          },
        }),
      );
      composeArgs = [
        "compose",
        "--project-name",
        project,
        "--file",
        join(repoRoot, "docker-compose.yml"),
        "--file",
        override,
      ];
      env = {
        ...process.env,
        OPENBOT_HOME: homeDir,
        OPENBOT_PASSWORD: PASSWORD,
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
      assert.deepEqual(
        composeImages(composeArgs, env),
        [disposableImage],
        "isolated supervision compose config must not target openbot-screen:latest",
      );
      assert.deepEqual(sharedScreenSnapshot(), sharedBefore, "compose preflight mutated the shared Screen");
      proofPage = await startLiveProofPage(marker);

      await run(
        "docker",
        [...composeArgs, "up", "--detach", "--build", "--force-recreate", "screen"],
        env,
      );
      assert.equal(
        dockerChecked(["container", "inspect", "--format", "{{.Config.Image}}", container]).trim(),
        disposableImage,
        "isolated supervision container used the shared Screen image tag",
      );
      assert.deepEqual(sharedScreenSnapshot(), sharedBefore, "isolated compose up mutated the shared Screen");
      await run("docker", ["exec", container, DISPLAY_BIN, "start", String(display)], env);
      await waitScreen(`http://127.0.0.1:${screenPorts[display - 1]}`);
      assert.equal(
        await waitForPinchTabBridge(
          `http://127.0.0.1:${pinchTabPorts[display - 1]}`,
          token,
          90_000,
        ),
        true,
        `health plus ensure-browser failed for ${container}:${display}`,
      );
    });

    after(async () => {
      const cleanupErrors: string[] = [];
      try {
        await proofPage?.close();
      } catch (error) {
        cleanupErrors.push(`proof page cleanup failed: ${String(error)}`);
      }
      if (composeArgs.length > 0) {
        const stopped = spawnSync("docker", [...composeArgs, "down", "--volumes", "--remove-orphans"], {
          cwd: repoRoot,
          env,
          encoding: "utf8",
        });
        if (stopped.status !== 0) {
          spawnSync("docker", ["rm", "--force", container], { cwd: repoRoot, encoding: "utf8" });
          cleanupErrors.push(`live container cleanup failed: ${stopped.stdout}\n${stopped.stderr}`);
        }
      }
      if (dockerImageExists(disposableImage)) {
        const removed = spawnSync("docker", ["image", "rm", disposableImage], {
          cwd: repoRoot,
          encoding: "utf8",
        });
        if (removed.status !== 0) {
          cleanupErrors.push(`disposable image cleanup failed: ${removed.stdout}\n${removed.stderr}`);
        }
      }
      if (dockerImageExists(disposableImage)) {
        cleanupErrors.push(`disposable image survived cleanup: ${disposableImage}`);
      }
      if (sharedBefore) {
        try {
          assert.deepEqual(sharedScreenSnapshot(), sharedBefore);
        } catch (error) {
          cleanupErrors.push(`shared Screen changed during isolated live proof: ${String(error)}`);
        }
      }
      if (runtimeRoot) {
        try {
          rmSync(runtimeRoot, { recursive: true, force: true });
        } catch (error) {
          cleanupErrors.push(`runtime root cleanup failed: ${String(error)}`);
        }
      }
      if (cleanupErrors.length > 0) assert.fail(cleanupErrors.join("\n"));
    });

    test("one durable owner survives concurrent starts, restarts cleanly, and serializes real tools", async () => {
      const bridgeUrl = `http://127.0.0.1:${pinchTabPorts[display - 1]}`;
      const first = liveOwner(container, screenHome, display);
      assert.equal(first.display, display);
      assert.equal(first.port, 9866 + display);
      assert.equal(first.binary, "/usr/local/bin/pinchtab");
      assert.equal(first.config, `${screenHome}/.pinchtab-d${display}/config.json`);
      const config = JSON.parse(
        dockerChecked(["exec", container, "cat", first.config]),
      ) as { profiles?: { baseDir?: string; defaultProfile?: string } };
      assert.equal(config.profiles?.baseDir, `${screenHome}/.config`);
      assert.equal(config.profiles?.defaultProfile, `google-chrome-d${display}`);
      assertSingleLiveOwner(container, display, first);

      await Promise.all(
        Array.from({ length: 3 }, () =>
          run("docker", ["exec", container, DISPLAY_BIN, "pinchtab", String(display)], env),
        ),
      );
      assert.deepEqual(liveOwner(container, screenHome, display), first);
      assertSingleLiveOwner(container, display, first);

      await run("docker", ["exec", container, DISPLAY_BIN, "stop", String(display)], env);
      const ownerGone = spawnSync(
        "docker",
        ["exec", container, "test", "!", "-e", `${screenHome}/.pinchtab-d${display}/bridge-owner.json`],
        { encoding: "utf8" },
      );
      assert.equal(ownerGone.status, 0, ownerGone.stderr);
      for (const pid of [first.supervisorPid, first.childPid]) {
        const dead = spawnSync(
          "docker",
          ["exec", container, "bash", "-c", 'kill -0 "$1" 2>/dev/null', "openbot-pt94", String(pid)],
          { encoding: "utf8" },
        );
        assert.notEqual(dead.status, 0, `stale PinchTab pid ${pid} survived stop`);
      }

      await run("docker", ["exec", container, DISPLAY_BIN, "start", String(display)], env);
      await waitScreen(`http://127.0.0.1:${screenPorts[display - 1]}`);
      assert.equal(await waitForPinchTabBridge(bridgeUrl, token, 90_000), true);
      const second = liveOwner(container, screenHome, display);
      assert.notEqual(second.supervisorPid, first.supervisorPid);
      assert.notEqual(second.childPid, first.childPid);
      assertSingleLiveOwner(container, display, second);

      assert.ok(proofPage);
      await runLiveWrapperSequence(
        hostBin,
        bridgeUrl,
        token,
        `http://host.docker.internal:${proofPage.port}/proof`,
        marker,
      );
    });
  });
} else {
describe("Live PinchTab Talk MCP", { timeout: 1_200_000 }, () => {
  let box: RunningBox;
  let cookie = "";
  let adaId = "";
  let homeDir = "";
  let workspaceDir = "";
  let cookiesDir = "";
  let token = "";
  let kasmPort = 0;
  let pinchTabPorts: number[] = [];
  const container = "openbot-screen";
  let cookieServer: { origin: string; close: () => Promise<void> } | undefined;
  const cookieSecret = `pt59-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  before(async () => {
    requireHostPinchTab();
    token = `live-${Date.now().toString(16)}`;
    const screenPorts = await pickScreenPorts(8);
    pinchTabPorts = await pickScreenPorts(8, screenPorts);
    kasmPort = screenPorts[0]!;
    homeDir = await mkdtemp(join(tmpdir(), "openbot-pt59-live-home-"));
    workspaceDir = defaultWorkspaceDir(homeDir);
    cookiesDir = join(homeDir, "cookies");
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(cookiesDir, { recursive: true });
    const cookieHttp = await startCookieServer(cookieSecret);
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
    cookieServer = {
      origin: cookieHttp.setHost(COOKIE_HOST),
      close: cookieHttp.close,
    };
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
      `# This Bot\nUse PinchTab MCP for the browser. Search MCP tools for pinchtab if they are not already visible. Do not exec pinchtab from PATH. Do not open host Chrome. Do not use Playwright.\n`,
    );
    await postText(box.url, cookie, adaId, "Reply with the exact word READY.");
    await pollIdle(box.url, cookie, adaId);
  });

  after(async () => {
    await box?.close();
    await cookieServer?.close();
  });

  test("Isolated Ada Session lists only allowlisted PinchTab tools", async () => {
    const wrapperTools = await listWrapperTools(`http://127.0.0.1:${pinchTabPorts[0]}`, token);
    assert.ok(
      wrapperTools.some((name) => /navigate/i.test(name)),
      `stock wrapper tools/list missed navigate: ${wrapperTools.join(",")}`,
    );
    assert.equal(
      wrapperTools.some((name) => /cookies|eval|scrape|pdf|capture|record|network[_-]route|wait_for_function/i.test(name)),
      false,
      `allowlist leaked: ${wrapperTools.join(",")}`,
    );
    const prior = ((await getBot(box.url, cookie, adaId)).messages ?? []).filter(
      (message) => message.role === "assistant" && message.text,
    ).length;
    await postText(
      box.url,
      cookie,
      adaId,
      "Search MCP tools for pinchtab (use tool_search or /mcp if needed). Then list every PinchTab MCP tool you can call, one name per line. If none exist after searching, reply with the exact words NO-PINCHTAB. Do not invent tools.",
    );
    const idle = await pollIdle(box.url, cookie, adaId);
    assert.equal(idle.needsYou, null, `login/auth failed: ${JSON.stringify(idle.needsYou)}`);
    const text = assistantText(idle.messages ?? [], prior);
    assert.doesNotMatch(
      text,
      /NO-PINCHTAB/,
      `Codex Session has no PinchTab tools; wrapper listed ${wrapperTools.join(",")}`,
    );
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
    assert.doesNotMatch(text, /wait_for_function/i);
  });

  test("Ada opens a public page on Screen Chrome; Computer preview shows it", async () => {
    await postText(
      box.url,
      cookie,
      adaId,
      "Search MCP tools for pinchtab if they are not already visible. Using PinchTab MCP, open https://example.com. Use get_text first, then snapshot. Screenshot only if you must. Reply with the page title and one short quote from the text. Do not exec pinchtab from PATH. Do not open host Chrome.",
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

  test("cookie jar: Ada login reaches Ben after Ada Screen stop; chat has no cookie values", async () => {
    assert.ok(cookieServer);
    await postText(
      box.url,
      cookie,
      adaId,
      `Search MCP tools for pinchtab if they are not already visible. Using only PinchTab MCP (not curl, wget, or docker exec), navigate exactly to ${cookieServer.origin}/login and no other URL. Then get_text. Reply with the visible page text. The right page says LOGIN-PAGE-OK. Do not print cookie values.`,
    );
    const adaIdle = await pollIdle(box.url, cookie, adaId);
    const adaText = assistantText(adaIdle.messages ?? []);
    assert.doesNotMatch(allText(adaIdle.messages ?? []), new RegExp(cookieSecret));
    assert.match(adaText, /LOGIN-PAGE-OK/);
    const probeDir = join(cookiesDir, "probe-ada-network");
    const adaHosts = await waitForNetworkCookieHost(container, ADA_CHROME_PROFILE, probeDir, COOKIE_HOST);
    assert.ok(
      adaHosts.some((host) => host.includes(COOKIE_HOST)),
      `Ada Default/Network/Cookies hosts=${adaHosts.join(",")} files=${listChromeCookieFiles(container, ADA_CHROME_PROFILE)}`,
    );
    const tokenState = dockerChecked([
      "exec",
      container,
      "stat",
      "-c",
      "%a %U %G",
      "/etc/openbot/secrets",
      "/etc/openbot/secrets/pinchtab.token",
    ])
      .trim()
      .split("\n");
    assert.deepEqual(tokenState, ["700 root root", "600 root root"]);
    const bridgeState = dockerChecked([
      "exec",
      container,
      "stat",
      "-c",
      "%a",
      "/home/openbot/.pinchtab-d1",
      "/home/openbot/.pinchtab-d1/config.json",
      "/home/openbot/.pinchtab-d1/authorization.header",
      "/home/openbot/.pinchtab-d1/bridge.log",
    ])
      .trim()
      .split("\n");
    assert.deepEqual(bridgeState, ["700", "600", "600", "600"]);
    const containerProcesses = dockerChecked(["exec", container, "ps", "-eo", "args="]);
    const hostProcesses = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" }).stdout;
    assert.equal(containerProcesses.includes(token), false, "container process argv exposed the PinchTab credential");
    assert.equal(hostProcesses.includes(token), false, "host process argv exposed the PinchTab credential");
    assert.equal(containerProcesses.includes("Authorization: Bearer"), false, "container argv exposed authorization");
    assert.equal(hostProcesses.includes("Authorization: Bearer"), false, "host argv exposed authorization");
    const stopped = spawnSync("docker", ["exec", container, DISPLAY_BIN, "stop", "1"], { encoding: "utf8" });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /cookie export committed generation/u);
    const snapshot = currentCookieSnapshot(cookiesDir);
    const manifest = readFileSync(join(snapshot, "manifest"), "utf8");
    assert.match(manifest, /^schema=1\nstate=committed\ngeneration=generation-[A-Za-z0-9]+\nepoch=[0-9]+\n$/u);
    assert.equal(modeOf(cookiesDir), 0o700);
    assert.equal(modeOf(join(cookiesDir, "snapshots")), 0o700);
    assert.equal(modeOf(snapshot), 0o700);
    assert.equal(modeOf(join(snapshot, "manifest")), 0o600);
    assert.equal(modeOf(join(snapshot, "Network", "Cookies")), 0o600);
    const jarHosts = cookieHostsFromDb(join(snapshot, "Network", "Cookies"));
    assert.ok(
      jarHosts.some((host) => host.includes(COOKIE_HOST)),
      `jar Network/Cookies missing ${COOKIE_HOST} hosts=${jarHosts.join(",")} files=${listChromeCookieFiles(container, ADA_CHROME_PROFILE)}`,
    );
    const benId = await createBot(box.url, cookie, "Ben");
    await waitHealth(`http://127.0.0.1:${pinchTabPorts[1]}`, token);
    await writeFile(
      join(workspaceDir, "bots", benId, "AGENTS.md"),
      `# This Bot\nUse PinchTab MCP for the browser. Search MCP tools for pinchtab if they are not already visible. Do not print cookie values.\n`,
    );
    await postText(
      box.url,
      cookie,
      benId,
      `Search MCP tools for pinchtab if they are not already visible. Using only PinchTab MCP (not curl, wget, or docker exec), navigate exactly to ${cookieServer.origin}/whoami and no other URL. Then get_text. Reply with the visible page text. Do not print cookie values.`,
    );
    const benIdle = await pollIdle(box.url, cookie, benId);
    const benText = assistantText(benIdle.messages ?? []);
    assert.match(benText, /WHOAMI-COOKIE-OK/);
    assert.doesNotMatch(allText(benIdle.messages ?? []), new RegExp(cookieSecret));
    assert.doesNotMatch(allText(adaIdle.messages ?? []), new RegExp(cookieSecret));
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
}
