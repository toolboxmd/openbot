import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import type { AcpHandlers } from "../src/acp.ts";
import { BotStore, type AcpSession } from "../src/bots.ts";
import { MemoryComputerRuntime, NoopComputerRuntime } from "../src/computer.ts";
import { spawnSpec } from "../src/harness.ts";
import type { SpawnSpec } from "../src/harness.ts";
import {
  filterAllowlistedTools,
  pathHasPinchTab,
  pinchTabBridgeConfig,
  pinchTabMcpServers,
  pinchTabToolAllowed,
  stripPinchTabFromPath,
} from "../src/pinchtab.ts";
import {
  focusPinchTab,
  shouldBringTabFront,
  tabIdFromToolResult,
} from "../src/pinchtab-mcp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const displaySh = join(here, "../../screen/display.sh");
const xstartup = join(here, "../../screen/xstartup");
const wrapper = join(here, "../src/pinchtab-mcp.mjs");

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function waitUntil(ok: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (ok()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for condition");
}

type Spawned = { spec: SpawnSpec; cwd: string };

function recordingFake() {
  const spawned: Spawned[] = [];
  const answered: string[] = [];
  let handlers: AcpHandlers | undefined;
  const spawnAcp = (spec: SpawnSpec, cwd: string, next?: AcpHandlers): AcpSession => {
    spawned.push({ spec, cwd });
    handlers = next;
    return {
      close() {},
      async initialize() {
        return {};
      },
      async newSession() {
        return "s1";
      },
      async prompt() {
        return "ok";
      },
      cancel() {},
      respondPermission(_rpcId, optionId) {
        answered.push(optionId);
      },
    };
  };
  return {
    spawnAcp,
    spawned,
    answered,
    fire(prompt: Parameters<NonNullable<AcpHandlers["onPermission"]>>[0]) {
      handlers?.onPermission?.(prompt);
    },
  };
}

function startHealth(
  token: string,
  up: () => boolean = () => true,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401);
        res.end("no");
        return;
      }
      if (!up()) {
        res.writeHead(503);
        res.end("down");
        return;
      }
      if ((req.url ?? "").startsWith("/health") || (req.url ?? "").startsWith("/tabs")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, tabs: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("health stub failed to bind"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const FAKE_TOOLS = [
  { name: "pinchtab_navigate" },
  { name: "pinchtab_cookies" },
  { name: "pinchtab_eval" },
  { name: "pinchtab_get_text" },
  { name: "pinchtab_snapshot" },
  { name: "pinchtab_scrape" },
  { name: "pinchtab_pdf" },
  { name: "pinchtab_capture" },
  { name: "pinchtab_record" },
  { name: "pinchtab_network_route" },
  { name: "pinchtab_wait_for_function" },
  { name: "pinchtab_click" },
  { name: "pinchtab_screenshot" },
  { name: "pinchtab_wait" },
];

async function writeFakePinchTab(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import readline from "node:readline";
if (!process.argv.includes("--server") || !process.argv.includes("mcp")) {
  process.stderr.write("expected pinchtab --server <url> mcp\\n");
  process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-pinchtab" } } }) + "\\n");
    return;
  }
  if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: ${JSON.stringify(FAKE_TOOLS)} } }) + "\\n");
    return;
  }
  if (msg.method === "tools/call") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "called:" + msg.params.name }] } }) + "\\n");
  }
});
`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

function rpc(child: { stdin: { write: (s: string) => void } | null }, id: number, method: string, params: unknown = {}): void {
  child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function readRpc(child: { stdout: NodeJS.ReadableStream }, id: number, timeoutMs = 4000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for rpc ${id}`)), timeoutMs);
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { id?: unknown };
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
    };
    child.stdout.on("data", onData);
  });
}

describe("PinchTab allowlist", () => {
  test("screenshot last; cookies eval scrape pdf capture record network-route excluded", () => {
    const filtered = filterAllowlistedTools(FAKE_TOOLS);
    const names = filtered.map((tool) => tool.name);
    assert.deepEqual(
      names.filter((name) => /cookies|eval|scrape|pdf|capture|record|network_route|wait_for_function/i.test(name)),
      [],
    );
    assert.ok(names.includes("pinchtab_navigate"));
    assert.ok(names.includes("pinchtab_get_text"));
    assert.ok(names.includes("pinchtab_snapshot"));
    assert.ok(names.includes("pinchtab_screenshot"));
    assert.equal(names.at(-1), "pinchtab_screenshot");
    assert.equal(pinchTabToolAllowed("navigate"), true);
    assert.equal(pinchTabToolAllowed("pinchtab_navigate"), true);
    assert.equal(pinchTabToolAllowed("pinchtab_cookies"), false);
    assert.equal(pinchTabToolAllowed("pinchtab_eval"), false);
    assert.equal(pinchTabToolAllowed("pinchtab_network_route"), false);
    assert.equal(pinchTabToolAllowed("pinchtab_keyboard"), true);
    assert.equal(pinchTabToolAllowed("back"), true);
    assert.equal(pinchTabToolAllowed("pinchtab_wait_for_selector"), true);
    assert.equal(pinchTabToolAllowed("pinchtab_wait_for_function"), false);
    assert.equal(pinchTabToolAllowed("wait_for_function"), false);
  });

  test("bridge config is open web, IDPI on, eval off, autoSolver off", () => {
    const cfg = pinchTabBridgeConfig("secret", 9867);
    const security = cfg.security as {
      allowedDomains: string[];
      allowEvaluate: boolean;
      allowCookies: boolean;
      idpi: { enabled: boolean; scanContent: boolean; wrapContent: boolean };
    };
    assert.deepEqual(security.allowedDomains, ["*"]);
    assert.equal(security.allowEvaluate, false);
    assert.equal(security.allowCookies, false);
    assert.equal(security.idpi.enabled, true);
    assert.equal(security.idpi.scanContent, true);
    assert.equal(security.idpi.wrapContent, true);
    assert.equal((cfg.autoSolver as { enabled: boolean }).enabled, false);
  });
});

describe("Isolated spawn PATH does not expose pinchtab", () => {
  test("stripPinchTabFromPath prepends a deny shim and keeps docker dirs", async () => {
    const dir = await tempDir("openbot-pt-path-");
    const bin = join(dir, "pinchtab");
    writeFileSync(bin, "#!/bin/sh\necho leaked\n", { mode: 0o755 });
    chmodSync(bin, 0o755);
    writeFileSync(join(dir, "docker"), "#!/bin/sh\necho docker\n", { mode: 0o755 });
    chmodSync(join(dir, "docker"), 0o755);
    const isolated = stripPinchTabFromPath(`${dir}:/usr/bin:/bin`);
    assert.equal(pathHasPinchTab(isolated), false);
    assert.equal(isolated.includes(dir), true);
    const first = isolated.split(":").find(Boolean);
    assert.ok(first?.includes("openbot-pinchtab-deny"));
  });

  test("spawnSpec PATH keeps docker dirs and does not run host pinchtab", async () => {
    const dir = await tempDir("openbot-pt-spawn-");
    const bin = join(dir, "pinchtab");
    writeFileSync(bin, "#!/bin/sh\necho leaked\n", { mode: 0o755 });
    chmodSync(bin, 0o755);
    writeFileSync(join(dir, "docker"), "#!/bin/sh\necho docker\n", { mode: 0o755 });
    chmodSync(join(dir, "docker"), 0o755);
    const prev = process.env.PATH ?? "";
    process.env.PATH = `${dir}:${prev}`;
    try {
      const spec = spawnSpec("codex");
      assert.equal(pathHasPinchTab(spec.env.PATH ?? ""), false);
      assert.equal((spec.env.PATH ?? "").includes(dir), true);
      assert.equal(spec.env.PINCHTAB_TOKEN, undefined);
    } finally {
      process.env.PATH = prev;
    }
  });
});

describe("session/new mcpServers attach only when Screen and bridge are Up", () => {
  const prevBin = process.env.OPENBOT_PINCHTAB;
  let fakeBin = "";

  test("chat-only Noop does not attach MCP", async () => {
    const homeDir = await tempDir("openbot-pt-noop-");
    const fake = recordingFake();
    const store = new BotStore(homeDir, {
      computer: new NoopComputerRuntime(join(homeDir, "cookies")),
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
    });
    const ada = await store.create("Ada");
    await store.pickHarness(ada.id, "codex");
    await store.send(ada.id, "hi");
    await waitUntil(() => fake.spawned.length > 0);
    assert.deepEqual(fake.spawned[0]?.spec.mcpServers ?? [], []);
    store.close();
  });

  test("Memory Screen without a healthy bridge does not attach MCP", async () => {
    const homeDir = await tempDir("openbot-pt-down-");
    const fake = recordingFake();
    const store = new BotStore(homeDir, {
      computer: new MemoryComputerRuntime({
        cookiesDir: join(homeDir, "cookies"),
        pinchTabUpstreams: ["http://127.0.0.1:1"],
        pinchTabToken: "x",
      }),
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
    });
    const ada = await store.create("Ada");
    await store.pickHarness(ada.id, "codex");
    await store.send(ada.id, "hi");
    await waitUntil(() => fake.spawned.length > 0);
    assert.deepEqual(fake.spawned[0]?.spec.mcpServers ?? [], []);
    store.close();
  });

  test("Screen Up and healthy bridge attaches allowlist wrapper", async () => {
    const homeDir = await tempDir("openbot-pt-up-");
    fakeBin = await writeFakePinchTab(await tempDir("openbot-pt-bin-"));
    process.env.OPENBOT_PINCHTAB = fakeBin;
    const health = await startHealth("bridge-token");
    try {
      const fake = recordingFake();
      const store = new BotStore(homeDir, {
        computer: new MemoryComputerRuntime({
          cookiesDir: join(homeDir, "cookies"),
          pinchTabUpstreams: [health.url],
          pinchTabToken: "bridge-token",
        }),
        listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
        spawnAcp: fake.spawnAcp,
      });
      const ada = await store.create("Ada");
      await store.pickHarness(ada.id, "codex");
      await store.send(ada.id, "hi");
      await waitUntil(() => fake.spawned.length > 0);
      const servers = fake.spawned[0]?.spec.mcpServers ?? [];
      assert.equal(servers.length, 1);
      assert.equal(servers[0]?.name, "pinchtab");
      assert.ok(servers[0]?.command.includes("node"));
      assert.ok(servers[0]?.args.some((arg) => arg.endsWith("pinchtab-mcp.mjs")));
      assert.equal("startup_timeout_sec" in (servers[0] ?? {}), false);
      assert.equal("required" in (servers[0] ?? {}), false);
      assert.equal((servers[0]?._meta as { startup_timeout_sec?: number })?.startup_timeout_sec, 30);
      assert.ok(servers[0]?.env.some((row) => row.name === "PATH" && row.value));
      const env = Object.fromEntries((servers[0]?.env ?? []).map((row) => [row.name, row.value]));
      assert.equal(env.OPENBOT_PINCHTAB, fakeBin);
      assert.equal(env.OPENBOT_PINCHTAB_SERVER, health.url);
      assert.equal(env.PINCHTAB_TOKEN, "bridge-token");
      assert.equal(pathHasPinchTab(fake.spawned[0]?.spec.env.PATH ?? ""), false);
      fake.fire({
        rpcId: 8,
        title: "mcp__pinchtab__pinchtab_navigate",
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "decline", name: "Decline", kind: "reject_once" },
        ],
        rawInput: { url: "https://example.com" },
      });
      assert.deepEqual(fake.answered, ["allow_once"]);
      assert.equal(store.get(ada.id)?.permission, null);
      fake.fire({
        rpcId: 7,
        title: "Allow this tool?",
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "decline", name: "Decline", kind: "reject_once" },
        ],
        rawInput: { command: "ls" },
      });
      assert.deepEqual(fake.answered, ["allow_once", "allow_once"]);
      assert.equal(store.get(ada.id)?.permission, null);
      fake.fire({
        rpcId: 9,
        title: "Write file",
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "decline", name: "Decline", kind: "reject_once" },
        ],
        locations: [{ path: "/tmp/outside-pt.txt" }],
        toolKind: "edit",
      });
      assert.ok(store.get(ada.id)?.permission?.hostGrant);
      store.close();
    } finally {
      await health.close();
    }
  });

  test("ACP respawns with PinchTab MCP when the bridge becomes healthy", async () => {
    const homeDir = await tempDir("openbot-pt-retry-");
    fakeBin = await writeFakePinchTab(await tempDir("openbot-pt-retry-bin-"));
    process.env.OPENBOT_PINCHTAB = fakeBin;
    let up = false;
    const health = await startHealth("retry-token", () => up);
    try {
      const fake = recordingFake();
      const store = new BotStore(homeDir, {
        computer: new MemoryComputerRuntime({
          cookiesDir: join(homeDir, "cookies"),
          pinchTabUpstreams: [health.url],
          pinchTabToken: "retry-token",
        }),
        listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
        spawnAcp: fake.spawnAcp,
      });
      const ada = await store.create("Ada");
      await store.pickHarness(ada.id, "codex");
      await store.send(ada.id, "hi");
      await waitUntil(() => fake.spawned.length > 0, 8_000);
      assert.deepEqual(fake.spawned[0]?.spec.mcpServers ?? [], []);
      up = true;
      await store.send(ada.id, "again");
      await waitUntil(() => fake.spawned.length > 1, 8_000);
      const servers = fake.spawned[1]?.spec.mcpServers ?? [];
      assert.equal(servers.length, 1);
      assert.equal(servers[0]?.name, "pinchtab");
      store.close();
    } finally {
      await health.close();
    }
  });

  after(() => {
    if (prevBin === undefined) delete process.env.OPENBOT_PINCHTAB;
    else process.env.OPENBOT_PINCHTAB = prevBin;
  });
});

describe("PinchTab MCP allowlist proxy", () => {
  test("tools/list is allowlisted with screenshot last; blocked tools/call is rejected", async () => {
    const bin = await writeFakePinchTab(await tempDir("openbot-pt-proxy-"));
    const child = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        OPENBOT_PINCHTAB: bin,
        OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
        PINCHTAB_TOKEN: "t",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      rpc(child, 1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
      await readRpc(child, 1);
      rpc(child, 2, "tools/list");
      const listed = await readRpc(child, 2);
      const tools = ((listed.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((tool) => tool.name);
      assert.ok(tools.includes("pinchtab_navigate"));
      assert.ok(tools.includes("pinchtab_screenshot"));
      assert.equal(tools.at(-1), "pinchtab_screenshot");
      assert.equal(
        tools.some((name) => /cookies|eval|scrape|pdf|capture|record|network_route|wait_for_function/i.test(name)),
        false,
      );
      rpc(child, 3, "tools/call", { name: "pinchtab_cookies", arguments: {} });
      const blocked = await readRpc(child, 3);
      assert.ok(blocked.error, "cookies must be rejected");
      rpc(child, 5, "tools/call", { name: "pinchtab_wait_for_function", arguments: { expression: "1" } });
      const evalBlocked = await readRpc(child, 5);
      assert.ok(evalBlocked.error, "wait_for_function must be rejected");
      rpc(child, 4, "tools/call", { name: "pinchtab_navigate", arguments: { url: "https://example.com" } });
      const allowed = await readRpc(child, 4);
      const text = JSON.stringify(allowed.result ?? {});
      assert.match(text, /called:pinchtab_navigate/);
    } finally {
      child.kill("SIGTERM");
    }
  });
});

describe("Computer cookie jar copy", () => {
  test("display.sh cookies-in then cookies-out copies the jar", async () => {
    const root = await tempDir("openbot-pt-cookies-");
    const home = join(root, "home");
    const jar = join(root, "cookies");
    mkdirSync(join(home, ".config", "google-chrome", "Default", "Network"), { recursive: true });
    mkdirSync(jar, { recursive: true });
    writeFileSync(join(jar, "Cookies"), "jar-in");
    mkdirSync(join(jar, "Network"), { recursive: true });
    writeFileSync(join(jar, "Network", "Cookies"), "net-in");
    writeFileSync(join(jar, "Local State"), '{"os_crypt":{"encrypted_key":"in"}}');
    const env = {
      ...process.env,
      OPENBOT_SCREEN_HOME: home,
      COOKIE_JAR: jar,
      VNC_USER: "openbot",
    };
    const inn = spawn("bash", [displaySh, "cookies-in", "1"], { env, stdio: "inherit" });
    const inCode = await new Promise<number>((resolve) => inn.on("close", (code) => resolve(code ?? 1)));
    assert.equal(inCode, 0);
    assert.equal(readFileSync(join(home, ".config", "google-chrome", "Default", "Cookies"), "utf8"), "jar-in");
    assert.equal(
      readFileSync(join(home, ".config", "google-chrome", "Default", "Network", "Cookies"), "utf8"),
      "net-in",
    );
    assert.equal(
      readFileSync(join(home, ".config", "google-chrome", "Local State"), "utf8"),
      '{"os_crypt":{"encrypted_key":"in"}}',
    );
    writeFileSync(join(home, ".config", "google-chrome", "Default", "Cookies"), "jar-out");
    writeFileSync(join(home, ".config", "google-chrome", "Default", "Cookies-wal"), "wal-out");
    writeFileSync(join(home, ".config", "google-chrome", "Local State"), '{"os_crypt":{"encrypted_key":"k"}}');
    writeFileSync(join(home, ".config", "google-chrome", "Default", "Network", "Cookies"), "net-out");
    writeFileSync(join(home, ".config", "google-chrome", "Default", "Network", "Cookies-wal"), "net-wal");
    const out = spawn("bash", [displaySh, "cookies-out", "1"], { env, stdio: "inherit" });
    const outCode = await new Promise<number>((resolve) => out.on("close", (code) => resolve(code ?? 1)));
    assert.equal(outCode, 0);
    assert.equal(readFileSync(join(jar, "Cookies"), "utf8"), "jar-out");
    assert.equal(readFileSync(join(jar, "Cookies-wal"), "utf8"), "wal-out");
    assert.equal(readFileSync(join(jar, "Local State"), "utf8"), '{"os_crypt":{"encrypted_key":"k"}}');
    assert.equal(readFileSync(join(jar, "Network", "Cookies"), "utf8"), "net-out");
    assert.equal(readFileSync(join(jar, "Network", "Cookies-wal"), "utf8"), "net-wal");
  });

  test("display.sh stop copies the jar when Chrome is already gone", async () => {
    const root = await tempDir("openbot-pt-stop-");
    const home = join(root, "home");
    const jar = join(root, "cookies");
    mkdirSync(join(home, ".config", "google-chrome", "Default", "Network"), { recursive: true });
    mkdirSync(jar, { recursive: true });
    writeFileSync(join(home, ".config", "google-chrome", "Default", "Cookies"), "stop-out");
    writeFileSync(join(home, ".config", "google-chrome", "Default", "Cookies-wal"), "stop-wal");
    writeFileSync(join(home, ".config", "google-chrome", "Local State"), '{"os_crypt":{"encrypted_key":"stop"}}');
    const env = {
      ...process.env,
      OPENBOT_SCREEN_HOME: home,
      COOKIE_JAR: jar,
      VNC_USER: "openbot",
    };
    const stopped = spawn("bash", [displaySh, "stop", "1"], { env, stdio: "inherit" });
    const code = await new Promise<number>((resolve) => stopped.on("close", (status) => resolve(status ?? 1)));
    assert.equal(code, 0);
    assert.equal(readFileSync(join(jar, "Cookies"), "utf8"), "stop-out");
    assert.equal(readFileSync(join(jar, "Cookies-wal"), "utf8"), "stop-wal");
    assert.equal(readFileSync(join(jar, "Local State"), "utf8"), '{"os_crypt":{"encrypted_key":"stop"}}');
    assert.equal(readFileSync(join(jar, "Network", "Cookies"), "utf8"), "stop-out");
  });

  test("cookies-in promotes legacy Cookies into Default/Network/Cookies", async () => {
    const root = await tempDir("openbot-pt-promote-");
    const home = join(root, "home");
    const jar = join(root, "cookies");
    mkdirSync(join(home, ".config", "google-chrome", "Default"), { recursive: true });
    mkdirSync(jar, { recursive: true });
    writeFileSync(join(jar, "Cookies"), "legacy-jar");
    writeFileSync(join(jar, "Cookies-wal"), "legacy-wal");
    const env = {
      ...process.env,
      OPENBOT_SCREEN_HOME: home,
      COOKIE_JAR: jar,
      VNC_USER: "openbot",
    };
    const inn = spawn("bash", [displaySh, "cookies-in", "1"], { env, stdio: "inherit" });
    const code = await new Promise<number>((resolve) => inn.on("close", (status) => resolve(status ?? 1)));
    assert.equal(code, 0);
    assert.equal(
      readFileSync(join(home, ".config", "google-chrome", "Default", "Network", "Cookies"), "utf8"),
      "legacy-jar",
    );
    assert.equal(
      readFileSync(join(home, ".config", "google-chrome", "Default", "Network", "Cookies-wal"), "utf8"),
      "legacy-wal",
    );
  });

  test("display.sh stop_chrome does not pass --user-data-dir as a pgrep flag", () => {
    const body = readFileSync(displaySh, "utf8");
    assert.match(body, /pkill -f -- /);
    assert.match(body, /pgrep -af -- /);
    assert.doesNotMatch(body, /pgrep -f "--user-data-dir/);
    assert.doesNotMatch(body, /pkill -f "--user-data-dir/);
  });

  test("Screen Chrome loads the extension that strips PinchTab port titles", () => {
    const body = readFileSync(xstartup, "utf8");
    assert.match(body, /--load-extension=\/etc\/openbot\/strip-pinchtab-title/);
    const strip = readFileSync(join(here, "../../screen/chrome-ext/strip-pinchtab-title/strip.js"), "utf8");
    assert.match(strip, /\\\[PinchTab :\\d\+/);
  });
});

describe("PinchTab tab focus", () => {
  test("tabIdFromToolResult reads MCP text JSON", () => {
    assert.equal(tabIdFromToolResult({ tabId: "abc" }), "abc");
    assert.equal(
      tabIdFromToolResult({ content: [{ type: "text", text: JSON.stringify({ tabId: "from-text" }) }] }),
      "from-text",
    );
    assert.equal(shouldBringTabFront("pinchtab_navigate"), true);
    assert.equal(shouldBringTabFront("pinchtab_snapshot"), false);
  });

  test("focusPinchTab POSTs action=focus", async () => {
    const seen: Array<{ url?: string; body?: string }> = [];
    const stub = await new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          seen.push({ url: req.url, body: Buffer.concat(chunks).toString("utf8") });
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("focus stub failed"));
          return;
        }
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise((done) => server.close(() => done())),
        });
      });
    });
    try {
      await focusPinchTab(stub.url, "tok", "tab-1");
      assert.equal(seen[0]?.url, "/tab");
      assert.deepEqual(JSON.parse(seen[0]?.body ?? "{}"), { action: "focus", tabId: "tab-1" });
    } finally {
      await stub.close();
    }
  });
});

describe("pinchTabMcpServers fail closed", () => {
  test("missing host pinchtab does not attach", async () => {
    const prev = process.env.OPENBOT_PINCHTAB;
    process.env.OPENBOT_PINCHTAB = join(tmpdir(), "no-such-pinchtab-binary");
    try {
      const computer = new MemoryComputerRuntime({
        pinchTabUpstreams: ["http://127.0.0.1:1"],
        pinchTabToken: "t",
      });
      await computer.allocate("ada");
      assert.deepEqual(await pinchTabMcpServers(computer, "ada"), []);
    } finally {
      if (prev === undefined) delete process.env.OPENBOT_PINCHTAB;
      else process.env.OPENBOT_PINCHTAB = prev;
    }
  });
});

