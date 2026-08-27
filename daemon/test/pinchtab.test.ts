import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import type { AcpHandlers } from "../src/acp.ts";
import { BotStore, type AcpSession } from "../src/bots.ts";
import { MemoryComputerRuntime, NoopComputerRuntime } from "../src/computer.ts";
import { spawnSpec } from "../src/harness.ts";
import type { SpawnSpec } from "../src/harness.ts";
import {
  filterAllowlistedTools,
  ensurePinchTabBrowser,
  pathHasPinchTab,
  pinchTabBridgeConfig,
  pinchTabHealthy,
  pinchTabMcpServers,
  pinchTabToolAllowed,
  stripPinchTabFromPath,
  waitForPinchTabBridge,
} from "../src/pinchtab.ts";
import {
  focusPinchTab,
  prepareBrowseCall,
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
      if (
        (req.url ?? "").startsWith("/health") ||
        (req.url ?? "").startsWith("/tabs") ||
        (req.url ?? "").startsWith("/ensure-browser")
      ) {
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

async function writeExitOnCallPinchTab(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "exit-on-call" } } }) + "\\n");
    return;
  }
  if (msg.method === "tools/call") process.exit(23);
});
`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

async function writeMalformedListPinchTab(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "malformed-list" } } }) + "\\n");
    return;
  }
  if (msg.method === "tools/list") {
    process.stdout.write("not-json\\n" + JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "pinchtab_cookies" }] } }) + "\\n");
  }
});
`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

async function writeDuplicateListPinchTab(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "duplicate-list" } } }) + "\\n");
    return;
  }
  if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "pinchtab_navigate" }, { name: "pinchtab_cookies" }] } }) + "\\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "pinchtab_cookies" }] } }) + "\\n");
  }
});
`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

async function writeDelayedReusePinchTab(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
const log = process.env.OPENBOT_ID_CALL_LOG;
const reply = (msg, tools) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools } }) + "\\n");
let listCalls = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "delayed-reuse" } } }) + "\\n");
    return;
  }
  if (msg.method !== "tools/list") return;
  listCalls += 1;
  if (log) fs.appendFileSync(log, String(msg.id) + "\\n");
  if (listCalls === 1) {
    reply(msg, [{ name: "pinchtab_navigate" }]);
    setTimeout(() => reply(msg, [{ name: "pinchtab_snapshot" }]), 200);
    return;
  }
  setTimeout(() => reply(msg, [{ name: "pinchtab_get_text" }]), 450);
});
`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

async function writeDelayedConcurrentIdPinchTab(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
const log = process.env.OPENBOT_ID_CALL_LOG;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "concurrent-id" } } }) + "\\n");
    return;
  }
  if (msg.method !== "tools/list") return;
  if (log) fs.appendFileSync(log, String(msg.id) + "\\n");
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "pinchtab_navigate" }] } }) + "\\n");
  }, 250);
});
`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

async function writeSilentListPinchTab(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "silent-list" } } }) + "\\n");
    return;
  }
  if (msg.method === "tools/list") setTimeout(() => process.exit(0), 900);
});
`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

async function writeClosedStdinPinchTab(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
if (process.env.OPENBOT_STDIN_FAIL_PID_FILE) fs.writeFileSync(process.env.OPENBOT_STDIN_FAIL_PID_FILE, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method !== "initialize") return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "closed-stdin" } } }) + "\\n");
  setTimeout(() => {
    rl.close();
    try { fs.closeSync(0); } catch {}
  }, 10);
});
`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

async function writeIgnoreEofPinchTab(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
if (process.env.OPENBOT_EOF_CHILD_PID_FILE) fs.writeFileSync(process.env.OPENBOT_EOF_CHILD_PID_FILE, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "ignore-eof" } } }) + "\\n");
  }
});
`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

async function writeDelayedNavigationPinchTab(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const reply = (msg, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    reply(msg, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "delayed-navigation" } });
    return;
  }
  if (msg.method !== "tools/call") return;
  if (msg.params.name === "pinchtab_navigate") {
    setTimeout(() => reply(msg, { tabId: "tab-new", content: [{ type: "text", text: "navigated" }] }), 150);
    return;
  }
  reply(msg, { content: [{ type: "text", text: "called:" + msg.params.name }] });
});
`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

async function writeHangingPinchTab(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
const log = process.env.OPENBOT_HANG_LOG;
const record = (line) => { if (log) fs.appendFileSync(log, line + "\\n"); };
const reply = (msg, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
process.on("SIGTERM", () => record("sigterm"));
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    reply(msg, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hanging" } });
    return;
  }
  if (msg.method !== "tools/call") return;
  record("call:" + msg.id);
  if (msg.id === 2) {
    setTimeout(() => {
      record("late:2");
      reply(msg, { content: [{ type: "text", text: "late-result" }] });
    }, 600);
    setTimeout(() => process.exit(0), 900);
    return;
  }
  reply(msg, { content: [{ type: "text", text: "overlap:" + msg.id }] });
});
`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

async function writeSupervisedBridgeFixture(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import http from "node:http";
const index = process.argv.indexOf("--port");
const port = Number(process.argv[index + 1]);
const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/ensure-browser") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: req.url === "/health" ? "ok" : "browser_ready" }));
    return;
  }
  res.writeHead(404);
  res.end();
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
server.listen(port, "127.0.0.1");
`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

async function writeTransientEnsureBridgeFixture(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
const index = process.argv.indexOf("--port");
const port = Number(process.argv[index + 1]);
let ensureCalls = 0;
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (req.url === "/ensure-browser") {
    ensureCalls += 1;
    if (process.env.OPENBOT_ENSURE_CALLS_FILE) fs.appendFileSync(process.env.OPENBOT_ENSURE_CALLS_FILE, String(ensureCalls) + "\\n");
    res.writeHead(ensureCalls === 1 ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: ensureCalls === 1 ? "starting" : "browser_ready" }));
    return;
  }
  res.writeHead(404);
  res.end();
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
server.listen(port, "127.0.0.1");
`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

async function writeSetsidFixture(dir: string): Promise<string> {
  const file = join(dir, "setsid");
  await writeFile(
    file,
    `#!/bin/sh
if [ -n "\${OPENBOT_SETSID_LOG:-}" ]; then printf '%s\\n' "$$" >> "$OPENBOT_SETSID_LOG"; fi
if [ -n "\${OPENBOT_SETSID_DELAY_SEC:-}" ]; then sleep "$OPENBOT_SETSID_DELAY_SEC"; fi
exec "$@"
`,
    { encoding: "utf8", mode: 0o755 },
  );
  chmodSync(file, 0o755);
  return file;
}

async function writeCurlFixture(dir: string): Promise<{ file: string; real: string }> {
  const real = spawnSync("sh", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim();
  assert.ok(real, "curl is required for the display lifecycle fixture");
  const file = join(dir, "curl");
  const body = `#!/bin/sh
{
  for arg in "$@"; do printf '<%s>' "$arg"; done
  printf '\\n'
} >> "$OPENBOT_CURL_LOG"
if [ "\${OPENBOT_CURL_FAIL:-}" = "1" ]; then
  echo "curl: (28) fixture request timed out" >&2
  exit 28
fi
exec "$OPENBOT_REAL_CURL" "$@"
`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  return { file, real };
}

function unusedLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("temporary port allocation failed"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

function readRpcOrder(child: { stdout: NodeJS.ReadableStream }, ids: number[], timeoutMs = 4000): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const wanted = new Set(ids);
    const seen: number[] = [];
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for rpc order ${ids.join(",")}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as { id?: unknown };
          if (typeof message.id === "number" && wanted.has(message.id) && !seen.includes(message.id)) {
            seen.push(message.id);
          }
        } catch {
          /* wait */
        }
      }
      if (seen.length === wanted.size) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve(seen);
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
    assert.equal((cfg.instanceDefaults as { captureAllowActivation?: boolean }).captureAllowActivation, true);
    assert.equal((cfg.security as { attach: { enabled: boolean } }).attach.enabled, false);
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
  const prevPath = process.env.PATH ?? "";
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
    process.env.PATH = `${dirname(fakeBin)}${delimiter}${prevPath}`;
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
    process.env.PATH = `${dirname(fakeBin)}${delimiter}${prevPath}`;
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
    process.env.PATH = prevPath;
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

  test("a preparation failure rejects the JSON-RPC request instead of hanging", async () => {
    const bin = await writeFakePinchTab(await tempDir("openbot-pt-prepare-fail-"));
    const stub = await new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        req.resume();
        if (req.url === "/tabs") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ tabs: [{ id: "tab-fail", type: "page" }] }));
          return;
        }
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "focus unavailable" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("prepare-failure stub failed"));
          return;
        }
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise((done) => server.close(() => done())),
        });
      });
    });
    const child = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        OPENBOT_PINCHTAB: bin,
        OPENBOT_PINCHTAB_SERVER: stub.url,
        PINCHTAB_TOKEN: "t",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      rpc(child, 1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
      await readRpc(child, 1);
      rpc(child, 2, "tools/call", { name: "pinchtab_click", arguments: {} });
      const failed = await readRpc(child, 2, 750);
      assert.match(JSON.stringify(failed.error ?? {}), /focus|503/i);
    } finally {
      child.kill("SIGTERM");
      await stub.close();
    }
  });

  test("a child exit rejects the pending JSON-RPC request instead of hanging", async () => {
    const bin = await writeExitOnCallPinchTab(await tempDir("openbot-pt-child-exit-"));
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
      rpc(child, 2, "tools/call", { name: "pinchtab_get_text", arguments: {} });
      const failed = await readRpc(child, 2, 750);
      assert.match(JSON.stringify(failed.error ?? {}), /exit|closed|transport/i);
    } finally {
      child.kill("SIGTERM");
    }
  });

  test("malformed child output fails closed without forwarding raw or unfiltered bytes", async () => {
    const bin = await writeMalformedListPinchTab(await tempDir("openbot-pt-child-malformed-"));
    const child = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        OPENBOT_PINCHTAB: bin,
        OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
        PINCHTAB_TOKEN: "t",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => (output += chunk.toString("utf8"));
    try {
      rpc(child, 1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
      await readRpc(child, 1);
      child.stdout.on("data", collect);
      rpc(child, 2, "tools/list");
      const failed = await readRpc(child, 2, 750);
      await new Promise((resolve) => setTimeout(resolve, 40));

      assert.match(JSON.stringify(failed.error ?? {}), /malformed|parse|JSON-RPC|framing/i);
      assert.equal(
        output
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line) as { id?: number };
            } catch {
              return {};
            }
          })
          .filter((message) => message.id === 2).length,
        1,
        output,
      );
      assert.doesNotMatch(output, /not-json|pinchtab_cookies/u);
    } finally {
      child.stdout.off("data", collect);
      child.kill("SIGTERM");
    }
  });

  test("a duplicate child response is dropped instead of bypassing the allowlist", async () => {
    const bin = await writeDuplicateListPinchTab(await tempDir("openbot-pt-child-duplicate-list-"));
    const child = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        OPENBOT_PINCHTAB: bin,
        OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
        PINCHTAB_TOKEN: "t",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => (output += chunk.toString("utf8"));
    try {
      rpc(child, 1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
      await readRpc(child, 1);
      child.stdout.on("data", collect);
      rpc(child, 2, "tools/list");
      await readRpc(child, 2);
      await new Promise((resolve) => setTimeout(resolve, 40));

      const responses = output
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id?: number; result?: unknown })
        .filter((message) => message.id === 2);
      assert.equal(responses.length, 1, output);
      assert.doesNotMatch(JSON.stringify(responses), /pinchtab_cookies/u);
    } finally {
      child.stdout.off("data", collect);
      child.kill("SIGTERM");
    }
  });

  test("a delayed old response cannot satisfy a reused client ID generation", async () => {
    const dir = await tempDir("openbot-pt-child-delayed-reuse-");
    const bin = await writeDelayedReusePinchTab(dir);
    const callLog = join(dir, "calls.log");
    const child = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        OPENBOT_ID_CALL_LOG: callLog,
        OPENBOT_PINCHTAB: bin,
        OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
        PINCHTAB_TOKEN: "t",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => (output += chunk.toString("utf8"));
    try {
      rpc(child, 1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
      await readRpc(child, 1);
      rpc(child, 7, "tools/list");
      const first = await readRpc(child, 7);
      assert.match(JSON.stringify(first.result ?? {}), /pinchtab_navigate/u);

      child.stdout.on("data", collect);
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      rpc(child, 7, "tools/list");
      const reused = await readRpc(child, 7, 750);
      assert.match(JSON.stringify(reused.error ?? {}), /duplicate|reuse|already used/i);
      const boundedExit = await Promise.race([
        exited.then((code) => ({ exited: true, code })),
        new Promise<{ exited: false; code: null }>((resolve) =>
          setTimeout(() => resolve({ exited: false, code: null }), 1_500),
        ),
      ]);

      assert.equal(boundedExit.exited, true, "transport survived a delayed response for a completed ID");
      assert.deepEqual(readFileSync(callLog, "utf8").trim().split("\n"), ["7"]);
      assert.doesNotMatch(output, /pinchtab_snapshot|pinchtab_get_text/u);
    } finally {
      child.stdout.off("data", collect);
      child.kill("SIGKILL");
    }
  });

  test("a concurrent duplicate client ID is rejected without a second child request", async () => {
    const dir = await tempDir("openbot-pt-child-concurrent-id-");
    const bin = await writeDelayedConcurrentIdPinchTab(dir);
    const callLog = join(dir, "calls.log");
    const child = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        OPENBOT_ID_CALL_LOG: callLog,
        OPENBOT_PINCHTAB: bin,
        OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
        PINCHTAB_TOKEN: "t",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const messages: Array<{ id?: number; result?: unknown; error?: unknown }> = [];
    let buffer = "";
    const collect = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          messages.push(JSON.parse(line) as (typeof messages)[number]);
        } catch {
          /* wait for a complete frame */
        }
      }
    };
    try {
      rpc(child, 1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
      await readRpc(child, 1);
      child.stdout.on("data", collect);
      rpc(child, 7, "tools/list");
      rpc(child, 7, "tools/list");
      await waitUntil(() => messages.filter((message) => message.id === 7).length >= 2, 1_000);
      await new Promise((resolve) => setTimeout(resolve, 40));

      const replies = messages.filter((message) => message.id === 7);
      assert.equal(replies.length, 2, JSON.stringify(replies));
      assert.equal(replies.filter((message) => message.error !== undefined).length, 1, JSON.stringify(replies));
      assert.equal(replies.filter((message) => message.result !== undefined).length, 1, JSON.stringify(replies));
      assert.deepEqual(readFileSync(callLog, "utf8").trim().split("\n"), ["7"]);
    } finally {
      child.stdout.off("data", collect);
      child.kill("SIGTERM");
    }
  });

  test("a silent non-tool JSON-RPC request times out exactly once and resets the transport", async () => {
    const bin = await writeSilentListPinchTab(await tempDir("openbot-pt-child-silent-list-"));
    const child = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        OPENBOT_PINCHTAB: bin,
        OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "300",
        OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
        PINCHTAB_TOKEN: "t",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const messages: Array<{ id?: number; error?: unknown }> = [];
    let buffer = "";
    const collect = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          messages.push(JSON.parse(line) as (typeof messages)[number]);
        } catch {
          /* wait for a complete frame */
        }
      }
    };
    try {
      rpc(child, 1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
      await readRpc(child, 1);
      child.stdout.on("data", collect);
      rpc(child, 2, "tools/list");
      const failed = await readRpc(child, 2, 750);
      await new Promise((resolve) => setTimeout(resolve, 40));

      assert.match(JSON.stringify(failed.error ?? {}), /timed out|deadline/i);
      assert.equal(messages.filter((message) => message.id === 2).length, 1, JSON.stringify(messages));
    } finally {
      child.stdout.off("data", collect);
      child.kill("SIGTERM");
    }
  });

  test("child stdin failure rejects all pending IDs once and forces a bounded transport exit", async () => {
    const dir = await tempDir("openbot-pt-child-stdin-fail-");
    const bin = await writeClosedStdinPinchTab(dir);
    const pidFile = join(dir, "child.pid");
    const child = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        OPENBOT_PINCHTAB: bin,
        OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "5000",
        OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
        OPENBOT_STDIN_FAIL_PID_FILE: pidFile,
        PINCHTAB_TOKEN: "t",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const messages: Array<{ id?: number; error?: unknown }> = [];
    let buffer = "";
    const collect = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          messages.push(JSON.parse(line) as (typeof messages)[number]);
        } catch {
          /* wait for a complete frame */
        }
      }
    };
    try {
      rpc(child, 1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
      await readRpc(child, 1);
      await waitUntil(() => existsSync(pidFile), 500);
      await new Promise((resolve) => setTimeout(resolve, 60));
      child.stdout.on("data", collect);
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      rpc(child, 2, "tools/list");
      rpc(child, 3, "tools/list");
      await waitUntil(() => messages.filter((message) => message.id === 2 || message.id === 3).length >= 2, 750);
      const boundedExit = await Promise.race([
        exited.then((code) => ({ exited: true, code })),
        new Promise<{ exited: false; code: null }>((resolve) =>
          setTimeout(() => resolve({ exited: false, code: null }), 1_800),
        ),
      ]);

      assert.equal(boundedExit.exited, true, "wrapper stayed alive after child stdin failed");
      for (const id of [2, 3]) {
        const replies = messages.filter((message) => message.id === id);
        assert.equal(replies.length, 1, `request ${id} replies: ${JSON.stringify(replies)}`);
        assert.match(JSON.stringify(replies[0]?.error ?? {}), /stdin|closed|write|pipe|transport/i);
      }
    } finally {
      child.stdout.off("data", collect);
      child.kill("SIGKILL");
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (processAlive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  });

  test("client EOF lets a normal child exit gracefully", async () => {
    const bin = await writeFakePinchTab(await tempDir("openbot-pt-client-eof-graceful-"));
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
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      child.stdin.end();
      const boundedExit = await Promise.race([
        exited.then((code) => ({ exited: true, code })),
        new Promise<{ exited: false; code: null }>((resolve) =>
          setTimeout(() => resolve({ exited: false, code: null }), 750),
        ),
      ]);
      assert.deepEqual(boundedExit, { exited: true, code: 0 });
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("client EOF rejects pending IDs once and kills a child that ignores EOF and TERM", async () => {
    const dir = await tempDir("openbot-pt-client-eof-stubborn-");
    const bin = await writeIgnoreEofPinchTab(dir);
    const pidFile = join(dir, "child.pid");
    const child = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        OPENBOT_EOF_CHILD_PID_FILE: pidFile,
        OPENBOT_PINCHTAB: bin,
        OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "5000",
        OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
        PINCHTAB_TOKEN: "t",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const messages: Array<{ id?: number; error?: unknown }> = [];
    let buffer = "";
    const collect = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          messages.push(JSON.parse(line) as (typeof messages)[number]);
        } catch {
          /* wait for a complete frame */
        }
      }
    };
    try {
      rpc(child, 1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
      await readRpc(child, 1);
      await waitUntil(() => existsSync(pidFile), 500);
      child.stdout.on("data", collect);
      rpc(child, 2, "tools/list");
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      child.stdin.end();
      const boundedExit = await Promise.race([
        exited.then((code) => ({ exited: true, code })),
        new Promise<{ exited: false; code: null }>((resolve) =>
          setTimeout(() => resolve({ exited: false, code: null }), 1_800),
        ),
      ]);

      assert.equal(boundedExit.exited, true, "wrapper stayed alive after client EOF");
      await new Promise((resolve) => setTimeout(resolve, 40));
      const replies = messages.filter((message) => message.id === 2);
      assert.equal(replies.length, 1, JSON.stringify(messages));
      assert.match(JSON.stringify(replies[0]?.error ?? {}), /EOF|shutdown|transport|exit/i);
      assert.equal(processAlive(Number(readFileSync(pidFile, "utf8"))), false, "stubborn child survived EOF shutdown");
    } finally {
      child.stdout.off("data", collect);
      child.kill("SIGKILL");
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (processAlive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  });

  test("a hanging child times out once and cannot overlap the next queued tool", async () => {
    const dir = await tempDir("openbot-pt-child-hang-");
    const bin = await writeHangingPinchTab(dir);
    const log = join(dir, "calls.log");
    const child = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        OPENBOT_HANG_LOG: log,
        OPENBOT_PINCHTAB: bin,
        OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "300",
        OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
        PINCHTAB_TOKEN: "t",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const messages: Array<{ id?: number; result?: unknown; error?: unknown }> = [];
    let buffer = "";
    const collect = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          messages.push(JSON.parse(line) as (typeof messages)[number]);
        } catch {
          /* wait for a complete frame */
        }
      }
    };
    try {
      rpc(child, 1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
      await readRpc(child, 1);
      child.stdout.on("data", collect);
      rpc(child, 2, "tools/call", { name: "pinchtab_get_text", arguments: {} });
      rpc(child, 3, "tools/call", { name: "pinchtab_snapshot", arguments: {} });
      await waitUntil(() => messages.filter((message) => message.id === 2 || message.id === 3).length >= 2, 1_000);
      await waitUntil(() => existsSync(log) && readFileSync(log, "utf8").includes("late:2"), 1_000);
      await new Promise((resolve) => setTimeout(resolve, 40));

      const second = messages.filter((message) => message.id === 2);
      const third = messages.filter((message) => message.id === 3);
      assert.equal(second.length, 1, `request 2 responses: ${JSON.stringify(second)}`);
      assert.equal(third.length, 1, `request 3 responses: ${JSON.stringify(third)}`);
      assert.match(JSON.stringify(second[0]?.error ?? {}), /timed out|deadline/i);
      assert.ok(third[0]?.error, `queued request unexpectedly resolved: ${JSON.stringify(third[0])}`);
      assert.equal(second[0]?.result, undefined, "late result escaped after timeout");
      assert.equal(third[0]?.result, undefined, "queued tool overlapped the timed-out child operation");
      const calls = readFileSync(log, "utf8");
      assert.match(calls, /call:2/);
      assert.match(calls, /late:2/);
      assert.doesNotMatch(calls, /call:3/);
    } finally {
      child.stdout.off("data", collect);
      child.kill("SIGTERM");
    }
  });

  test("navigation completion and focus precede the next prepared tool call", async () => {
    const bin = await writeDelayedNavigationPinchTab(await tempDir("openbot-pt-order-"));
    let currentTab = "tab-old";
    const focuses: string[] = [];
    const stub = await new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.url === "/tabs") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ tabs: [{ id: currentTab, type: "page" }] }));
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tabId?: string };
          if (body.tabId) {
            currentTab = body.tabId;
            focuses.push(body.tabId);
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("ordering stub failed"));
          return;
        }
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise((done) => server.close(() => done())),
        });
      });
    });
    const child = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        OPENBOT_PINCHTAB: bin,
        OPENBOT_PINCHTAB_SERVER: stub.url,
        PINCHTAB_TOKEN: "t",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      rpc(child, 1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
      await readRpc(child, 1);
      const order = readRpcOrder(child, [2, 3]);
      rpc(child, 2, "tools/call", { name: "pinchtab_navigate", arguments: { url: "https://example.com" } });
      rpc(child, 3, "tools/call", { name: "pinchtab_click", arguments: { selector: "#next" } });

      assert.deepEqual(await order, [2, 3]);
      assert.deepEqual(focuses, ["tab-old", "tab-new", "tab-new"]);
    } finally {
      child.kill("SIGTERM");
      await stub.close();
    }
  });
});

describe("PinchTab display lifecycle", () => {
  test("display CLI keeps one durable PinchTab owner and stop removes it", async () => {
    const root = await tempDir("openbot-pt-supervisor-");
    const home = join(root, 'home-"quoted\\segment\nline');
    const profile = join(root, 'profile-"quoted\\segment\nline');
    const binDir = join(root, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const pinchtab = await writeSupervisedBridgeFixture(binDir);
    const setsid = await writeSetsidFixture(binDir);
    const curl = await writeCurlFixture(binDir);
    const port = await unusedLoopbackPort();
    const ownerPath = join(home, ".pinchtab-d1", "bridge-owner.json");
    const curlLog = join(root, "curl.log");
    const setsidLog = join(root, "setsid.log");
    const env = {
      ...process.env,
      CHROME_USER_DATA_DIR: profile,
      COOKIE_JAR: join(root, "cookies"),
      OPENBOT_CDP_PORT_BASE: String(port + 100),
      OPENBOT_CURL_LOG: curlLog,
      OPENBOT_PINCHTAB_BIN: pinchtab,
      OPENBOT_PINCHTAB_PORT_BASE: String(port - 1),
      OPENBOT_REAL_CURL: curl.real,
      OPENBOT_SCREEN_HOME: home,
      OPENBOT_SETSID_DELAY_SEC: "0.3",
      OPENBOT_SETSID_BIN: setsid,
      OPENBOT_SETSID_LOG: setsidLog,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      PINCHTAB_TOKEN: 'supervisor-"token\\literal',
      VNC_USER: process.env.USER ?? "openbot",
    };
    let owner: { supervisorPid?: number; childPid?: number } = {};
    let launchedSupervisors: number[] = [];
    try {
      const rogue = spawnSync("bash", [displaySh, "pinchtab-supervise", "1"], {
        encoding: "utf8",
        env,
        timeout: 750,
      });
      if (existsSync(ownerPath)) owner = JSON.parse(readFileSync(ownerPath, "utf8")) as typeof owner;
      assert.equal(rogue.status, 1, rogue.stdout + rogue.stderr);
      assert.match(rogue.stderr, /lifecycle lock|not authorized/i);
      assert.equal(existsSync(ownerPath), false, "direct supervisor invocation published an owner");

      const start = () =>
        new Promise<{ status: number | null; stderr: string }>((resolve) => {
          const child = spawn("bash", [displaySh, "pinchtab", "1"], {
            env,
            stdio: ["ignore", "ignore", "pipe"],
          });
          let stderr = "";
          child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
          child.on("close", (status) => resolve({ status, stderr }));
        });
      const starts = await Promise.all([start(), start(), start(), start()]);
      for (const result of starts) assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(ownerPath), true, `owner missing; stderr=${starts[0]?.stderr ?? ""}`);
      launchedSupervisors = [
        ...new Set(
          readFileSync(setsidLog, "utf8")
            .trim()
            .split("\n")
            .map(Number)
            .filter(Number.isInteger),
        ),
      ];
      assert.deepEqual(
        launchedSupervisors.filter((pid) => processAlive(pid)),
        [launchedSupervisors[0]],
        `duplicate supervisors launched: ${launchedSupervisors.join(", ")}`,
      );
      owner = JSON.parse(readFileSync(ownerPath, "utf8")) as typeof owner;
      assert.equal(owner.supervisorPid, launchedSupervisors[0]);
      const config = JSON.parse(
        readFileSync(join(home, ".pinchtab-d1", "config.json"), "utf8"),
      ) as {
        server: { token: string; stateDir: string };
        profiles: { baseDir: string; defaultProfile: string };
      };
      assert.equal(config.server.token, env.PINCHTAB_TOKEN);
      assert.equal(config.server.stateDir, join(home, ".pinchtab-d1"));
      assert.equal(config.profiles.baseDir, dirname(profile));
      assert.equal(config.profiles.defaultProfile, 'profile-"quoted\\segment\nline');
      const bridgeCalls = readFileSync(curlLog, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.includes("Authorization: Bearer"));
      for (const endpoint of ["/health", "/ensure-browser"]) {
        const call = bridgeCalls.find((line) => line.includes(endpoint));
        assert.ok(call, `missing curl call for ${endpoint}`);
        assert.match(call, /<--connect-timeout>/, `${endpoint} has no connect deadline`);
        assert.match(call, /<--max-time>/, `${endpoint} has no total deadline`);
      }
      assert.equal(processAlive(owner.supervisorPid), true);
      assert.equal(processAlive(owner.childPid), true);

      const second = spawnSync("bash", [displaySh, "pinchtab", "1"], {
        encoding: "utf8",
        env,
        timeout: 10_000,
      });
      assert.equal(second.status, 0, second.stderr);
      const sameOwner = JSON.parse(readFileSync(ownerPath, "utf8")) as typeof owner;
      assert.deepEqual(sameOwner, owner);

      process.kill(sameOwner.supervisorPid as number, "SIGKILL");
      await waitUntil(() => !processAlive(sameOwner.supervisorPid), 4_000);
      assert.equal(processAlive(sameOwner.childPid), true, "fixture must leave a stale bridge child");
      const restarted = spawnSync("bash", [displaySh, "pinchtab", "1"], {
        encoding: "utf8",
        env,
        timeout: 15_000,
      });
      assert.equal(restarted.status, 0, restarted.stderr);
      owner = JSON.parse(readFileSync(ownerPath, "utf8")) as typeof owner;
      assert.notEqual(owner.supervisorPid, sameOwner.supervisorPid);
      assert.notEqual(owner.childPid, sameOwner.childPid);
      assert.equal(processAlive(sameOwner.childPid), false, "stale bridge child survived restart");

      const stopped = spawnSync("bash", [displaySh, "stop", "1"], {
        encoding: "utf8",
        env,
        timeout: 10_000,
      });
      assert.equal(stopped.status, 0, stopped.stderr);
      await waitUntil(() => !processAlive(owner.supervisorPid) && !processAlive(owner.childPid), 4_000);
      assert.equal(existsSync(ownerPath), false);
    } finally {
      for (const pid of launchedSupervisors) {
        if (processAlive(pid)) process.kill(pid, "SIGTERM");
      }
      if (processAlive(owner.supervisorPid)) process.kill(owner.supervisorPid as number, "SIGKILL");
      if (processAlive(owner.childPid)) process.kill(owner.childPid as number, "SIGKILL");
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("display readiness retries transient ensure failure within one shrinking startup deadline", async () => {
    const root = await tempDir("openbot-pt-transient-ensure-");
    const home = join(root, "home");
    const binDir = join(root, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const pinchtab = await writeTransientEnsureBridgeFixture(binDir);
    const setsid = await writeSetsidFixture(binDir);
    const curl = await writeCurlFixture(binDir);
    const port = await unusedLoopbackPort();
    const ownerPath = join(home, ".pinchtab-d1", "bridge-owner.json");
    const curlLog = join(root, "curl.log");
    const ensureCalls = join(root, "ensure-calls.log");
    const env = {
      ...process.env,
      CHROME_USER_DATA_DIR: join(root, "profile"),
      COOKIE_JAR: join(root, "cookies"),
      OPENBOT_CDP_PORT_BASE: String(port + 100),
      OPENBOT_CURL_LOG: curlLog,
      OPENBOT_ENSURE_CALLS_FILE: ensureCalls,
      OPENBOT_PINCHTAB_BIN: pinchtab,
      OPENBOT_PINCHTAB_PORT_BASE: String(port - 1),
      OPENBOT_PINCHTAB_REQUEST_TIMEOUT_SEC: "5",
      OPENBOT_PINCHTAB_START_TIMEOUT_SEC: "4",
      OPENBOT_REAL_CURL: curl.real,
      OPENBOT_SCREEN_HOME: home,
      OPENBOT_SETSID_BIN: setsid,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      PINCHTAB_TOKEN: "transient-ensure-token",
      VNC_USER: process.env.USER ?? "openbot",
    };
    let owner: { supervisorPid?: number; childPid?: number } = {};
    const started = Date.now();
    try {
      const result = spawnSync("bash", [displaySh, "pinchtab", "1"], {
        encoding: "utf8",
        env,
        timeout: 10_000,
      });
      if (existsSync(ownerPath)) owner = JSON.parse(readFileSync(ownerPath, "utf8")) as typeof owner;
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(Date.now() - started < 5_000, `startup deadline overran: ${Date.now() - started}ms`);
      assert.deepEqual(readFileSync(ensureCalls, "utf8").trim().split("\n"), ["1", "2"]);
      const attempts = readFileSync(curlLog, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.includes("/ensure-browser"));
      assert.equal(attempts.length, 2, attempts.join("\n"));
      const budgets = attempts.map((line) => Number(/<--max-time><([^>]+)>/.exec(line)?.[1]));
      assert.equal(budgets.every((value) => Number.isFinite(value) && value > 0 && value <= 4), true, attempts.join("\n"));
      assert.ok((budgets[1] ?? 5) < (budgets[0] ?? 0), `ensure budgets did not shrink: ${budgets.join(",")}`);

      const stopped = spawnSync("bash", [displaySh, "stop", "1"], {
        encoding: "utf8",
        env,
        timeout: 10_000,
      });
      assert.equal(stopped.status, 0, stopped.stderr);
    } finally {
      if (processAlive(owner.supervisorPid)) process.kill(owner.supervisorPid as number, "SIGKILL");
      if (processAlive(owner.childPid)) process.kill(owner.childPid as number, "SIGKILL");
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("display CLI rejects a healthy foreign owner on the configured port", async () => {
    const root = await tempDir("openbot-pt-port-conflict-");
    const home = join(root, "home");
    const binDir = join(root, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const pinchtab = await writeSupervisedBridgeFixture(binDir);
    const setsid = await writeSetsidFixture(binDir);
    const foreign = await new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: req.url === "/ensure-browser" ? "browser_ready" : "ok" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("foreign port fixture failed"));
          return;
        }
        resolve({
          port: address.port,
          close: () => new Promise((done) => server.close(() => done())),
        });
      });
    });
    const ownerPath = join(home, ".pinchtab-d1", "bridge-owner.json");
    const env = {
      ...process.env,
      CHROME_USER_DATA_DIR: join(root, "profile"),
      COOKIE_JAR: join(root, "cookies"),
      OPENBOT_CDP_PORT_BASE: String(foreign.port + 100),
      OPENBOT_PINCHTAB_BIN: pinchtab,
      OPENBOT_PINCHTAB_PORT_BASE: String(foreign.port - 1),
      OPENBOT_SCREEN_HOME: home,
      OPENBOT_SETSID_BIN: setsid,
      PINCHTAB_TOKEN: "foreign-token",
      VNC_USER: process.env.USER ?? "openbot",
    };
    let owner: { supervisorPid?: number; childPid?: number } = {};
    try {
      const result = spawnSync("bash", [displaySh, "pinchtab", "1"], {
        encoding: "utf8",
        env,
        timeout: 10_000,
      });
      if (existsSync(ownerPath)) {
        owner = JSON.parse(readFileSync(ownerPath, "utf8")) as typeof owner;
      }
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /port.*(?:conflict|in use)|already owned/i);
      assert.equal(existsSync(ownerPath), false);
    } finally {
      if (processAlive(owner.supervisorPid)) process.kill(owner.supervisorPid as number, "SIGKILL");
      if (processAlive(owner.childPid)) process.kill(owner.childPid as number, "SIGKILL");
      await foreign.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("display stop reports an unowned occupied port after attempting all cleanup", async () => {
    const root = await tempDir("openbot-pt-stop-unowned-");
    const home = join(root, "home");
    const jar = join(root, "cookies");
    const binDir = join(root, "bin");
    const cleanupLog = join(root, "cleanup.log");
    mkdirSync(binDir, { recursive: true });
    const foreign = await new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "foreign" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("unowned stop fixture failed"));
          return;
        }
        resolve({
          port: address.port,
          close: () => new Promise((done) => server.close(() => done())),
        });
      });
    });
    let display = 0;
    let xLock = "";
    for (const candidate of [8, 7, 6, 5, 4, 3, 2]) {
      const candidateLock = `/tmp/.X${candidate}-lock`;
      const candidateSocket = `/tmp/.X11-unix/X${candidate}`;
      if (existsSync(candidateLock) || existsSync(candidateSocket)) continue;
      try {
        writeFileSync(candidateLock, "999999\n", { flag: "wx" });
        display = candidate;
        xLock = candidateLock;
        break;
      } catch {
        continue;
      }
    }
    assert.notEqual(display, 0, "no unused test display id was available");
    const profile = join(home, `.config`, `google-chrome-d${display}`, "Default", "Network");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "Cookies"), "cleanup-cookie");
    writeFileSync(
      join(binDir, "pkill"),
      '#!/bin/sh\nprintf "chrome:%s\\n" "$*" >> "$OPENBOT_CLEANUP_LOG"\nexit 1\n',
      { mode: 0o755 },
    );
    writeFileSync(join(binDir, "pgrep"), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(
      join(binDir, "su"),
      '#!/bin/sh\nprintf "vnc:%s\\n" "$*" >> "$OPENBOT_CLEANUP_LOG"\nexit 0\n',
      { mode: 0o755 },
    );
    try {
      const result = spawnSync("bash", [displaySh, "stop", String(display)], {
        encoding: "utf8",
        env: {
          ...process.env,
          COOKIE_JAR: jar,
          OPENBOT_CLEANUP_LOG: cleanupLog,
          OPENBOT_PINCHTAB_PORT_BASE: String(foreign.port - display),
          OPENBOT_SCREEN_HOME: home,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          VNC_USER: process.env.USER ?? "openbot",
        },
        timeout: 10_000,
      });

      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /port.*occupied|unowned|foreign|refusing to kill/i);
      assert.equal(readFileSync(join(jar, "Network", "Cookies"), "utf8"), "cleanup-cookie");
      assert.match(readFileSync(cleanupLog, "utf8"), /chrome:/u);
      assert.match(readFileSync(cleanupLog, "utf8"), /vnc:/u);
      assert.equal(existsSync(xLock), false, "X lock cleanup was skipped");
      const stillLive = await fetch(`http://127.0.0.1:${foreign.port}/health`);
      assert.equal(stillLive.status, 200, "stop killed the unowned process");
    } finally {
      rmSync(xLock, { force: true });
      await foreign.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("display CLI reports every bridge startup deadline when health never succeeds", async () => {
    const root = await tempDir("openbot-pt-health-deadline-");
    const home = join(root, "home");
    const binDir = join(root, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const pinchtab = await writeSupervisedBridgeFixture(binDir);
    const setsid = await writeSetsidFixture(binDir);
    const curl = await writeCurlFixture(binDir);
    const port = await unusedLoopbackPort();
    const ownerPath = join(home, ".pinchtab-d1", "bridge-owner.json");
    const env = {
      ...process.env,
      CHROME_USER_DATA_DIR: join(root, "profile"),
      COOKIE_JAR: join(root, "cookies"),
      OPENBOT_CDP_PORT_BASE: String(port + 100),
      OPENBOT_CURL_FAIL: "1",
      OPENBOT_CURL_LOG: join(root, "curl.log"),
      OPENBOT_PINCHTAB_BIN: pinchtab,
      OPENBOT_PINCHTAB_BODY_TIMEOUT_SEC: "2",
      OPENBOT_PINCHTAB_CONNECT_TIMEOUT_SEC: "1",
      OPENBOT_PINCHTAB_PORT_BASE: String(port - 1),
      OPENBOT_PINCHTAB_REQUEST_TIMEOUT_SEC: "3",
      OPENBOT_PINCHTAB_START_TIMEOUT_SEC: "1",
      OPENBOT_REAL_CURL: curl.real,
      OPENBOT_SCREEN_HOME: home,
      OPENBOT_SETSID_BIN: setsid,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      PINCHTAB_TOKEN: "deadline-token",
      VNC_USER: process.env.USER ?? "openbot",
    };
    let owner: { supervisorPid?: number; childPid?: number } = {};
    try {
      const result = spawnSync("bash", [displaySh, "pinchtab", "1"], {
        encoding: "utf8",
        env,
        timeout: 10_000,
      });
      if (existsSync(ownerPath)) owner = JSON.parse(readFileSync(ownerPath, "utf8")) as typeof owner;
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(
        result.stderr,
        /startup=1s.*connect=1s.*header\/total=3s.*body-inactivity=2s/u,
      );
    } finally {
      if (processAlive(owner.supervisorPid)) process.kill(owner.supervisorPid as number, "SIGKILL");
      if (processAlive(owner.childPid)) process.kill(owner.childPid as number, "SIGKILL");
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("display CLI removes a stale X lock before starting the display", async () => {
    const root = await tempDir("openbot-stale-x-lock-");
    const home = join(root, "home");
    const binDir = join(root, "bin");
    const marker = join(root, "su-called");
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const fakeCp = join(binDir, "cp");
    const fakeSu = join(binDir, "su");
    writeFileSync(
      fakeCp,
      '#!/bin/bash\nfor arg in "$@"; do dest="$arg"; done\nif [ -d "$dest" ]; then dest="$dest/fixture"; fi\nmkdir -p "$(dirname "$dest")"\n: > "$dest"\n',
      { mode: 0o755 },
    );
    writeFileSync(fakeSu, '#!/bin/sh\nprintf "%s\\n" "$*" > "$OPENBOT_SU_MARKER"\n', { mode: 0o755 });

    let display = 0;
    let lock = "";
    for (const candidate of [8, 7, 6, 5, 4, 3, 2]) {
      const candidateLock = `/tmp/.X${candidate}-lock`;
      const candidateSocket = `/tmp/.X11-unix/X${candidate}`;
      if (existsSync(candidateLock) || existsSync(candidateSocket)) continue;
      try {
        writeFileSync(candidateLock, "999999\n", { flag: "wx" });
        display = candidate;
        lock = candidateLock;
        break;
      } catch {
        continue;
      }
    }
    assert.notEqual(display, 0, "no unused test display id was available");
    try {
      const result = spawnSync("bash", [displaySh, "start", String(display)], {
        encoding: "utf8",
        env: {
          ...process.env,
          COOKIE_JAR: join(root, "cookies"),
          OPENBOT_SCREEN_HOME: home,
          OPENBOT_SU_MARKER: marker,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          VNC_USER: process.env.USER ?? "openbot",
        },
        timeout: 10_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(marker), true, `stale lock returned early: ${result.stdout}${result.stderr}`);
      assert.equal(existsSync(lock), false);
    } finally {
      rmSync(lock, { force: true });
      rmSync(root, { force: true, recursive: true });
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

  test("PinchTab bridge launches headed Chrome and does not CDP-attach", () => {
    const body = readFileSync(displaySh, "utf8");
    assert.doesNotMatch(body, /--cdp-attach/);
    assert.doesNotMatch(body, /extraFlags/);
    assert.doesNotMatch(body, /window-size/);
    assert.match(body, /captureAllowActivation\s*:\s*true/);
    assert.match(body, /remoteDebuggingPort/);
    assert.match(body, /ensure-browser/);
    const start = readFileSync(xstartup, "utf8");
    assert.doesNotMatch(start, /--load-extension/);
    assert.doesNotMatch(start, /chrome:\/\/new-tab-page/);
    assert.match(start, /openbot-display pinchtab/);
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

  test("waitForPinchTabBridge POSTs /ensure-browser after health", async () => {
    const seen: string[] = [];
    const stub = await new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        seen.push(`${req.method} ${req.url}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(req.url === "/ensure-browser" ? JSON.stringify({ status: "browser_ready" }) : JSON.stringify({ status: "ok" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("ensure stub failed"));
          return;
        }
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise((done) => server.close(() => done())),
        });
      });
    });
    try {
      assert.equal(await waitForPinchTabBridge(stub.url, "tok", 2000), true);
      assert.equal(seen[0], "GET /health");
      assert.equal(seen.includes("POST /ensure-browser"), true);
    } finally {
      await stub.close();
    }
  });

  test("bridge readiness rejects a failed ensure-browser bootstrap", async () => {
    const seen: string[] = [];
    const stub = await new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        seen.push(`${req.method} ${req.url}`);
        if (req.url === "/ensure-browser") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "browser bootstrap failed" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("failed-bootstrap stub failed"));
          return;
        }
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise((done) => server.close(() => done())),
        });
      });
    });
    try {
      assert.equal(await waitForPinchTabBridge(stub.url, "tok", 100), false);
      assert.equal(seen.includes("POST /ensure-browser"), true);
    } finally {
      await stub.close();
    }
  });

  test("bridge readiness retries a transient ensure-browser failure within one deadline", async () => {
    let ensureCalls = 0;
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.url === "/ensure-browser") {
        ensureCalls += 1;
        res.writeHead(ensureCalls === 1 ? 503 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: ensureCalls === 1 ? "starting" : "browser_ready" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("transient-bootstrap fixture failed to bind");
    const started = Date.now();
    try {
      assert.equal(
        await waitForPinchTabBridge(`http://127.0.0.1:${address.port}`, "token", 1200),
        true,
      );
      assert.equal(ensureCalls, 2);
      assert.ok(Date.now() - started < 1200, `bridge deadline overran: ${Date.now() - started}ms`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a successful tabs fallback cannot mask a failed health endpoint", async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(req.url === "/health" ? 500 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/tabs" ? { tabs: [] } : { ok: req.url !== "/health" }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed-health fixture failed to bind");
    try {
      assert.equal(
        await waitForPinchTabBridge(`http://127.0.0.1:${address.port}`, "token", 120),
        false,
      );
      assert.equal(seen.some((request) => request.endsWith("/health")), true);
      assert.equal(seen.some((request) => request.endsWith("/ensure-browser")), false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("ensure-browser waits for the response body to finish", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"status":');
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("body-timeout fixture failed to bind");
    try {
      assert.equal(
        await ensurePinchTabBrowser(`http://127.0.0.1:${address.port}`, "token", 120),
        false,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("ensure-browser may use its supplied header budget beyond the health probe interval", async () => {
    const server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "browser_ready" }));
      }, 900);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("slow-bootstrap fixture failed to bind");
    try {
      assert.equal(
        await ensurePinchTabBrowser(`http://127.0.0.1:${address.port}`, "token", 2000),
        true,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("bridge wait respects one overall deadline while headers stall", async () => {
    const server = http.createServer(() => {
      // Accept the connection but deliberately never send response headers.
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("header-timeout fixture failed to bind");
    const started = Date.now();
    try {
      assert.equal(
        await waitForPinchTabBridge(`http://127.0.0.1:${address.port}`, "token", 120),
        false,
      );
      assert.ok(Date.now() - started < 600, `bridge deadline overran: ${Date.now() - started}ms`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("HTTPS bridge probes fail closed instead of rejecting for the protocol", async () => {
    const port = await unusedLoopbackPort();
    assert.equal(await pinchTabHealthy(`https://127.0.0.1:${port}`, "token", 50), false);
  });

  test("prepareBrowseCall focuses the tab before returning args", async () => {
    const order: string[] = [];
    const stub = await new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        order.push(`${req.method} ${req.url}`);
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          if ((req.url ?? "").startsWith("/tabs")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ tabs: [{ id: "tab-live", type: "page", url: "https://example.com" }] }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("prepare stub failed"));
          return;
        }
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise((done) => server.close(() => done())),
        });
      });
    });
    try {
      const args = await prepareBrowseCall("pinchtab_click", {}, stub.url, "tok");
      assert.equal(args.tabId, "tab-live");
      assert.deepEqual(order[0], "GET /tabs");
      assert.deepEqual(order[1], "POST /tab");
    } finally {
      await stub.close();
    }
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

  test("focusPinchTab rejects a non-success HTTP status", async () => {
    const stub = await new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        req.resume();
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "focus unavailable" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("failed-focus stub failed"));
          return;
        }
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise((done) => server.close(() => done())),
        });
      });
    });
    try {
      await assert.rejects(focusPinchTab(stub.url, "tok", "tab-1"), /503|focus/u);
    } finally {
      await stub.close();
    }
  });

  test("focusPinchTab cancels the unused response body", async () => {
    let bodyClosed = false;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"focused":true');
      res.once("close", () => (bodyClosed = true));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("focus-body fixture failed to bind");
    try {
      await focusPinchTab(`http://127.0.0.1:${address.port}`, "tok", "tab-1");
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(bodyClosed, true, "focus response body kept its connection open");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
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

  test("binary resolution uses the environment supplied to the MCP server", async () => {
    const homeDir = await tempDir("openbot-pt-server-env-home-");
    const binDir = await tempDir("openbot-pt-server-env-bin-");
    const suppliedBin = await writeFakePinchTab(binDir);
    const health = await startHealth("server-env-token");
    const previous = process.env.OPENBOT_PINCHTAB;
    process.env.OPENBOT_PINCHTAB = join(tmpdir(), "poisoned-process-pinchtab");
    try {
      const computer = new MemoryComputerRuntime({
        pinchTabUpstreams: [health.url],
        pinchTabToken: "server-env-token",
      });
      await computer.allocate("ada");
      const servers = await pinchTabMcpServers(computer, "ada", {
        HOME: homeDir,
        PATH: binDir,
        OPENBOT_PINCHTAB: suppliedBin,
        OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "4321",
      });

      assert.equal(servers.length, 1);
      assert.equal(servers[0]?.args.includes(suppliedBin), true);
      assert.equal(
        servers[0]?.env.some((row) => row.name === "OPENBOT_PINCHTAB" && row.value === suppliedBin),
        true,
      );
      assert.equal(
        servers[0]?.env.some(
          (row) => row.name === "OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS" && row.value === "4321",
        ),
        true,
      );
    } finally {
      if (previous === undefined) delete process.env.OPENBOT_PINCHTAB;
      else process.env.OPENBOT_PINCHTAB = previous;
      await health.close();
    }
  });
});
