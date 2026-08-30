import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import type { AcpHandlers } from "../src/acp.ts";
import { BotStore, type AcpSession } from "../src/bots.ts";
import {
  assertPrivateDirectoryTarget,
  DockerComputerRuntime,
  MemoryComputerRuntime,
  NoopComputerRuntime,
} from "../src/computer.ts";
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
  resolvePinchTabBin,
  stripPinchTabFromPath,
  waitForPinchTabBridge,
} from "../src/pinchtab.ts";
import {
  focusPinchTab,
  prepareBrowseCall,
  runPinchTabAllowlistProxy,
  shouldBringTabFront,
  tabIdFromToolResult,
} from "../src/pinchtab-mcp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const displaySh = join(here, "../../screen/display.sh");
const entrypointSh = join(here, "../../screen/entrypoint.sh");
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

async function writeCleanExitOnListPinchTab(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "clean-exit-on-list" } } }) + "\\n");
    return;
  }
  if (msg.method === "tools/list") process.exit(0);
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

async function writeDirectionCollisionPinchTab(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
const log = process.env.OPENBOT_DIRECTION_LOG;
let pending;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "direction-collision" } } }) + "\\n");
    return;
  }
  if (msg.method === "tools/call") {
    if (msg.id >= 3) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "transport-still-usable" }] } }) + "\\n");
      return;
    }
    pending = msg;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, method: "pinchtab/ping", params: { challenge: "same-id" } }) + "\\n");
    return;
  }
  if (pending && msg.id === pending.id && msg.result?.pong === true) {
    if (log) fs.appendFileSync(log, "client-response\\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: pending.id, result: { content: [{ type: "text", text: "actual-tool-response" }] } }) + "\\n");
  }
});
`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

async function writeMalformedLspPinchTab(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "tools/list") process.stdout.write("X-OpenBot: missing-length\\r\\n\\r\\n{}");
});
`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

async function writePrimitiveOutputPinchTab(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "primitive-output" } } }) + "\\n");
    return;
  }
  if (msg.method === "tools/list") process.stdout.write("null\\n");
});
`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

async function writeSilentServerRequestPinchTab(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
const requestLog = ${JSON.stringify(join(dir, "requests.log"))};
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  fs.appendFileSync(requestLog, "received:" + String(msg.method) + "\\n");
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "silent-server-request" } } }) + "\\n");
    return;
  }
  if (msg.method === "tools/call" || msg.method === "notifications/initialized") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 91, method: "sampling/createMessage", params: { messages: [] } }) + "\\n");
    fs.appendFileSync(requestLog, "emitted:sampling/createMessage\\n");
  }
});
`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

async function writeRequestLoggingPinchTab(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
const log = process.env.OPENBOT_REQUEST_LOG;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (log) fs.appendFileSync(log, String(msg.method) + "\\n");
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
let pendingCalls = 0;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "closed-stdin" } } }) + "\\n");
    return;
  }
  pendingCalls += 1;
  if (pendingCalls !== 2) return;
  rl.close();
  try { fs.closeSync(0); } catch {}
  if (process.env.OPENBOT_STDIN_CLOSED_FILE) fs.writeFileSync(process.env.OPENBOT_STDIN_CLOSED_FILE, "closed");
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

async function writeStubbornOutputPinchTab(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
if (process.env.OPENBOT_OUTPUT_CHILD_PID_FILE) fs.writeFileSync(process.env.OPENBOT_OUTPUT_CHILD_PID_FILE, String(process.pid));
process.on("SIGTERM", () => {
  if (process.env.OPENBOT_OUTPUT_EXIT_ON_TERM === "1") process.exit(0);
});
setInterval(() => {}, 1000);
const rl = readline.createInterface({ input: process.stdin });
const batched = [];
let mixedTool;
let mixedList;
const response = (msg, padding) => JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "pinchtab_navigate" }], ...(padding ? { padding } : {}) } }) + "\\n";
const emitMixed = () => {
  if (!mixedTool || !mixedList) return;
  process.stdout.write(response(mixedTool) + response(mixedList, "x".repeat(1536)));
  mixedTool = undefined;
  mixedList = undefined;
};
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "stubborn-output" } } }) + "\\n");
    return;
  }
  if (msg.method === "tools/call" && process.env.OPENBOT_OUTPUT_MIXED === "1") {
    if (process.env.OPENBOT_OUTPUT_CHILD_CALL_LOG) fs.appendFileSync(process.env.OPENBOT_OUTPUT_CHILD_CALL_LOG, String(msg.id) + "\\n");
    mixedTool = msg;
    emitMixed();
    return;
  }
  if (msg.method === "tools/list") {
    if (process.env.OPENBOT_OUTPUT_CHILD_CALL_LOG) fs.appendFileSync(process.env.OPENBOT_OUTPUT_CHILD_CALL_LOG, String(msg.id) + "\\n");
    if (process.env.OPENBOT_OUTPUT_CHILD_REQUEST_EXIT_BATCH === "1") {
      process.stdout.write(
        response(msg, "x".repeat(1536)) + JSON.stringify({ jsonrpc: "2.0", id: 91, method: "sampling/createMessage", params: {} }) + "\\n",
        () => process.exit(0),
      );
      return;
    }
    if (process.env.OPENBOT_OUTPUT_EXIT_BATCH === "1") {
      batched.push(msg);
      if (batched.length === 2) {
        process.stdout.write(
          response(batched[1], "x".repeat(1536)) + response(batched[0]),
          () => process.exit(0),
        );
      }
      return;
    }
    if (process.env.OPENBOT_OUTPUT_OVERFLOW === "1") {
      batched.push(msg);
      if (batched.length === 18) {
        process.stdout.write(
          batched.map((item, index) => response(item, index === 0 ? "x".repeat(1536) : undefined)).join(""),
        );
      }
      return;
    }
    if (process.env.OPENBOT_OUTPUT_MIXED === "1") {
      if (msg.id > 2) {
        process.stdout.write(response(msg));
      } else {
        mixedList = msg;
        emitMixed();
      }
      return;
    }
    if (process.env.OPENBOT_OUTPUT_BATCH === "1") {
      batched.push(msg);
      if (batched.length === 2) {
        process.stdout.write(response(batched[0], "x".repeat(1536)) + response(batched[1]));
      } else if (batched.length > 2) {
        process.stdout.write(response(msg));
      }
      return;
    }
    setTimeout(() => {
      const padding = process.env.OPENBOT_OUTPUT_LARGE === "1" ? "x".repeat(512 * 1024) : undefined;
      process.stdout.write(response(msg, padding));
    }, 50);
  }
});
`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

async function writeBackpressuredInputPinchTab(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
if (process.env.OPENBOT_INPUT_CHILD_PID_FILE) fs.writeFileSync(process.env.OPENBOT_INPUT_CHILD_PID_FILE, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
process.stdin.pause();
const delay = Number(process.env.OPENBOT_INPUT_DRAIN_DELAY_MS);
if (Number.isFinite(delay) && delay >= 0) {
  setTimeout(() => {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (process.env.OPENBOT_INPUT_CHILD_CALL_LOG) fs.appendFileSync(process.env.OPENBOT_INPUT_CHILD_CALL_LOG, String(msg.id) + "\\n");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { accepted: true } }) + "\\n");
    });
    process.stdin.resume();
  }, delay);
}
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

async function writeDelayedToolQueuePinchTab(dir: string): Promise<string> {
  const file = join(dir, "pinchtab");
  const body = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
const log = process.env.OPENBOT_TOOL_QUEUE_LOG;
const rl = readline.createInterface({ input: process.stdin });
const reply = (msg, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    reply(msg, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "delayed-tool-queue" } });
    return;
  }
  if (msg.method !== "tools/call") return;
  if (log) fs.appendFileSync(log, String(msg.id) + "\\n");
  setTimeout(() => reply(msg, { content: [{ type: "text", text: "completed:" + msg.id }] }), 350);
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
import fs from "node:fs";
import http from "node:http";
if (process.env.OPENBOT_BRIDGE_PID_LOG) fs.writeFileSync(process.env.OPENBOT_BRIDGE_PID_LOG, String(process.pid));
const index = process.argv.indexOf("--port");
const port = Number(process.argv[index + 1]);
const server = http.createServer((req, res) => {
  const authorized = req.headers.authorization === "Bearer " + (process.env.PINCHTAB_TOKEN ?? "");
  if (process.env.OPENBOT_AUTH_RESULT_FILE) {
    const endpoint = req.url === "/health" ? "health" : req.url === "/ensure-browser" ? "ensure-browser" : "other";
    fs.appendFileSync(process.env.OPENBOT_AUTH_RESULT_FILE, endpoint + ":" + (authorized ? "ok" : "bad") + "\\n");
  }
  if (!authorized) {
    res.writeHead(401);
    res.end();
    return;
  }
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
  const python = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
  assert.ok(python, "python3 is required for the process-group lifecycle fixture");
  await writeFile(
    file,
    `#!${python}
import os
import sys
import time

os.setsid()
log = os.environ.get("OPENBOT_SETSID_LOG")
if log:
    with open(log, "a", encoding="utf-8") as handle:
        handle.write(f"{os.getpid()}\\n")
if os.environ.get("OPENBOT_SETSID_ORPHAN_CHILD") == "1":
    time.sleep(0.25)
    child = os.fork()
    if child == 0:
        child_log = os.environ.get("OPENBOT_SETSID_DESCENDANT_LOG")
        if child_log:
            with open(child_log, "w", encoding="utf-8") as handle:
                handle.write(str(os.getpid()))
        time.sleep(10)
        os._exit(0)
    os._exit(0)
delay = os.environ.get("OPENBOT_SETSID_DELAY_SEC")
if delay:
    time.sleep(float(delay))
os.execvp(sys.argv[1], sys.argv[1:])
`,
    { encoding: "utf8", mode: 0o755 },
  );
  chmodSync(file, 0o755);
  return file;
}

async function writeOwnerStallingJqFixture(dir: string): Promise<string> {
  const real = spawnSync("sh", ["-c", "command -v jq"], { encoding: "utf8" }).stdout.trim();
  assert.ok(real, "jq is required for the owner publication fixture");
  const file = join(dir, "jq");
  const body = `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "supervisorPid" ]; then
    sleep "\${OPENBOT_OWNER_STALL_SEC:-10}"
    break
  fi
done
exec ${JSON.stringify(real)} "$@"
`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

async function writeCurlFixture(dir: string): Promise<{ file: string; real: string }> {
  const real = spawnSync("sh", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim();
  assert.ok(real, "curl is required for the display lifecycle fixture");
  const file = join(dir, "curl");
  const body = `#!/bin/sh
endpoint=""
for arg in "$@"; do
  case "$arg" in
    */health) endpoint="health" ;;
    */ensure-browser) endpoint="ensure-browser" ;;
  esac
done
if [ -n "\${OPENBOT_CURL_HOLD_DIR:-}" ] && [ -n "$endpoint" ]; then
  mkdir -p "$OPENBOT_CURL_HOLD_DIR"
  printf '%s\\n' "$$" > "$OPENBOT_CURL_HOLD_DIR/$endpoint.pid"
  while [ ! -e "$OPENBOT_CURL_HOLD_DIR/$endpoint.release" ]; do sleep 0.02; done
fi
{
  for arg in "$@"; do
    case "$arg" in
      Authorization:*|@*/authorization.header) printf '<authorization>' ;;
      *) printf '<%s>' "$arg" ;;
    esac
  done
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

async function writeBlockingCpFixture(dir: string): Promise<{ file: string; real: string }> {
  const real = spawnSync("which", ["cp"], { encoding: "utf8" }).stdout.trim();
  assert.ok(real, "cp is required for the cookie synchronization fixture");
  const file = join(dir, "cp");
  const body = `#!/bin/bash
src="\${1:-}"
if [ -n "\${OPENBOT_CP_HOLD_MATCH:-}" ] \
  && [[ "$src" == *"$OPENBOT_CP_HOLD_MATCH"* ]] \
  && [ ! -e "$OPENBOT_CP_RELEASE_FILE" ]; then
  : > "$OPENBOT_CP_HELD_FILE"
  while [ ! -e "$OPENBOT_CP_RELEASE_FILE" ]; do sleep 0.02; done
fi
exec "$OPENBOT_REAL_CP" "$@"
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

function processStartId(pid: number): string {
  const statPath = `/proc/${pid}/stat`;
  if (existsSync(statPath)) {
    const stat = readFileSync(statPath, "utf8");
    const fieldsAfterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
    return fieldsAfterCommand[19] ?? "";
  }
  return spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" })
    .stdout.replace(/^[\t ]*/u, "")
    .replace(/\r?\n$/u, "");
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function currentCookieSnapshot(jar: string): string {
  const target = readlinkSync(join(jar, "current"));
  return resolve(jar, target);
}

function cookieManifest(snapshot: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(join(snapshot, "manifest"), "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function privateTreeSnapshot(root: string): unknown[] {
  const entries: unknown[] = [];
  const visit = (relativePath: string) => {
    const absolutePath = relativePath ? join(root, relativePath) : root;
    const state = lstatSync(absolutePath, { bigint: true });
    const kind = state.isDirectory() ? "directory" : state.isSymbolicLink() ? "symlink" : "file";
    entries.push({
      path: relativePath || ".",
      kind,
      mode: Number(state.mode & 0o7777n),
      uid: state.uid.toString(),
      gid: state.gid.toString(),
      size: state.size.toString(),
      mtimeNs: state.mtimeNs.toString(),
      target: kind === "symlink" ? readlinkSync(absolutePath) : undefined,
      bytes: kind === "file" ? readFileSync(absolutePath).toString("base64") : undefined,
    });
    if (kind === "directory") {
      for (const name of readdirSync(absolutePath).sort()) {
        visit(relativePath ? join(relativePath, name) : name);
      }
    }
  };
  visit("");
  return entries;
}

function committedCookieStoreSnapshot(root: string): unknown[] {
  const entries = structuredClone(privateTreeSnapshot(root)) as Array<Record<string, unknown>>;
  if (entries[0]?.path === ".") delete entries[0].mtimeNs;
  return entries;
}

function collectChild(child: ReturnType<typeof spawn>): Promise<{
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function processCommand(pid: number): string {
  const cmdline = `/proc/${pid}/cmdline`;
  if (existsSync(cmdline)) {
    return readFileSync(cmdline).toString("utf8").replaceAll("\0", " ");
  }
  return spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
}

function rpc(child: { stdin: { write: (s: string) => void } | null }, id: number, method: string, params: unknown = {}): void {
  child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function readRpc(
  child: { stdout: NodeJS.ReadableStream },
  id: string | number | null,
  timeoutMs = 4000,
): Promise<Record<string, unknown>> {
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
      assert.equal(servers[0]?.args.includes("--token"), false);
      assert.equal(servers[0]?.args.includes("bridge-token"), false);
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
        mcpServerName: "pinchtab",
        toolName: "pinchtab_navigate",
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "decline", name: "Decline", kind: "reject_once" },
        ],
        rawInput: { url: "https://example.com" },
      });
      await waitUntil(() => fake.answered.length === 1);
      assert.deepEqual(fake.answered, ["allow_once"]);
      assert.equal(store.get(ada.id)?.permission, null);

      const expectGenericPermission = async (
        prompt: Parameters<typeof fake.fire>[0],
        answeredBefore: number,
      ) => {
        fake.fire(prompt);
        await waitUntil(() => store.get(ada.id)?.permission !== null);
        const permission = store.get(ada.id)?.permission;
        assert.equal(fake.answered.length, answeredBefore);
        assert.equal(permission?.hostGrant, undefined);
        const cardId = permission?.cardId;
        assert.ok(cardId);
        await store.answerPermission(ada.id, "decline", cardId);
        assert.equal(fake.answered.at(-1), "decline");
      };

      await expectGenericPermission({
        rpcId: 6,
        title: "mcp__pinchtab__pinchtab_navigate",
        mcpServerName: "other",
        toolName: "pinchtab_navigate",
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "decline", name: "Decline", kind: "reject_once" },
        ],
        rawInput: { command: "printf spoofed-pinchtab-title" },
      }, 1);
      await expectGenericPermission({
        rpcId: 7,
        title: "Run command",
        description: "Page text mentions pinchtab",
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "decline", name: "Decline", kind: "reject_once" },
        ],
        rawInput: { command: "printf pinchtab" },
        meta: { source: "mcp__pinchtab" },
        raw: { transport: "pinchtab" },
      }, 2);
      await expectGenericPermission({
        rpcId: 9,
        title: "mcp__pinchtab__pinchtab_eval",
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "decline", name: "Decline", kind: "reject_once" },
        ],
        rawInput: { expression: "document.cookie" },
      }, 3);
      await expectGenericPermission({
        rpcId: 10,
        title: "Allow this tool?",
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "decline", name: "Decline", kind: "reject_once" },
        ],
        rawInput: { command: "ls" },
      }, 4);
      await expectGenericPermission({
        rpcId: 11,
        title: "Write file",
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "decline", name: "Decline", kind: "reject_once" },
        ],
        locations: [{ path: "/tmp/outside-pt.txt" }],
        toolKind: "edit",
      }, 5);
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
  test("production wrapper argv stays credential-free while authenticated focus succeeds", async () => {
    const token = `wrapper-argv-${randomBytes(16).toString("hex")}`;
    const authenticated: boolean[] = [];
    const server = http.createServer((req, res) => {
      authenticated.push(req.headers.authorization === `Bearer ${token}`);
      if (req.url === "/tabs") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ tabs: [{ id: "tab-argv", type: "page" }] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("wrapper argv fixture failed to bind");
    const url = `http://127.0.0.1:${address.port}`;
    const bin = await writeFakePinchTab(await tempDir("openbot-pt-wrapper-argv-"));
    const computer = new MemoryComputerRuntime({
      pinchTabUpstreams: [url],
      pinchTabToken: token,
    });
    await computer.allocate("ada");
    const [spec] = await pinchTabMcpServers(computer, "ada", {
      ...process.env,
      OPENBOT_PINCHTAB: bin,
    });
    assert.ok(spec, "healthy PinchTab did not produce an MCP wrapper spec");
    const child = spawn(spec.command, spec.args, {
      env: {
        ...process.env,
        ...Object.fromEntries(spec.env.map((row) => [row.name, row.value])),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      await waitUntil(() => processAlive(child.pid), 2_000);
      const argv = processCommand(child.pid ?? 0);
      assert.equal(argv.includes(token), false, "wrapper argv exposed its credential");
      assert.equal(argv.includes("--token"), false, "wrapper argv retained the token flag");

      rpc(child, 1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "argv-proof" },
      });
      await readRpc(child, 1);
      rpc(child, 2, "tools/call", { name: "pinchtab_click", arguments: { selector: "body" } });
      const called = await readRpc(child, 2);
      assert.equal(called.error, undefined);
      assert.ok(authenticated.length >= 4, "wrapper did not exercise readiness and focus receivers");
      assert.equal(authenticated.every(Boolean), true, "a receiver observed missing or incorrect authorization");
    } finally {
      child.kill("SIGTERM");
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

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

  test("a clean child exit with a pending client request makes the wrapper fail", async () => {
    const bin = await writeCleanExitOnListPinchTab(await tempDir("openbot-pt-child-clean-exit-"));
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
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      rpc(child, 1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
      await readRpc(child, 1);
      const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
      rpc(child, 2, "tools/list");
      const code = await Promise.race([
        closed,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_500)),
      ]);
      assert.notEqual(code, "timeout", "wrapper stayed alive after its child exited");
      assert.notEqual(code, 0, "wrapper reported success with a pending client request");
      const replies = output
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as { id?: unknown; error?: unknown })
        .filter((message) => message.id === 2);
      assert.equal(replies.length, 1, `request 2 replies: ${JSON.stringify(replies)}`);
      assert.match(JSON.stringify(replies[0]?.error ?? {}), /exit|transport/i);
    } finally {
      child.kill("SIGKILL");
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

  test("an LSP header without Content-Length rejects pending work and terminates", async () => {
    const bin = await writeMalformedLspPinchTab(await tempDir("openbot-pt-child-malformed-lsp-"));
    const child = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        OPENBOT_PINCHTAB: bin,
        OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "5000",
        OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
        PINCHTAB_TOKEN: "t",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => (output += chunk.toString("utf8"));
    try {
      child.stdout.on("data", collect);
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      rpc(child, 2, "tools/list");
      const failed = await readRpc(child, 2, 750);
      const boundedExit = await Promise.race([
        exited.then((code) => ({ exited: true, code })),
        new Promise<{ exited: false; code: null }>((resolve) =>
          setTimeout(() => resolve({ exited: false, code: null }), 1_500),
        ),
      ]);

      assert.match(JSON.stringify(failed.error ?? {}), /malformed|Content-Length|framing/i);
      assert.equal(boundedExit.exited, true, "wrapper survived a malformed LSP header");
      assert.equal(output.split("\n").filter((line) => line.includes('"id":2')).length, 1, output);
      assert.doesNotMatch(output, /X-OpenBot|missing-length/u);
    } finally {
      child.stdout.off("data", collect);
      child.kill("SIGKILL");
    }
  });

  test("a primitive child message rejects pending work without crashing or forwarding bytes", async () => {
    const bin = await writePrimitiveOutputPinchTab(await tempDir("openbot-pt-child-primitive-"));
    const child = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        OPENBOT_PINCHTAB: bin,
        OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "5000",
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
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      rpc(child, 2, "tools/list");
      const failed = await readRpc(child, 2, 750);
      const boundedExit = await Promise.race([
        exited.then((code) => ({ exited: true, code })),
        new Promise<{ exited: false; code: null }>((resolve) =>
          setTimeout(() => resolve({ exited: false, code: null }), 1_500),
        ),
      ]);

      assert.match(JSON.stringify(failed.error ?? {}), /malformed|object|JSON-RPC|framing/i);
      assert.equal(boundedExit.exited, true, "wrapper crashed without a bounded transport shutdown");
      assert.equal(output.split("\n").filter((line) => line.includes('"id":2')).length, 1, output);
      assert.doesNotMatch(output, /^null$/mu);
    } finally {
      child.stdout.off("data", collect);
      child.kill("SIGKILL");
    }
  });

  test("malformed client input returns one parse error and terminates the child transport", async () => {
    const bin = await writeSilentListPinchTab(await tempDir("openbot-pt-client-malformed-"));
    const child = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        OPENBOT_PINCHTAB: bin,
        OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
        PINCHTAB_TOKEN: "t",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const messages: Array<{ id?: unknown; error?: unknown }> = [];
    let output = "";
    let buffer = "";
    const collect = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      buffer += text;
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
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\nnot-json\n`,
      );
      const boundedExit = await Promise.race([
        exited.then((code) => ({ exited: true, code })),
        new Promise<{ exited: false; code: null }>((resolve) =>
          setTimeout(() => resolve({ exited: false, code: null }), 1_500),
        ),
      ]);

      assert.equal(boundedExit.exited, true, "wrapper ignored malformed client input");
      await new Promise((resolve) => setTimeout(resolve, 40));
      const parseErrors = messages.filter((message) => message.id === null && message.error !== undefined);
      const pendingErrors = messages.filter((message) => message.id === 2 && message.error !== undefined);
      assert.equal(parseErrors.length, 1, JSON.stringify(messages));
      assert.equal(pendingErrors.length, 1, JSON.stringify(messages));
      assert.match(JSON.stringify(parseErrors[0]?.error ?? {}), /parse|malformed|JSON-RPC/i);
      assert.doesNotMatch(output, /not-json/u);
    } finally {
      child.stdout.off("data", collect);
      child.kill("SIGKILL");
    }
  });

  test("a colon-bearing primitive client frame fails closed instead of entering LSP mode", async () => {
    const bin = await writeFakePinchTab(await tempDir("openbot-pt-client-primitive-colon-"));
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
    try {
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      child.stdin.write('"bad:value"\n');
      const failed = await readRpc(child, null, 750);
      assert.match(JSON.stringify(failed.error ?? {}), /parse|malformed|object|JSON-RPC/i);
      await exited;
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("an incomplete client frame has a bounded assembly deadline", async () => {
    const bin = await writeFakePinchTab(await tempDir("openbot-pt-client-partial-frame-"));
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
    try {
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      child.stdin.write("Content-Length: 100\r\n\r\n{");
      const failed = await readRpc(child, null, 900);
      assert.match(JSON.stringify(failed.error ?? {}), /frame|framing|timed out|deadline/i);
      const boundedExit = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_500)),
      ]);
      assert.equal(boundedExit, true, "wrapper survived an incomplete client frame");
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("LF-only LSP framing fails closed without registering a request", async () => {
    const bin = await writeFakePinchTab(await tempDir("openbot-pt-client-lf-lsp-"));
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
    try {
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      child.stdin.write("Content-Length: 2\n\n{}");
      const failed = await readRpc(child, null, 750);
      assert.match(JSON.stringify(failed.error ?? {}), /LSP|CRLF|framing|malformed/i);
      await exited;
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("invalid JSON-RPC envelopes and IDs fail before child forwarding", async () => {
    const cases: Array<{ label: string; message: Record<string, unknown>; responseId: string | number | null }> = [
      { label: "missing-version", message: { id: 1, method: "tools/list", params: {} }, responseId: 1 },
      { label: "null-id", message: { jsonrpc: "2.0", id: null, method: "tools/list", params: {} }, responseId: null },
      { label: "boolean-id", message: { jsonrpc: "2.0", id: true, method: "tools/list", params: {} }, responseId: null },
      { label: "array-id", message: { jsonrpc: "2.0", id: [1], method: "tools/list", params: {} }, responseId: null },
      { label: "object-id", message: { jsonrpc: "2.0", id: { value: 1 }, method: "tools/list", params: {} }, responseId: null },
    ];

    for (const row of cases) {
      const dir = await tempDir(`openbot-pt-client-${row.label}-`);
      const bin = await writeRequestLoggingPinchTab(dir);
      const requestLog = join(dir, "requests.log");
      const child = spawn(process.execPath, [wrapper], {
        env: {
          ...process.env,
          OPENBOT_PINCHTAB: bin,
          OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "200",
          OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
          OPENBOT_REQUEST_LOG: requestLog,
          PINCHTAB_TOKEN: "t",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      try {
        const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
        child.stdin.write(`${JSON.stringify(row.message)}\n`);
        const failed = await readRpc(child, row.responseId, 750);
        assert.match(JSON.stringify(failed.error ?? {}), /JSON-RPC|invalid|request/i, row.label);
        await exited;
        assert.equal(existsSync(requestLog), false, `${row.label} reached the child`);
      } finally {
        child.kill("SIGKILL");
      }
    }
  });

  test("request-only MCP methods cannot execute as notifications", async () => {
    const dir = await tempDir("openbot-pt-client-request-notification-");
    const bin = await writeRequestLoggingPinchTab(dir);
    const requestLog = join(dir, "requests.log");
    const child = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        OPENBOT_PINCHTAB: bin,
        OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
        OPENBOT_REQUEST_LOG: requestLog,
        PINCHTAB_TOKEN: "t",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "pinchtab_click", arguments: {} } })}\n`,
      );
      const failed = await readRpc(child, null, 750);
      assert.match(JSON.stringify(failed.error ?? {}), /request ID|request-only|requires/i);
      await exited;
      assert.equal(existsSync(requestLog), false, "request-only notification reached the child");
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("a silent child-originated request terminates on its own bounded deadline", async () => {
    const dir = await tempDir("openbot-pt-child-request-timeout-");
    const bin = await writeSilentServerRequestPinchTab(dir);
    const requestLog = join(dir, "requests.log");
    const input = new PassThrough();
    const output = new PassThrough();
    const running = runPinchTabAllowlistProxy(input, output, {
      ...process.env,
      OPENBOT_PINCHTAB: bin,
      OPENBOT_PINCHTAB_MCP_CHILD_REQUEST_TIMEOUT_MS: "500",
      OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "5000",
      OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
      PINCHTAB_TOKEN: "t",
    });
    const messages: Array<{ id?: number; method?: string }> = [];
    let buffer = "";
    const collect = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) messages.push(JSON.parse(line) as (typeof messages)[number]);
      }
    };
    try {
      output.on("data", collect);
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } } })}\n`,
      );
      await waitUntil(() => messages.some((message) => message.id === 1), 10_000);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      let observerTimer: NodeJS.Timeout | undefined;
      const boundedExit = await Promise.race([
        running.then(() => true),
        new Promise<false>((resolve) => {
          observerTimer = setTimeout(() => resolve(false), 10_000);
        }),
      ]);
      if (observerTimer) clearTimeout(observerTimer);
      assert.equal(boundedExit, true, "silent child-originated request left the transport alive");
      const serverRequest = messages.find((message) => message.id === 91);
      assert.equal(serverRequest?.method, "sampling/createMessage", JSON.stringify(messages));
      assert.match(readFileSync(requestLog, "utf8"), /received:notifications\/initialized/u);
      assert.match(readFileSync(requestLog, "utf8"), /emitted:sampling\/createMessage/u);
    } finally {
      output.off("data", collect);
      input.end();
      await running;
      output.destroy();
    }
  });

  test("the single-use client ID ledger resets the transport at its configured cap", async () => {
    const bin = await writeFakePinchTab(await tempDir("openbot-pt-client-id-cap-"));
    const child = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        OPENBOT_PINCHTAB: bin,
        OPENBOT_PINCHTAB_MCP_ID_LEDGER_MAX: "3",
        OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
        PINCHTAB_TOKEN: "t",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      rpc(child, 1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
      await readRpc(child, 1);
      rpc(child, 2, "tools/list");
      await readRpc(child, 2);
      rpc(child, 3, "tools/list");
      await readRpc(child, 3);
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      rpc(child, 4, "tools/list");
      const capped = await readRpc(child, 4, 750);
      assert.match(JSON.stringify(capped.error ?? {}), /ledger|transport reset|3/i);
      await exited;
    } finally {
      child.kill("SIGKILL");
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
      await waitUntil(() => existsSync(callLog), 500);
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      rpc(child, 7, "tools/list");
      await waitUntil(() => messages.some((message) => message.id === 7), 750);
      const boundedExit = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_800)),
      ]);
      assert.equal(boundedExit, true, "duplicate active ID left the transport alive");
      await new Promise((resolve) => setTimeout(resolve, 300));

      const replies = messages.filter((message) => message.id === 7);
      assert.equal(replies.length, 1, JSON.stringify(replies));
      assert.equal(replies.filter((message) => message.error !== undefined).length, 1, JSON.stringify(replies));
      assert.equal(replies.filter((message) => message.result !== undefined).length, 0, JSON.stringify(replies));
      assert.deepEqual(readFileSync(callLog, "utf8").trim().split("\n"), ["7"]);
    } finally {
      child.stdout.off("data", collect);
      child.kill("SIGTERM");
    }
  });

  test("a client output stream failure terminates the transport without leaking its child", async () => {
    const dir = await tempDir("openbot-pt-client-output-fail-");
    const bin = await writeStubbornOutputPinchTab(dir);
    const pidFile = join(dir, "child.pid");
    const input = new PassThrough();
    const frames: string[] = [];
    let writes = 0;
    const output = new Writable({
      write(chunk, _encoding, callback) {
        writes += 1;
        frames.push(chunk.toString("utf8"));
        callback(writes === 1 ? undefined : new Error("ACP output pipe failed"));
      },
    });
    const running = runPinchTabAllowlistProxy(input, output, {
      ...process.env,
      OPENBOT_OUTPUT_CHILD_PID_FILE: pidFile,
      OPENBOT_PINCHTAB: bin,
      OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
      PINCHTAB_TOKEN: "t",
    });
    try {
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } } })}\n`,
      );
      await waitUntil(() => frames.some((frame) => frame.includes('"id":1')), 750);
      await waitUntil(() => existsSync(pidFile), 750);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);

      const boundedExit = await Promise.race([
        running.then((code) => ({ exited: true, code })),
        new Promise<{ exited: false; code: null }>((resolve) =>
          setTimeout(() => resolve({ exited: false, code: null }), 1_800),
        ),
      ]);
      assert.equal(boundedExit.exited, true, "wrapper stayed alive after client output failed");
      const requestFrames = frames.filter((frame) => frame.includes('"id":2'));
      assert.equal(requestFrames.length, 1, JSON.stringify(frames));
      assert.equal(
        processAlive(Number(readFileSync(pidFile, "utf8"))),
        false,
        "PinchTab child survived client output failure",
      );
    } finally {
      input.destroy();
      output.destroy();
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (processAlive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  });

  test("a client input stream failure rejects a pending request once and reaps its child", async () => {
    const dir = await tempDir("openbot-pt-client-input-fail-");
    const bin = await writeStubbornOutputPinchTab(dir);
    const pidFile = join(dir, "child.pid");
    const callLog = join(dir, "calls.log");
    const input = new PassThrough();
    const output = new PassThrough();
    const messages: Array<{ id?: number; error?: unknown }> = [];
    let buffer = "";
    output.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) messages.push(JSON.parse(line) as (typeof messages)[number]);
      }
    });
    const running = runPinchTabAllowlistProxy(input, output, {
      ...process.env,
      OPENBOT_OUTPUT_CHILD_CALL_LOG: callLog,
      OPENBOT_OUTPUT_CHILD_PID_FILE: pidFile,
      OPENBOT_PINCHTAB: bin,
      OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
      PINCHTAB_TOKEN: "t",
    });
    try {
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } } })}\n`,
      );
      await waitUntil(() => messages.some((message) => message.id === 1), 750);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
      await waitUntil(() => existsSync(callLog), 750);
      input.destroy(new Error("ACP input pipe failed"));

      const boundedExit = await Promise.race([
        running.then((code) => ({ exited: true, code })),
        new Promise<{ exited: false; code: null }>((resolve) =>
          setTimeout(() => resolve({ exited: false, code: null }), 1_800),
        ),
      ]);
      assert.equal(boundedExit.exited, true, "wrapper stayed alive after client input failed");
      const replies = messages.filter((message) => message.id === 2);
      assert.equal(replies.length, 1, JSON.stringify(messages));
      assert.match(JSON.stringify(replies[0]?.error ?? {}), /client input|ACP input pipe failed/i);
      assert.deepEqual(readFileSync(callLog, "utf8").trim().split("\n"), ["2"]);
      assert.equal(
        processAlive(Number(readFileSync(pidFile, "utf8"))),
        false,
        "PinchTab child survived client input failure",
      );
    } finally {
      input.destroy();
      output.destroy();
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (processAlive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  });

  test("output backpressure pauses ingress and reaps the child when drain never arrives", async () => {
    const dir = await tempDir("openbot-pt-client-backpressure-");
    const bin = await writeStubbornOutputPinchTab(dir);
    const pidFile = join(dir, "child.pid");
    const callLog = join(dir, "calls.log");
    const input = new PassThrough();
    const frames: string[] = [];
    let blockedWrite: ((error?: Error | null) => void) | undefined;
    const output = new Writable({
      highWaterMark: 1_024,
      write(chunk, _encoding, callback) {
        frames.push(chunk.toString("utf8"));
        if (frames.length === 1) callback();
        else blockedWrite = callback;
      },
    });
    const running = runPinchTabAllowlistProxy(input, output, {
      ...process.env,
      OPENBOT_OUTPUT_CHILD_CALL_LOG: callLog,
      OPENBOT_OUTPUT_CHILD_PID_FILE: pidFile,
      OPENBOT_OUTPUT_LARGE: "1",
      OPENBOT_PINCHTAB: bin,
      OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "500",
      OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
      PINCHTAB_TOKEN: "t",
    });
    try {
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } } })}\n`,
      );
      await waitUntil(() => frames.some((frame) => frame.includes('"id":1')), 750);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
      await waitUntil(() => frames.length === 2, 1_500);
      assert.equal(output.writableNeedDrain, true, "large valid response did not apply backpressure");
      assert.equal(input.isPaused(), true, "client input stayed flowing while output was blocked");
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);

      const boundedExit = await Promise.race([
        running.then((code) => ({ exited: true, code })),
        new Promise<{ exited: false; code: null }>((resolve) =>
          setTimeout(() => resolve({ exited: false, code: null }), 3_000),
        ),
      ]);
      assert.equal(boundedExit.exited, true, "wrapper stayed alive without an output drain");
      assert.equal(frames.length, 2, "proxy queued additional output behind the blocked response");
      assert.ok(output.writableLength <= Buffer.byteLength(frames[1] ?? ""));
      assert.deepEqual(readFileSync(callLog, "utf8").trim().split("\n"), ["2"]);
      assert.equal(
        processAlive(Number(readFileSync(pidFile, "utf8"))),
        false,
        "PinchTab child survived output backpressure timeout",
      );
    } finally {
      blockedWrite?.();
      input.destroy();
      output.destroy();
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (processAlive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  });

  test("a large response that drains resumes ingress without resetting the transport", async () => {
    const dir = await tempDir("openbot-pt-client-backpressure-drain-");
    const bin = await writeStubbornOutputPinchTab(dir);
    const pidFile = join(dir, "child.pid");
    const callLog = join(dir, "calls.log");
    const input = new PassThrough();
    const frames: string[] = [];
    const output = new Writable({
      highWaterMark: 1_024,
      write(chunk, _encoding, callback) {
        frames.push(chunk.toString("utf8"));
        if (frames.length === 1) callback();
        else setTimeout(callback, 50);
      },
    });
    const running = runPinchTabAllowlistProxy(input, output, {
      ...process.env,
      OPENBOT_OUTPUT_CHILD_CALL_LOG: callLog,
      OPENBOT_OUTPUT_CHILD_PID_FILE: pidFile,
      OPENBOT_OUTPUT_LARGE: "1",
      OPENBOT_PINCHTAB: bin,
      OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "500",
      OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
      PINCHTAB_TOKEN: "t",
    });
    try {
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } } })}\n`,
      );
      await waitUntil(() => frames.some((frame) => frame.includes('"id":1')), 750);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
      await waitUntil(() => frames.some((frame) => frame.includes('"id":2')), 1_500);
      assert.equal(input.isPaused(), true, "large response did not pause client ingress");
      await waitUntil(() => !input.isPaused(), 750);

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
      await waitUntil(() => frames.some((frame) => frame.includes('"id":3')), 1_500);
      assert.deepEqual(readFileSync(callLog, "utf8").trim().split("\n"), ["2", "3"]);
      input.destroy(new Error("test cleanup"));
      const boundedExit = await Promise.race([
        running.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000)),
      ]);
      assert.equal(boundedExit, true, "drained transport did not retain bounded shutdown");
    } finally {
      input.destroy();
      output.destroy();
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (processAlive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  });

  test("batched child responses wait for client output drain and remain ordered", async () => {
    const dir = await tempDir("openbot-pt-client-backpressure-batch-");
    const bin = await writeStubbornOutputPinchTab(dir);
    const pidFile = join(dir, "child.pid");
    const callLog = join(dir, "calls.log");
    const input = new PassThrough();
    const frames: Array<{ id?: number; result?: unknown; error?: unknown }> = [];
    let releaseFirstWrite: (() => void) | undefined;
    const output = new Writable({
      highWaterMark: 1_024,
      write(chunk, _encoding, callback) {
        const frame = JSON.parse(chunk.toString("utf8")) as (typeof frames)[number];
        frames.push(frame);
        if (frame.id === 1) {
          releaseFirstWrite = () => {
            releaseFirstWrite = undefined;
            callback();
          };
        } else callback();
      },
    });
    const running = runPinchTabAllowlistProxy(input, output, {
      ...process.env,
      OPENBOT_OUTPUT_BATCH: "1",
      OPENBOT_OUTPUT_CHILD_CALL_LOG: callLog,
      OPENBOT_OUTPUT_CHILD_PID_FILE: pidFile,
      OPENBOT_PINCHTAB: bin,
      OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "1500",
      OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
      PINCHTAB_TOKEN: "t",
    });
    try {
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } } })}\n`,
      );
      await waitUntil(() => frames.some((frame) => frame.id === 0), 750);
      await waitUntil(() => existsSync(pidFile), 750);
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
      );

      await waitUntil(() => frames.some((frame) => frame.id === 1), 750);
      assert.equal(output.writableNeedDrain, true, "first large response did not apply backpressure");
      assert.equal(input.isPaused(), true, "client ingress stayed flowing before output drain");
      assert.ok(releaseFirstWrite, "first output write was not held for the drain assertion");
      releaseFirstWrite();
      await waitUntil(() => frames.some((frame) => frame.id === 2), 750);
      await waitUntil(() => !input.isPaused(), 750);

      const batchedReplies = frames.filter((frame) => frame.id === 1 || frame.id === 2);
      assert.deepEqual(batchedReplies.map((frame) => frame.id), [1, 2], JSON.stringify(frames));
      assert.equal(batchedReplies.filter((frame) => frame.error !== undefined).length, 0, JSON.stringify(frames));

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
      await waitUntil(() => frames.some((frame) => frame.id === 3), 750);
      assert.deepEqual(readFileSync(callLog, "utf8").trim().split("\n"), ["1", "2", "3"]);

      input.end();
      const boundedExit = await Promise.race([
        running.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_500)),
      ]);
      assert.equal(boundedExit, true, "drained batch transport did not shut down boundedly");
      assert.equal(
        processAlive(Number(readFileSync(pidFile, "utf8"))),
        false,
        "PinchTab child survived drained batch cleanup",
      );
    } finally {
      releaseFirstWrite?.();
      input.destroy();
      output.destroy();
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (processAlive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  });

  test("a queued child response cannot succeed after its deadline when the child exits", async () => {
    const dir = await tempDir("openbot-pt-client-backpressure-exit-deadline-");
    const bin = await writeStubbornOutputPinchTab(dir);
    const pidFile = join(dir, "child.pid");
    const input = new PassThrough();
    const frames: Array<{ id?: number; result?: unknown; error?: { message?: string } }> = [];
    let releaseTriggerWrite: (() => void) | undefined;
    const output = new Writable({
      highWaterMark: 1_024,
      write(chunk, _encoding, callback) {
        const frame = JSON.parse(chunk.toString("utf8")) as (typeof frames)[number];
        frames.push(frame);
        if (frame.id === 2) {
          releaseTriggerWrite = () => {
            releaseTriggerWrite = undefined;
            callback();
          };
        } else callback();
      },
    });
    const requestTimeoutMs = 900;
    const running = runPinchTabAllowlistProxy(input, output, {
      ...process.env,
      OPENBOT_OUTPUT_CHILD_PID_FILE: pidFile,
      OPENBOT_OUTPUT_EXIT_BATCH: "1",
      OPENBOT_PINCHTAB: bin,
      OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: String(requestTimeoutMs),
      OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
      PINCHTAB_TOKEN: "t",
    });
    try {
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } } })}\n`,
      );
      await waitUntil(() => frames.some((frame) => frame.id === 0), 750);
      await waitUntil(() => existsSync(pidFile), 750);

      const firstAcceptedAt = Date.now();
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);

      await waitUntil(() => frames.some((frame) => frame.id === 2), 750);
      assert.equal(output.writableNeedDrain, true, "trigger response did not apply backpressure");
      assert.ok(releaseTriggerWrite, "trigger response was not held before drain");
      await waitUntil(() => !processAlive(Number(readFileSync(pidFile, "utf8"))), 750);
      const remainingToExpiry = firstAcceptedAt + requestTimeoutMs + 100 - Date.now();
      if (remainingToExpiry > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingToExpiry));
      }
      releaseTriggerWrite();

      await waitUntil(() => frames.some((frame) => frame.id === 1), 750);
      const expiredReplies = frames.filter((frame) => frame.id === 1);
      assert.equal(expiredReplies.length, 1, JSON.stringify(frames));
      assert.equal(expiredReplies[0]?.result, undefined, JSON.stringify(frames));
      assert.match(expiredReplies[0]?.error?.message ?? "", /timed out/);
      const triggerReplies = frames.filter((frame) => frame.id === 2);
      assert.equal(triggerReplies.length, 1, JSON.stringify(frames));
      assert.notEqual(triggerReplies[0]?.result, undefined, JSON.stringify(frames));
      assert.equal(triggerReplies[0]?.error, undefined, JSON.stringify(frames));

      const boundedExit = await Promise.race([
        running.then((code) => ({ exited: true, code })),
        new Promise<{ exited: false; code: null }>((resolve) =>
          setTimeout(() => resolve({ exited: false, code: null }), 2_000),
        ),
      ]);
      assert.equal(boundedExit.exited, true, "post-exit output deadline left the proxy unsettled");
      assert.notEqual(boundedExit.code, 0, JSON.stringify({ boundedExit, frames }));
    } finally {
      releaseTriggerWrite?.();
      input.destroy();
      output.destroy();
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (processAlive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  });

  test("a clean child exit reports failure when queued client output never drains", async () => {
    const dir = await tempDir("openbot-pt-client-backpressure-exit-no-drain-");
    const bin = await writeStubbornOutputPinchTab(dir);
    const pidFile = join(dir, "child.pid");
    const input = new PassThrough();
    const frames: Array<{ id?: number; result?: unknown; error?: unknown }> = [];
    let releaseBlockedWrite: (() => void) | undefined;
    const output = new Writable({
      highWaterMark: 1_024,
      write(chunk, _encoding, callback) {
        const frame = JSON.parse(chunk.toString("utf8")) as (typeof frames)[number];
        frames.push(frame);
        if (frame.id === 2) {
          releaseBlockedWrite = () => {
            releaseBlockedWrite = undefined;
            callback();
          };
        } else callback();
      },
    });
    const running = runPinchTabAllowlistProxy(input, output, {
      ...process.env,
      OPENBOT_OUTPUT_CHILD_PID_FILE: pidFile,
      OPENBOT_OUTPUT_EXIT_BATCH: "1",
      OPENBOT_PINCHTAB: bin,
      OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "180",
      OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
      PINCHTAB_TOKEN: "t",
    });
    try {
      await waitUntil(() => existsSync(pidFile), 1_500);
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } } })}\n`,
      );
      await waitUntil(() => frames.some((frame) => frame.id === 0), 750);
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
      );

      await waitUntil(() => frames.some((frame) => frame.id === 2), 750);
      assert.equal(output.writableNeedDrain, true, "large response did not hold client output");
      assert.ok(releaseBlockedWrite, "large response write was not held");
      await waitUntil(() => !processAlive(Number(readFileSync(pidFile, "utf8"))), 750);

      const boundedExit = await Promise.race([
        running.then((code) => ({ exited: true, code })),
        new Promise<{ exited: false; code: null }>((resolve) =>
          setTimeout(() => resolve({ exited: false, code: null }), 1_500),
        ),
      ]);
      assert.equal(boundedExit.exited, true, "post-exit no-drain deadline left the proxy alive");
      assert.notEqual(boundedExit.code, 0, JSON.stringify({ boundedExit, frames }));
      assert.equal(frames.filter((frame) => frame.id === 1).length, 0, JSON.stringify(frames));
      assert.equal(frames.filter((frame) => frame.id === 2).length, 1, JSON.stringify(frames));
    } finally {
      releaseBlockedWrite?.();
      input.destroy();
      output.destroy();
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (processAlive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  });

  test("a child request queued behind backpressure is not relayed after its child exits", async () => {
    const dir = await tempDir("openbot-pt-child-request-exit-backpressure-");
    const bin = await writeStubbornOutputPinchTab(dir);
    const pidFile = join(dir, "child.pid");
    const input = new PassThrough();
    const frames: Array<{ id?: number; method?: string; result?: unknown; error?: unknown }> = [];
    let releaseBlockedWrite: (() => void) | undefined;
    const output = new Writable({
      highWaterMark: 1_024,
      write(chunk, _encoding, callback) {
        const frame = JSON.parse(chunk.toString("utf8")) as (typeof frames)[number];
        frames.push(frame);
        if (frame.id === 1) {
          releaseBlockedWrite = () => {
            releaseBlockedWrite = undefined;
            callback();
          };
        } else callback();
      },
    });
    const running = runPinchTabAllowlistProxy(input, output, {
      ...process.env,
      OPENBOT_OUTPUT_CHILD_PID_FILE: pidFile,
      OPENBOT_OUTPUT_CHILD_REQUEST_EXIT_BATCH: "1",
      OPENBOT_PINCHTAB: bin,
      OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "1000",
      OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
      PINCHTAB_TOKEN: "t",
    });
    try {
      await waitUntil(() => existsSync(pidFile), 1_500);
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } } })}\n`,
      );
      await waitUntil(() => frames.some((frame) => frame.id === 0), 750);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);

      await waitUntil(() => frames.some((frame) => frame.id === 1), 750);
      assert.equal(output.writableNeedDrain, true, "client response did not apply backpressure");
      assert.ok(releaseBlockedWrite, "client response write was not held");
      await waitUntil(() => !processAlive(Number(readFileSync(pidFile, "utf8"))), 750);
      assert.equal(frames.some((frame) => frame.method === "sampling/createMessage"), false);
      releaseBlockedWrite();

      const boundedExit = await Promise.race([
        running.then((code) => ({ exited: true, code })),
        new Promise<{ exited: false; code: null }>((resolve) =>
          setTimeout(() => resolve({ exited: false, code: null }), 1_500),
        ),
      ]);
      assert.equal(boundedExit.exited, true, "child-request cleanup left the proxy alive");
      assert.notEqual(boundedExit.code, 0, JSON.stringify({ boundedExit, frames }));
      assert.equal(
        frames.some((frame) => frame.method === "sampling/createMessage"),
        false,
        JSON.stringify(frames),
      );
      assert.equal(frames.filter((frame) => frame.id === 1 && frame.result !== undefined).length, 1);
    } finally {
      releaseBlockedWrite?.();
      input.destroy();
      output.destroy();
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (processAlive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  });

  test("child output queue overflow rejects pending IDs once and reaps the child", async () => {
    const dir = await tempDir("openbot-pt-client-backpressure-overflow-");
    const bin = await writeStubbornOutputPinchTab(dir);
    const pidFile = join(dir, "child.pid");
    const callLog = join(dir, "calls.log");
    const input = new PassThrough();
    const frames: Array<{ id?: number; result?: unknown; error?: unknown }> = [];
    let buffered = "";
    let releaseFirstWrite: (() => void) | undefined;
    let firstWriteHeld = false;
    const output = new Writable({
      highWaterMark: 1_024,
      write(chunk, _encoding, callback) {
        buffered += chunk.toString("utf8");
        let newline = buffered.indexOf("\n");
        while (newline !== -1) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line) frames.push(JSON.parse(line) as (typeof frames)[number]);
          newline = buffered.indexOf("\n");
        }
        if (!firstWriteHeld && frames.some((frame) => frame.id === 1)) {
          firstWriteHeld = true;
          releaseFirstWrite = () => {
            releaseFirstWrite = undefined;
            callback();
          };
        } else {
          callback();
        }
      },
    });
    const running = runPinchTabAllowlistProxy(input, output, {
      ...process.env,
      OPENBOT_OUTPUT_CHILD_CALL_LOG: callLog,
      OPENBOT_OUTPUT_CHILD_PID_FILE: pidFile,
      OPENBOT_OUTPUT_EXIT_ON_TERM: "1",
      OPENBOT_OUTPUT_OVERFLOW: "1",
      OPENBOT_PINCHTAB: bin,
      OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "3000",
      OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
      PINCHTAB_TOKEN: "t",
    });
    try {
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } } })}\n`,
      );
      await waitUntil(() => frames.some((frame) => frame.id === 0), 750);
      await waitUntil(() => existsSync(pidFile), 750);
      input.write(
        Array.from({ length: 18 }, (_, index) =>
          `${JSON.stringify({ jsonrpc: "2.0", id: index + 1, method: "tools/list" })}\n`,
        ).join(""),
      );

      await waitUntil(() => frames.some((frame) => frame.id === 1), 750);
      assert.equal(output.writableNeedDrain, true, "overflow batch did not apply backpressure");
      assert.equal(input.isPaused(), true, "client ingress stayed flowing during overflow");
      assert.ok(releaseFirstWrite, "overflow batch first write was not held");
      await waitUntil(() => !processAlive(Number(readFileSync(pidFile, "utf8"))), 750);
      const settledBeforeDrain = await Promise.race([
        running.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
      assert.equal(settledBeforeDrain, false, "transport settled before queued terminal replies drained");
      releaseFirstWrite();

      const boundedExit = await Promise.race([
        running.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_500)),
      ]);
      assert.equal(boundedExit, true, "overflowed child output queue did not terminate boundedly");
      await waitUntil(() => frames.filter((frame) => frame.id !== 0).length === 18, 750);
      const terminal = frames.filter((frame) => frame.id !== 0);
      assert.deepEqual(terminal.map((frame) => frame.id), Array.from({ length: 18 }, (_, index) => index + 1));
      assert.equal(terminal.filter((frame) => frame.id === 1 && frame.result !== undefined).length, 1);
      assert.equal(terminal.filter((frame) => frame.id !== 1 && frame.error !== undefined).length, 17);
      assert.equal(new Set(terminal.map((frame) => frame.id)).size, terminal.length, JSON.stringify(frames));
      assert.deepEqual(
        readFileSync(callLog, "utf8").trim().split("\n"),
        Array.from({ length: 18 }, (_, index) => String(index + 1)),
      );
      assert.equal(
        processAlive(Number(readFileSync(pidFile, "utf8"))),
        false,
        "PinchTab child survived output queue overflow",
      );
    } finally {
      releaseFirstWrite?.();
      input.destroy();
      output.destroy();
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (processAlive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  });

  test("deferred tool response survives list-response output backpressure from the same child batch", async () => {
    const dir = await tempDir("openbot-pt-client-backpressure-mixed-");
    const bin = await writeStubbornOutputPinchTab(dir);
    const pidFile = join(dir, "child.pid");
    const callLog = join(dir, "calls.log");
    const input = new PassThrough();
    const frames: Array<{ id?: number; result?: unknown; error?: unknown }> = [];
    let releaseListWrite: (() => void) | undefined;
    const output = new Writable({
      highWaterMark: 1_024,
      write(chunk, _encoding, callback) {
        const frame = JSON.parse(chunk.toString("utf8")) as (typeof frames)[number];
        frames.push(frame);
        if (frame.id === 2) {
          releaseListWrite = () => {
            releaseListWrite = undefined;
            callback();
          };
        } else {
          callback();
        }
      },
    });
    const running = runPinchTabAllowlistProxy(input, output, {
      ...process.env,
      OPENBOT_OUTPUT_CHILD_CALL_LOG: callLog,
      OPENBOT_OUTPUT_CHILD_PID_FILE: pidFile,
      OPENBOT_OUTPUT_MIXED: "1",
      OPENBOT_PINCHTAB: bin,
      OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "1500",
      OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
      PINCHTAB_TOKEN: "t",
    });
    try {
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } } })}\n`,
      );
      await waitUntil(() => frames.some((frame) => frame.id === 0), 750);
      await waitUntil(() => existsSync(pidFile), 750);
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pinchtab_snapshot", arguments: {} } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
      );

      await waitUntil(() => frames.some((frame) => frame.id === 2), 750);
      assert.equal(output.writableNeedDrain, true, "large list response did not apply backpressure");
      assert.equal(input.isPaused(), true, "client ingress stayed flowing before mixed-batch drain");
      assert.ok(releaseListWrite, "large list response was not held for the drain assertion");
      releaseListWrite();
      await waitUntil(() => frames.some((frame) => frame.id === 1), 750);
      await waitUntil(() => !input.isPaused(), 750);

      const mixedReplies = frames.filter((frame) => frame.id === 1 || frame.id === 2);
      assert.deepEqual([...mixedReplies.map((frame) => frame.id)].sort(), [1, 2], JSON.stringify(frames));
      assert.equal(new Set(mixedReplies.map((frame) => frame.id)).size, 2, JSON.stringify(frames));
      assert.equal(mixedReplies.filter((frame) => frame.error !== undefined).length, 0, JSON.stringify(frames));

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
      await waitUntil(() => frames.some((frame) => frame.id === 3), 750);
      const childCalls = readFileSync(callLog, "utf8").trim().split("\n");
      assert.deepEqual([...childCalls.slice(0, 2)].sort(), ["1", "2"]);
      assert.equal(childCalls[2], "3");

      input.end();
      const boundedExit = await Promise.race([
        running.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_500)),
      ]);
      assert.equal(boundedExit, true, "mixed-batch transport did not shut down boundedly");
      assert.equal(
        processAlive(Number(readFileSync(pidFile, "utf8"))),
        false,
        "PinchTab child survived mixed-batch cleanup",
      );
    } finally {
      releaseListWrite?.();
      input.destroy();
      output.destroy();
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (processAlive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  });

  test("child input backpressure bounds ordinary requests and reaps a child that never drains", async () => {
    const dir = await tempDir("openbot-pt-child-input-backpressure-");
    const bin = await writeBackpressuredInputPinchTab(dir);
    const pidFile = join(dir, "child.pid");
    const input = new PassThrough({ highWaterMark: 16 * 1024 * 1024 });
    const output = new PassThrough();
    const messages: Array<{ id?: number; error?: unknown }> = [];
    let outputBuffer = "";
    output.on("data", (chunk: Buffer) => {
      outputBuffer += chunk.toString("utf8");
      const lines = outputBuffer.split("\n");
      outputBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) messages.push(JSON.parse(line) as (typeof messages)[number]);
      }
    });
    const running = runPinchTabAllowlistProxy(input, output, {
      ...process.env,
      OPENBOT_INPUT_CHILD_PID_FILE: pidFile,
      OPENBOT_PINCHTAB: bin,
      OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "400",
      OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
      PINCHTAB_TOKEN: "t",
    });
    const padding = "x".repeat(1024 * 1024);
    const batch = Array.from({ length: 8 }, (_, index) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: index + 1,
        method: "initialize",
        params: { padding },
      }),
    ).join("\n");
    try {
      await waitUntil(() => existsSync(pidFile), 750);
      input.write(`${batch}\n`);
      assert.equal(input.isPaused(), true, "client ingress stayed flowing after child stdin returned false");

      const boundedExit = await Promise.race([
        running.then((code) => ({ exited: true, code })),
        new Promise<{ exited: false; code: null }>((resolve) =>
          setTimeout(() => resolve({ exited: false, code: null }), 2_500),
        ),
      ]);
      assert.equal(boundedExit.exited, true, "wrapper stayed alive while child stdin never drained");
      const replies = messages.filter((message) => message.id !== undefined);
      assert.deepEqual(replies.map((message) => message.id), [1], JSON.stringify(messages));
      assert.equal(replies.filter((message) => message.error !== undefined).length, 1, JSON.stringify(messages));
      assert.equal(
        processAlive(Number(readFileSync(pidFile, "utf8"))),
        false,
        "PinchTab child survived child-input backpressure timeout",
      );
    } finally {
      input.destroy();
      output.destroy();
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (processAlive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  });

  test("a large ordinary request resumes only after child stdin really drains", async () => {
    const dir = await tempDir("openbot-pt-child-input-drain-");
    const bin = await writeBackpressuredInputPinchTab(dir);
    const pidFile = join(dir, "child.pid");
    const callLog = join(dir, "calls.log");
    const input = new PassThrough({ highWaterMark: 4 * 1024 * 1024 });
    const output = new PassThrough();
    const messages: Array<{ id?: number; result?: unknown; error?: unknown }> = [];
    let outputBuffer = "";
    output.on("data", (chunk: Buffer) => {
      outputBuffer += chunk.toString("utf8");
      const lines = outputBuffer.split("\n");
      outputBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) messages.push(JSON.parse(line) as (typeof messages)[number]);
      }
    });
    const running = runPinchTabAllowlistProxy(input, output, {
      ...process.env,
      OPENBOT_INPUT_CHILD_CALL_LOG: callLog,
      OPENBOT_INPUT_CHILD_PID_FILE: pidFile,
      OPENBOT_INPUT_DRAIN_DELAY_MS: "300",
      OPENBOT_PINCHTAB: bin,
      OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "1500",
      OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
      PINCHTAB_TOKEN: "t",
    });
    try {
      await waitUntil(() => existsSync(pidFile), 750);
      input.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { padding: "x".repeat(1024 * 1024) },
        })}\n`,
      );
      assert.equal(input.isPaused(), true, "large valid request did not pause client ingress");
      await waitUntil(() => messages.some((message) => message.id === 1), 1_250);
      assert.equal(input.isPaused(), false, "client ingress resumed before a real child stdin drain");
      assert.equal(messages.find((message) => message.id === 1)?.error, undefined, JSON.stringify(messages));

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} })}\n`);
      await waitUntil(() => messages.some((message) => message.id === 2), 750);
      assert.deepEqual(readFileSync(callLog, "utf8").trim().split("\n"), ["1", "2"]);
      assert.equal(messages.find((message) => message.id === 2)?.error, undefined, JSON.stringify(messages));

      input.end();
      const boundedExit = await Promise.race([
        running.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_500)),
      ]);
      assert.equal(boundedExit, true, "drained child-input transport did not shut down boundedly");
    } finally {
      input.destroy();
      output.destroy();
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (processAlive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  });

  test("a child request sharing a pending client ID stays in the server-to-client direction", async () => {
    const dir = await tempDir("openbot-pt-child-direction-id-");
    const bin = await writeDirectionCollisionPinchTab(dir);
    const directionLog = join(dir, "direction.log");
    const child = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        OPENBOT_DIRECTION_LOG: directionLog,
        OPENBOT_PINCHTAB: bin,
        OPENBOT_PINCHTAB_MCP_CHILD_REQUEST_TIMEOUT_MS: "1500",
        OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "3000",
        OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
        PINCHTAB_TOKEN: "t",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      rpc(child, 1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } });
      await readRpc(child, 1);
      rpc(child, 2, "tools/call", { name: "pinchtab_get_text", arguments: {} });
      const serverRequest = await readRpc(child, 2);
      assert.equal(serverRequest.method, "pinchtab/ping");
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { pong: true } })}\n`);
      const toolResponse = await readRpc(child, 2, 2_500);

      assert.equal(toolResponse.error, undefined, JSON.stringify(toolResponse));
      assert.match(JSON.stringify(toolResponse.result ?? {}), /actual-tool-response/u);
      assert.equal(readFileSync(directionLog, "utf8"), "client-response\n");
      rpc(child, 3, "tools/call", { name: "pinchtab_get_text", arguments: {} });
      const nextResponse = await readRpc(child, 3, 2_500);
      assert.match(JSON.stringify(nextResponse.result ?? {}), /transport-still-usable/u);
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      rpc(child, 4, "tools/call", { name: "pinchtab_get_text", arguments: {} });
      const afterTimer = await readRpc(child, 4, 2_500);
      assert.match(JSON.stringify(afterTimer.result ?? {}), /transport-still-usable/u);
    } finally {
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
    const closedFile = join(dir, "stdin-closed");
    const child = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        OPENBOT_PINCHTAB: bin,
        OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "5000",
        OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
        OPENBOT_STDIN_CLOSED_FILE: closedFile,
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
      child.stdout.on("data", collect);
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      rpc(child, 2, "tools/list");
      rpc(child, 3, "tools/list");
      await waitUntil(() => existsSync(closedFile), 1_000);
      rpc(child, 4, "tools/list");
      await waitUntil(
        () => messages.filter((message) => message.id === 2 || message.id === 3 || message.id === 4).length >= 3,
        1_000,
      );
      const boundedExit = await Promise.race([
        exited.then((code) => ({ exited: true, code })),
        new Promise<{ exited: false; code: null }>((resolve) =>
          setTimeout(() => resolve({ exited: false, code: null }), 1_800),
        ),
      ]);

      assert.equal(boundedExit.exited, true, "wrapper stayed alive after child stdin failed");
      for (const id of [2, 3, 4]) {
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

  test("queued tools keep one receipt-to-terminal deadline and never forward after expiry", async () => {
    const dir = await tempDir("openbot-pt-tool-queue-deadline-");
    const bin = await writeDelayedToolQueuePinchTab(dir);
    const callLog = join(dir, "calls.log");
    const child = spawn(process.execPath, [wrapper], {
      env: {
        ...process.env,
        OPENBOT_PINCHTAB: bin,
        OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS: "600",
        OPENBOT_PINCHTAB_SERVER: "http://127.0.0.1:9867",
        OPENBOT_TOOL_QUEUE_LOG: callLog,
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
        if (line.trim()) messages.push(JSON.parse(line) as (typeof messages)[number]);
      }
    };
    try {
      rpc(child, 0, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test" },
      });
      await readRpc(child, 0);
      child.stdout.on("data", collect);
      const started = Date.now();
      child.stdin.write(
        [1, 2, 3]
          .map((id) =>
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: { name: "pinchtab_snapshot", arguments: {} },
            }),
          )
          .join("\n") + "\n",
      );
      await waitUntil(
        () => [1, 2, 3].every((id) => messages.some((message) => message.id === id)),
        1_500,
      );

      const first = messages.filter((message) => message.id === 1);
      const second = messages.filter((message) => message.id === 2);
      const third = messages.filter((message) => message.id === 3);
      assert.equal(first.length, 1, JSON.stringify(messages));
      assert.equal(second.length, 1, JSON.stringify(messages));
      assert.equal(third.length, 1, JSON.stringify(messages));
      assert.equal(first[0]?.error, undefined, JSON.stringify(messages));
      assert.match(JSON.stringify(second[0]?.error ?? {}), /timed out|deadline|terminated/i);
      assert.match(JSON.stringify(third[0]?.error ?? {}), /timed out|deadline|terminated/i);
      assert.ok(Date.now() - started < 1_000, `queued deadline overran: ${Date.now() - started}ms`);
      assert.deepEqual(readFileSync(callLog, "utf8").trim().split("\n"), ["1", "2"]);
    } finally {
      child.stdout.off("data", collect);
      child.kill("SIGKILL");
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
  test("health and ensure-browser keep credentials out of live argv, traces, and logs", async () => {
    const root = await tempDir("openbot-pt-private-probes-");
    const home = join(root, "home");
    const binDir = join(root, "bin");
    const holdDir = join(root, "curl-hold");
    const authResults = join(root, "auth-results");
    const curlLog = join(root, "curl.log");
    const token = `probe-argv-${randomBytes(16).toString("hex")}`;
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const pinchtab = await writeSupervisedBridgeFixture(binDir);
    const setsid = await writeSetsidFixture(binDir);
    const curl = await writeCurlFixture(binDir);
    const port = await unusedLoopbackPort();
    const stateDir = join(home, ".pinchtab-d1");
    const ownerPath = join(stateDir, "bridge-owner.json");
    const env = {
      ...process.env,
      CHROME_USER_DATA_DIR: join(root, "profile"),
      COOKIE_JAR: join(root, "cookies"),
      OPENBOT_AUTH_RESULT_FILE: authResults,
      OPENBOT_CDP_PORT_BASE: String(port + 100),
      OPENBOT_CURL_HOLD_DIR: holdDir,
      OPENBOT_CURL_LOG: curlLog,
      OPENBOT_PINCHTAB_BIN: pinchtab,
      OPENBOT_PINCHTAB_PORT_BASE: String(port - 1),
      OPENBOT_REAL_CURL: curl.real,
      OPENBOT_SCREEN_HOME: home,
      OPENBOT_SETSID_BIN: setsid,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      PINCHTAB_TOKEN: token,
      VNC_USER: process.env.USER ?? "openbot",
    };
    const child = spawn("bash", ["-x", displaySh, "pinchtab", "1"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    let owner: { supervisorPid?: number; childPid?: number } = {};
    try {
      const healthPidFile = join(holdDir, "health.pid");
      await waitUntil(() => existsSync(healthPidFile), 5_000);
      const healthPid = Number(readFileSync(healthPidFile, "utf8"));
      const healthArgv = processCommand(healthPid);
      assert.equal(healthArgv.includes(token), false, "health probe argv exposed its credential");
      assert.equal(healthArgv.includes("Bearer "), false, "health probe argv exposed an authorization value");
      writeFileSync(join(holdDir, "health.release"), "release");

      const ensurePidFile = join(holdDir, "ensure-browser.pid");
      await waitUntil(() => existsSync(ensurePidFile), 5_000);
      const ensurePid = Number(readFileSync(ensurePidFile, "utf8"));
      const ensureArgv = processCommand(ensurePid);
      assert.equal(ensureArgv.includes(token), false, "ensure-browser argv exposed its credential");
      assert.equal(ensureArgv.includes("Bearer "), false, "ensure-browser argv exposed an authorization value");
      writeFileSync(join(holdDir, "ensure-browser.release"), "release");

      const code = await new Promise<number>((resolve) => child.on("close", (status) => resolve(status ?? 1)));
      assert.equal(code, 0, "credential-safe probe fixture did not become ready");
      assert.equal(stdout.includes(token), false, "probe stdout exposed its credential");
      assert.equal(stderr.includes(token), false, "probe trace or stderr exposed its credential");
      assert.equal(readFileSync(curlLog, "utf8").includes(token), false, "probe log exposed its credential");
      assert.deepEqual(readFileSync(authResults, "utf8").trim().split("\n"), [
        "health:ok",
        "ensure-browser:ok",
      ]);

      owner = JSON.parse(readFileSync(ownerPath, "utf8")) as typeof owner;
      assert.equal(modeOf(stateDir), 0o700);
      assert.equal(modeOf(join(stateDir, "config.json")), 0o600);
      assert.equal(modeOf(join(stateDir, "authorization.header")), 0o600);
      assert.equal(modeOf(join(stateDir, "bridge.log")), 0o600);
      assert.equal(readFileSync(join(stateDir, "bridge.log"), "utf8").includes(token), false);
      assert.equal(modeOf(ownerPath), 0o600);
    } finally {
      if (processAlive(child.pid)) child.kill("SIGKILL");
      if (processAlive(owner.supervisorPid)) process.kill(owner.supervisorPid as number, "SIGKILL");
      if (processAlive(owner.childPid)) process.kill(owner.childPid as number, "SIGKILL");
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("display CLI validates every command before path or arithmetic expansion", async () => {
    const root = await tempDir("openbot-display-validation-");
    const binDir = join(root, "bin");
    const pinchtab = join(binDir, "pinchtab");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(pinchtab, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(pinchtab, 0o755);

    const run = (command: string, display: string, home: string, token = "") =>
      spawnSync("bash", [displaySh, command, display], {
        encoding: "utf8",
        env: {
          ...process.env,
          COOKIE_JAR: join(home, "cookies"),
          OPENBOT_PINCHTAB_BIN: pinchtab,
          OPENBOT_SCREEN_HOME: home,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          PINCHTAB_TOKEN: token,
          VNC_USER: process.env.USER ?? "openbot",
        },
        timeout: 2_000,
      });

    try {
      const invalidCommands = [
        ["start", "1", /display must be 2-8/u],
        ["discard", "1", /display must be 2-8/u],
        ["stop", "9", /display must be 1-8/u],
        ["seed", "9", /display must be 1-8/u],
        ["cookies-in", "9", /display must be 1-8/u],
        ["cookies-out", "9", /display must be 1-8/u],
        ["cookies-clear", "9", /display must be 1-8/u],
        ["pinchtab", "9", /display must be 1-8/u],
        ["pinchtab-supervise", "9", /display must be 1-8/u],
      ] as const;
      for (const [index, [command, display, error]] of invalidCommands.entries()) {
        const home = join(root, `invalid-${index}`);
        mkdirSync(home);
        const result = run(command, display, home);
        assert.equal(result.signal, null, `${command}: ${result.stdout}${result.stderr}`);
        assert.equal(result.status, 1, `${command}: ${result.stdout}${result.stderr}`);
        assert.match(result.stderr, error, command);
        assert.deepEqual(readdirSync(home), [], `${command} mutated ${home}`);
      }

      const arithmeticHome = join(root, "arithmetic-home");
      mkdirSync(arithmeticHome);
      const arithmetic = run(
        "pinchtab",
        "BASH_REMATCH[$(printf DISPLAY_INJECTION >&2)]",
        arithmeticHome,
        "validation-token",
      );
      assert.equal(arithmetic.signal, null, arithmetic.stdout + arithmetic.stderr);
      assert.equal(arithmetic.status, 1, arithmetic.stdout + arithmetic.stderr);
      assert.match(arithmetic.stderr, /display must be 1-8/u);
      assert.doesNotMatch(arithmetic.stderr, /DISPLAY_INJECTION/u);
      assert.deepEqual(readdirSync(arithmeticHome), [], "arithmetic payload mutated Screen Home");

      const traversalHome = join(root, "traversal-home");
      const traversalTarget = join(root, "traversal-target");
      mkdirSync(traversalHome);
      const traversal = run("seed", "/../../traversal-target", traversalHome);
      assert.equal(traversal.signal, null, traversal.stdout + traversal.stderr);
      assert.equal(traversal.status, 1, traversal.stdout + traversal.stderr);
      assert.match(traversal.stderr, /display must be 1-8/u);
      assert.equal(existsSync(traversalTarget), false, "display suffix escaped Screen Home");
      assert.deepEqual(readdirSync(traversalHome), [], "traversal payload mutated Screen Home");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("display discard is idempotent before start and preserves the committed cookie jar", async () => {
    const root = await tempDir("openbot-display-discard-never-started-");
    const home = join(root, "home");
    const jar = join(root, "cookies");
    const binDir = join(root, "bin");
    mkdirSync(join(jar, "Network"), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(jar, "Network", "Cookies"), "committed-cookie");
    writeFileSync(join(jar, "Local State"), "committed-local-state");
    for (const name of ["pgrep", "timeout"]) {
      writeFileSync(join(binDir, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    }
    writeFileSync(join(binDir, "pkill"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(binDir, "su"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    let display = 0;
    for (const candidate of [8, 7, 6, 5, 4, 3, 2]) {
      if (!existsSync(`/tmp/.X${candidate}-lock`) && !existsSync(`/tmp/.X11-unix/X${candidate}`)) {
        display = candidate;
        break;
      }
    }
    assert.notEqual(display, 0, "no unused test display id was available");
    const env = {
      ...process.env,
      COOKIE_JAR: jar,
      OPENBOT_PINCHTAB_PORT_BASE: "29866",
      OPENBOT_SCREEN_HOME: home,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      VNC_USER: process.env.USER ?? "openbot",
    };
    try {
      const imported = spawnSync("bash", [displaySh, "cookies-in", "1"], { encoding: "utf8", env });
      assert.equal(imported.status, 0, imported.stderr);
      const committedSnapshot = currentCookieSnapshot(jar);
      const committedSnapshotState = privateTreeSnapshot(committedSnapshot);
      const stopped = spawnSync("bash", [displaySh, "stop", String(display)], {
        encoding: "utf8",
        env,
        timeout: 5_000,
      });
      assert.equal(stopped.signal, null, stopped.stdout + stopped.stderr);
      assert.equal(stopped.status, 1, stopped.stdout + stopped.stderr);
      assert.match(stopped.stderr, /invalidated.*import|failed to commit cookies/iu);
      assert.equal(currentCookieSnapshot(jar), committedSnapshot);
      assert.deepEqual(privateTreeSnapshot(committedSnapshot), committedSnapshotState);
      const committedBefore = committedCookieStoreSnapshot(jar);

      for (const attempt of [1, 2]) {
        const discarded = spawnSync("bash", [displaySh, "discard", String(display)], {
          encoding: "utf8",
          env,
          timeout: 5_000,
        });
        assert.equal(discarded.signal, null, `attempt ${attempt}: ${discarded.stdout}${discarded.stderr}`);
        assert.equal(discarded.status, 0, `attempt ${attempt}: ${discarded.stdout}${discarded.stderr}`);
        assert.deepEqual(committedCookieStoreSnapshot(jar), committedBefore, `attempt ${attempt} mutated committed cookies`);
        assert.equal(existsSync(join(home, ".config", `google-chrome-d${display}`)), false);
        assert.equal(existsSync(join(home, `.config-d${display}`)), false);
        assert.equal(existsSync(join(home, `.pinchtab-d${display}`)), false);
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("display discard serializes profile deletion behind the canonical cookie lock", async () => {
    const root = await tempDir("openbot-display-discard-cookie-lock-");
    const home = join(root, "home");
    const jar = join(root, "cookies");
    const binDir = join(root, "bin");
    const ownerScript = join(root, "cookie-lock-owner.sh");
    const ready = join(root, "owner-ready");
    const release = join(root, "owner-release");
    const cleanupLog = join(root, "cleanup.log");
    const display = 8;
    const profile = join(home, ".config", `google-chrome-d${display}`);
    const config = join(home, `.config-d${display}`);
    mkdirSync(join(jar, "Network"), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(jar, "Network", "Cookies"), "committed-cookie");
    const baseEnv = {
      ...process.env,
      COOKIE_JAR: jar,
      OPENBOT_PINCHTAB_PORT_BASE: "29866",
      OPENBOT_SCREEN_HOME: home,
      VNC_USER: process.env.USER ?? "openbot",
    };
    const imported = spawnSync("bash", [displaySh, "cookies-in", "1"], { encoding: "utf8", env: baseEnv });
    assert.equal(imported.status, 0, imported.stderr);
    mkdirSync(join(profile, "Default", "Network"), { recursive: true });
    mkdirSync(config, { recursive: true });
    writeFileSync(join(profile, "owned-profile"), "retain-until-lock-release");
    writeFileSync(join(config, "owned-config"), "retain-until-lock-release");
    const committedBefore = committedCookieStoreSnapshot(jar);
    const snapshot = currentCookieSnapshot(jar);
    const snapshotBefore = privateTreeSnapshot(snapshot);

    writeFileSync(
      ownerScript,
      `#!/bin/bash
set -euo pipefail
lock="$1"
ready="$2"
release="$3"
mkdir "$lock"
printf '%s\\n' "$$" > "$lock/pid"
if [ -r "/proc/$$/stat" ]; then
  awk '{print $22}' "/proc/$$/stat" > "$lock/start"
else
  ps -o lstart= -p "$$" | sed 's/^[[:space:]]*//' > "$lock/start"
fi
chmod 700 "$lock"
chmod 600 "$lock/pid" "$lock/start"
: > "$ready"
while [ ! -e "$release" ]; do sleep 0.02; done
rm -f -- "$lock/pid" "$lock/start"
rmdir "$lock"
`,
      { mode: 0o755 },
    );
    for (const [name, status] of [["pgrep", 1], ["pkill", 0], ["su", 0], ["timeout", 1]] as const) {
      writeFileSync(
        join(binDir, name),
        `#!/bin/sh
printf '%s\\n' '${name}' >> "$OPENBOT_DISCARD_CALL_LOG"
exit ${status}
`,
        { mode: 0o755 },
      );
    }

    const lock = join(jar, ".sync.lock");
    const owner = spawn("bash", [ownerScript, lock, ready, release], { stdio: "ignore" });
    const ownerPid = owner.pid;
    assert.ok(ownerPid, "cookie lock fixture did not spawn an owner process");
    const ownerDone = collectChild(owner);
    let discard: ReturnType<typeof spawn> | null = null;
    let discardDone: ReturnType<typeof collectChild> | null = null;
    try {
      await waitUntil(() => existsSync(ready) && existsSync(join(lock, "start")));
      assert.equal(readFileSync(join(lock, "pid"), "utf8").trim(), String(ownerPid));
      assert.equal(
        readFileSync(join(lock, "start"), "utf8").replace(/\r?\n$/u, ""),
        processStartId(ownerPid),
      );

      discard = spawn("bash", [displaySh, "discard", String(display)], {
        env: {
          ...baseEnv,
          OPENBOT_DISCARD_CALL_LOG: cleanupLog,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      discardDone = collectChild(discard);
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      assert.equal(discard.exitCode, null, "discard bypassed a live canonical cookie lock");
      assert.equal(existsSync(profile), true, "discard removed the profile while another operation owned the lock");
      assert.equal(existsSync(config), true, "discard removed display config while another operation owned the lock");
      assert.equal(existsSync(cleanupLog), false, "discard began cleanup before acquiring the cookie lock");
      assert.deepEqual(privateTreeSnapshot(snapshot), snapshotBefore, "waiting discard mutated committed cookies");

      writeFileSync(release, "release\n");
      const ownerResult = await ownerDone;
      assert.equal(ownerResult.status, 0, ownerResult.stdout + ownerResult.stderr);
      const discarded = await discardDone;
      assert.equal(discarded.signal, null, discarded.stdout + discarded.stderr);
      assert.equal(discarded.status, 0, discarded.stdout + discarded.stderr);
      assert.equal(existsSync(profile), false);
      assert.equal(existsSync(config), false);
      assert.deepEqual(committedCookieStoreSnapshot(jar), committedBefore);
    } finally {
      if (!existsSync(release)) writeFileSync(release, "release\n");
      if (processAlive(ownerPid)) owner.kill("SIGKILL");
      if (discard && processAlive(discard.pid)) discard.kill("SIGKILL");
      await Promise.allSettled([ownerDone, ...(discardDone ? [discardDone] : [])]);
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("display discard compensates start failures before and after cookie marker publication", async () => {
    for (const markerPublished of [false, true]) {
      const root = await tempDir(`openbot-display-discard-marker-${markerPublished ? "after" : "before"}-`);
      const home = join(root, "home");
      const jar = join(root, "cookies");
      const binDir = join(root, "bin");
      mkdirSync(join(jar, "Network"), { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(jar, "Network", "Cookies"), "committed-cookie");
      writeFileSync(join(jar, "Local State"), "committed-local-state");

      let display = 0;
      for (const candidate of [8, 7, 6, 5, 4, 3, 2]) {
        if (!existsSync(`/tmp/.X${candidate}-lock`) && !existsSync(`/tmp/.X11-unix/X${candidate}`)) {
          display = candidate;
          break;
        }
      }
      assert.notEqual(display, 0, "no unused test display id was available");
      const baseEnv = {
        ...process.env,
        COOKIE_JAR: jar,
        OPENBOT_SCREEN_HOME: home,
        VNC_USER: process.env.USER ?? "openbot",
      };
      try {
        const imported = spawnSync("bash", [displaySh, "cookies-in", "1"], {
          encoding: "utf8",
          env: baseEnv,
        });
        assert.equal(imported.status, 0, imported.stderr);
        const committedSnapshot = currentCookieSnapshot(jar);
        const committedSnapshotState = privateTreeSnapshot(committedSnapshot);

        writeFileSync(
          join(binDir, "cp"),
          `#!/bin/bash
src="\${1:-}"
for arg in "$@"; do dest="$arg"; done
if [ "\${OPENBOT_FAIL_SNAPSHOT_COPY:-}" = "1" ] && [[ "$src" == *"/snapshots/"* ]]; then
  exit 41
fi
if [ -d "$dest" ]; then dest="$dest/fixture"; fi
mkdir -p "$(dirname "$dest")"
: > "$dest"
`,
          { mode: 0o755 },
        );
        writeFileSync(join(binDir, "su"), "#!/bin/sh\nexit 55\n", { mode: 0o755 });
        writeFileSync(join(binDir, "pkill"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        for (const name of ["pgrep", "timeout"]) {
          writeFileSync(join(binDir, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
        }
        const env = {
          ...baseEnv,
          OPENBOT_FAIL_SNAPSHOT_COPY: markerPublished ? "0" : "1",
          OPENBOT_PINCHTAB_PORT_BASE: "29866",
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        };
        const started = spawnSync("bash", [displaySh, "start", String(display)], {
          encoding: "utf8",
          env,
          timeout: 5_000,
        });
        assert.equal(started.signal, null, started.stdout + started.stderr);
        assert.notEqual(started.status, 0, "controlled start failure unexpectedly succeeded");
        const profile = join(home, ".config", `google-chrome-d${display}`);
        const marker = join(profile, ".openbot-cookie-epoch");
        assert.equal(existsSync(profile), true, "start failure did not leave a partial profile to compensate");
        assert.equal(existsSync(marker), markerPublished, "fixture failed on the wrong marker side");
        writeFileSync(join(profile, "Default", "Network", "Cookies"), "unpublished-stale-cookie");
        assert.equal(currentCookieSnapshot(jar), committedSnapshot);
        assert.deepEqual(privateTreeSnapshot(committedSnapshot), committedSnapshotState);
        const jarBeforeDiscard = committedCookieStoreSnapshot(jar);

        const discarded = spawnSync("bash", [displaySh, "discard", String(display)], {
          encoding: "utf8",
          env,
          timeout: 5_000,
        });
        assert.equal(discarded.signal, null, discarded.stdout + discarded.stderr);
        assert.equal(discarded.status, 0, discarded.stdout + discarded.stderr);
        assert.deepEqual(committedCookieStoreSnapshot(jar), jarBeforeDiscard, "discard mutated committed cookie state");
        assert.equal(existsSync(profile), false, "discard retained a partial cookie profile");
        assert.equal(existsSync(join(home, `.config-d${display}`)), false, "discard retained partial XFCE state");
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    }
  });

  test("display discard refuses symlinked state and forged live ownership without touching foreign targets", async () => {
    const symlinkRoot = await tempDir("openbot-display-discard-symlink-");
    const symlinkHome = join(symlinkRoot, "home");
    const symlinkJar = join(symlinkRoot, "cookies");
    const symlinkOutside = join(symlinkRoot, "outside");
    const symlinkBin = join(symlinkRoot, "bin");
    const callLog = join(symlinkRoot, "calls.log");
    mkdirSync(join(symlinkJar, "Network"), { recursive: true });
    mkdirSync(symlinkOutside, { recursive: true });
    mkdirSync(symlinkBin, { recursive: true });
    writeFileSync(join(symlinkJar, "Network", "Cookies"), "committed-cookie");
    writeFileSync(join(symlinkOutside, "sentinel"), "foreign-state");
    const symlinkBaseEnv = {
      ...process.env,
      COOKIE_JAR: symlinkJar,
      OPENBOT_SCREEN_HOME: symlinkHome,
      VNC_USER: process.env.USER ?? "openbot",
    };
    try {
      const imported = spawnSync("bash", [displaySh, "cookies-in", "1"], {
        encoding: "utf8",
        env: symlinkBaseEnv,
      });
      assert.equal(imported.status, 0, imported.stderr);
      const jarBefore = committedCookieStoreSnapshot(symlinkJar);
      const display = 8;
      symlinkSync(symlinkOutside, join(symlinkHome, ".config", `google-chrome-d${display}`), "dir");
      for (const name of ["pgrep", "pkill", "su", "timeout"]) {
        writeFileSync(
          join(symlinkBin, name),
          `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$OPENBOT_DISCARD_CALL_LOG"\nexit 0\n`,
          { mode: 0o755 },
        );
      }
      const discarded = spawnSync("bash", [displaySh, "discard", String(display)], {
        encoding: "utf8",
        env: {
          ...symlinkBaseEnv,
          OPENBOT_DISCARD_CALL_LOG: callLog,
          PATH: `${symlinkBin}${delimiter}${process.env.PATH ?? ""}`,
        },
        timeout: 5_000,
      });
      assert.equal(discarded.signal, null, discarded.stdout + discarded.stderr);
      assert.equal(discarded.status, 1, discarded.stdout + discarded.stderr);
      assert.match(discarded.stderr, /real directory|symlink/iu);
      assert.equal(readFileSync(join(symlinkOutside, "sentinel"), "utf8"), "foreign-state");
      assert.deepEqual(committedCookieStoreSnapshot(symlinkJar), jarBefore);
      assert.equal(existsSync(callLog), false, "unsafe state reached a cleanup subprocess");
    } finally {
      rmSync(symlinkRoot, { force: true, recursive: true });
    }

    const ownerRoot = await tempDir("openbot-display-discard-foreign-owner-");
    const ownerHome = join(ownerRoot, "home");
    const ownerBin = join(ownerRoot, "bin");
    const display = 8;
    const ownerDir = join(ownerHome, `.pinchtab-d${display}`);
    const ownerPath = join(ownerDir, "bridge-owner.json");
    mkdirSync(ownerDir, { recursive: true });
    mkdirSync(ownerBin, { recursive: true });
    writeFileSync(join(ownerBin, "timeout"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const owner = {
      schema: 1,
      display,
      port: 29_866 + display,
      supervisorPid: process.pid,
      supervisorStart: processStartId(process.pid),
      childPid: process.pid,
      childStart: processStartId(process.pid),
      binary: "/foreign/pinchtab",
      config: join(ownerDir, "foreign-config.json"),
    };
    writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600 });
    try {
      const discarded = spawnSync("bash", [displaySh, "discard", String(display)], {
        encoding: "utf8",
        env: {
          ...process.env,
          COOKIE_JAR: join(ownerRoot, "cookies"),
          OPENBOT_PINCHTAB_BIN: "/expected/pinchtab",
          OPENBOT_PINCHTAB_PORT_BASE: "29866",
          OPENBOT_SCREEN_HOME: ownerHome,
          PATH: `${ownerBin}${delimiter}${process.env.PATH ?? ""}`,
          VNC_USER: process.env.USER ?? "openbot",
        },
        timeout: 5_000,
      });
      assert.equal(discarded.signal, null, discarded.stdout + discarded.stderr);
      assert.equal(discarded.status, 1, discarded.stdout + discarded.stderr);
      assert.match(discarded.stderr, /foreign live ownership/iu);
      assert.equal(processAlive(process.pid), true, "discard killed the forged owner target");
      assert.deepEqual(JSON.parse(readFileSync(ownerPath, "utf8")), owner);
    } finally {
      rmSync(ownerRoot, { force: true, recursive: true });
    }
  });

  test("display discard rejects incoherent X socket state before any cleanup", async (t) => {
    for (const fixture of ["non-socket", "unverified-socket"] as const) {
      await t.test(fixture, async () => {
        const root = await tempDir(`openbot-display-discard-x-${fixture}-`);
        const home = join(root, "home");
        const jar = join(root, "cookies");
        const binDir = join(root, "bin");
        const xRoot = await mkdtemp(join(tmpdir(), "ob93x-"));
        const xLockDir = join(xRoot, "l");
        const xSocketDir = join(xRoot, "s");
        const cleanupLog = join(root, "cleanup.log");
        const display = 8;
        const profile = join(home, ".config", `google-chrome-d${display}`);
        const config = join(home, `.config-d${display}`);
        const xLock = join(xLockDir, `.X${display}-lock`);
        const xSocket = join(xSocketDir, `X${display}`);
        mkdirSync(join(jar, "Network"), { recursive: true });
        mkdirSync(binDir, { recursive: true });
        mkdirSync(xLockDir, { recursive: true });
        mkdirSync(xSocketDir, { recursive: true });
        writeFileSync(join(jar, "Network", "Cookies"), "committed-cookie");
        const baseEnv = {
          ...process.env,
          COOKIE_JAR: jar,
          OPENBOT_PINCHTAB_PORT_BASE: "29866",
          OPENBOT_SCREEN_HOME: home,
          OPENBOT_X_LOCK_DIR: xLockDir,
          OPENBOT_X_SOCKET_DIR: xSocketDir,
          VNC_USER: process.env.USER ?? "openbot",
        };
        const imported = spawnSync("bash", [displaySh, "cookies-in", "1"], {
          encoding: "utf8",
          env: baseEnv,
        });
        assert.equal(imported.status, 0, imported.stderr);
        mkdirSync(profile, { recursive: true });
        mkdirSync(config, { recursive: true });
        writeFileSync(join(profile, "sentinel"), "owned-profile");
        writeFileSync(join(config, "sentinel"), "owned-config");
        for (const [name, status] of [["pgrep", 1], ["pkill", 0], ["su", 0], ["timeout", 1]] as const) {
          writeFileSync(
            join(binDir, name),
            `#!/bin/sh
printf '%s\\n' '${name}' >> "$OPENBOT_DISCARD_CALL_LOG"
exit ${status}
`,
            { mode: 0o755 },
          );
        }

        const xServer = net.createServer();
        if (fixture === "non-socket") {
          writeFileSync(xSocket, "foreign-non-socket");
        } else {
          writeFileSync(xLock, "not-a-pid\n", { mode: 0o600 });
          await new Promise<void>((resolveListen, rejectListen) => {
            xServer.once("error", rejectListen);
            xServer.listen(xSocket, () => resolveListen());
          });
        }
        const jarBefore = committedCookieStoreSnapshot(jar);
        const socketBytes = fixture === "non-socket" ? readFileSync(xSocket) : null;
        const lockBytes = fixture === "unverified-socket" ? readFileSync(xLock) : null;
        try {
          if (fixture === "unverified-socket") {
            const socketType = spawnSync("bash", ["-c", "[ -S \"$1\" ]", "_", xSocket], {
              encoding: "utf8",
            });
            assert.equal(socketType.status, 0, "fixture did not publish a real Unix socket");
          }
          const discarded = spawnSync("bash", [displaySh, "discard", String(display)], {
            encoding: "utf8",
            env: {
              ...baseEnv,
              OPENBOT_DISCARD_CALL_LOG: cleanupLog,
              PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
            },
            timeout: 5_000,
          });
          assert.equal(discarded.signal, null, discarded.stdout + discarded.stderr);
          assert.equal(
            discarded.status,
            1,
            JSON.stringify({ fixture, stdout: discarded.stdout, stderr: discarded.stderr }),
          );
          assert.match(discarded.stderr, /X socket|verified ownership|Unix socket/iu);
          assert.equal(existsSync(cleanupLog), false, "incoherent X state reached a cleanup subprocess");
          assert.equal(readFileSync(join(profile, "sentinel"), "utf8"), "owned-profile");
          assert.equal(readFileSync(join(config, "sentinel"), "utf8"), "owned-config");
          assert.deepEqual(committedCookieStoreSnapshot(jar), jarBefore);
          if (fixture === "non-socket") {
            assert.equal(lstatSync(xSocket).isFile(), true);
            assert.deepEqual(readFileSync(xSocket), socketBytes);
            assert.equal(existsSync(xLock), false);
          } else {
            assert.equal(lstatSync(xSocket).isSocket(), true);
            assert.deepEqual(readFileSync(xLock), lockBytes);
          }
        } finally {
          if (xServer.listening) {
            await new Promise<void>((resolveClose) => xServer.close(() => resolveClose()));
          }
          rmSync(root, { force: true, recursive: true });
          rmSync(xRoot, { force: true, recursive: true });
        }
      });
    }
  });

  test("display discard reports exact Chrome cleanup failure and retains recoverable partial state", async () => {
    const root = await tempDir("openbot-display-discard-chrome-failure-");
    const home = join(root, "home");
    const jar = join(root, "cookies");
    const binDir = join(root, "bin");
    const cleanupLog = join(root, "cleanup.log");
    mkdirSync(join(jar, "Network"), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(jar, "Network", "Cookies"), "committed-cookie");
    let display = 0;
    for (const candidate of [8, 7, 6, 5, 4, 3, 2]) {
      if (!existsSync(`/tmp/.X${candidate}-lock`) && !existsSync(`/tmp/.X11-unix/X${candidate}`)) {
        display = candidate;
        break;
      }
    }
    assert.notEqual(display, 0, "no unused test display id was available");
    const baseEnv = {
      ...process.env,
      COOKIE_JAR: jar,
      OPENBOT_SCREEN_HOME: home,
      VNC_USER: process.env.USER ?? "openbot",
    };
    try {
      const imported = spawnSync("bash", [displaySh, "cookies-in", String(display)], {
        encoding: "utf8",
        env: baseEnv,
      });
      assert.equal(imported.status, 0, imported.stderr);
      const profile = join(home, ".config", `google-chrome-d${display}`);
      const config = join(home, `.config-d${display}`);
      mkdirSync(config, { recursive: true });
      writeFileSync(join(config, "partial-state"), "retain-for-retry");
      const jarBefore = committedCookieStoreSnapshot(jar);

      writeFileSync(
        join(binDir, "pkill"),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$OPENBOT_DISCARD_CLEANUP_LOG"\nexit 0\n',
        { mode: 0o755 },
      );
      writeFileSync(join(binDir, "pgrep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(binDir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(binDir, "timeout"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const discarded = spawnSync("bash", [displaySh, "discard", String(display)], {
        encoding: "utf8",
        env: {
          ...baseEnv,
          OPENBOT_DISCARD_CLEANUP_LOG: cleanupLog,
          OPENBOT_PINCHTAB_PORT_BASE: "29866",
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
        timeout: 5_000,
      });
      assert.equal(discarded.signal, null, discarded.stdout + discarded.stderr);
      assert.equal(discarded.status, 1, discarded.stdout + discarded.stderr);
      assert.match(discarded.stderr, /Chrome still owns profile/iu);
      assert.match(readFileSync(cleanupLog, "utf8"), /-9/iu);
      assert.equal(existsSync(profile), true, "failed cleanup discarded the recoverable profile");
      assert.equal(readFileSync(join(config, "partial-state"), "utf8"), "retain-for-retry");
      assert.deepEqual(committedCookieStoreSnapshot(jar), jarBefore, "failed discard mutated committed cookies");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("display discard reaps exact owned runtime resources for a fully prepared unpublished display", async () => {
    const root = await tempDir("openbot-display-discard-prepared-");
    const home = join(root, "home");
    const jar = join(root, "cookies");
    const binDir = join(root, "bin");
    const xLockDir = join(root, "x-locks");
    const xSocketDir = join(root, "x-sockets");
    const display = 8;
    const profile = join(home, ".config", `google-chrome-d${display}`);
    const config = join(home, `.config-d${display}`);
    const ownerDir = join(home, `.pinchtab-d${display}`);
    const ownerPath = join(ownerDir, "bridge-owner.json");
    const xLock = join(xLockDir, `.X${display}-lock`);
    const xSocket = join(xSocketDir, `X${display}`);
    mkdirSync(join(jar, "Network"), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(xLockDir, { recursive: true });
    mkdirSync(xSocketDir, { recursive: true });
    writeFileSync(join(jar, "Network", "Cookies"), "committed-cookie");
    const baseEnv = {
      ...process.env,
      COOKIE_JAR: jar,
      OPENBOT_SCREEN_HOME: home,
      VNC_USER: process.env.USER ?? "openbot",
    };
    const imported = spawnSync("bash", [displaySh, "cookies-in", String(display)], {
      encoding: "utf8",
      env: baseEnv,
    });
    assert.equal(imported.status, 0, imported.stderr);
    mkdirSync(config, { recursive: true });
    mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(config, "prepared"), "unpublished");
    writeFileSync(join(ownerDir, "config.json"), "{}", { mode: 0o600 });

    const managerFile = join(root, "owner-manager.mjs");
    const pidsFile = join(root, "owner-pids.json");
    writeFileSync(
      managerFile,
      `import fs from "node:fs";
import { spawn } from "node:child_process";
const [pidsFile, profile, display] = process.argv.slice(2);
const idle = "setInterval(() => {}, 1000)";
const supervisor = spawn(process.execPath, ["-e", idle], { stdio: "ignore" });
const child = spawn(process.execPath, ["-e", idle], { stdio: "ignore" });
const chrome = spawn(process.execPath, ["-e", idle, "--user-data-dir=" + profile, "fixture"], { stdio: "ignore" });
const xOwner = spawn(process.execPath, ["-e", idle, "X", ":" + display], { stdio: "ignore" });
supervisor.once("close", () => { if (child.exitCode === null) child.kill("SIGTERM"); });
const pidsFilePending = pidsFile + ".pending";
fs.writeFileSync(pidsFilePending, JSON.stringify({
  supervisor: supervisor.pid,
  child: child.pid,
  chrome: chrome.pid,
  xOwner: xOwner.pid,
}));
fs.renameSync(pidsFilePending, pidsFile);
const all = [supervisor, child, chrome, xOwner];
process.on("SIGTERM", () => {
  for (const owned of all) if (owned.exitCode === null) owned.kill("SIGKILL");
  setTimeout(() => process.exit(0), 50);
});
setInterval(() => {}, 1000);
`,
      { mode: 0o600 },
    );
    const manager = spawn(process.execPath, [managerFile, pidsFile, profile, String(display)], { stdio: "ignore" });
    type OwnedProcesses = {
      supervisor: number;
      child: number;
      chrome: number;
      xOwner: number;
    };
    let owned: OwnedProcesses | null = null;
    const xServer = net.createServer();
    try {
      await waitUntil(() => existsSync(pidsFile));
      const currentOwned = JSON.parse(readFileSync(pidsFile, "utf8")) as OwnedProcesses;
      owned = currentOwned;
      await new Promise<void>((resolveListen, rejectListen) => {
        xServer.once("error", rejectListen);
        xServer.listen(xSocket, () => resolveListen());
      });
      await waitUntil(
        () =>
          processAlive(currentOwned.supervisor) && processAlive(currentOwned.child)
          && processAlive(currentOwned.chrome) && processAlive(currentOwned.xOwner)
          && processStartId(currentOwned.supervisor).length > 0
          && processStartId(currentOwned.child).length > 0,
      );
      assert.match(processCommand(currentOwned.xOwner), new RegExp(`(?:^|\\s)X\\s+:${display}(?:\\s|$)`, "u"));
      writeFileSync(xLock, `${currentOwned.xOwner}\n`, { mode: 0o600 });
      const owner = {
        schema: 1,
        display,
        port: 29_866 + display,
        supervisorPid: currentOwned.supervisor,
        supervisorStart: processStartId(currentOwned.supervisor),
        childPid: currentOwned.child,
        childStart: processStartId(currentOwned.child),
        binary: "/fixture/pinchtab",
        config: join(ownerDir, "config.json"),
      };
      writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600 });
      writeFileSync(join(binDir, "timeout"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      writeFileSync(
        join(binDir, "su"),
        `#!/bin/bash
pid="$(awk 'NR == 1 { print $1 }' "$OPENBOT_TEST_X_LOCK")"
kill "$pid" || exit 61
rm -f -- "$OPENBOT_TEST_X_LOCK" "$OPENBOT_TEST_X_SOCKET"
`,
        { mode: 0o755 },
      );
      const env = {
        ...baseEnv,
        OPENBOT_PINCHTAB_BIN: "/fixture/pinchtab",
        OPENBOT_PINCHTAB_PORT_BASE: "29866",
        OPENBOT_TEST_X_LOCK: xLock,
        OPENBOT_TEST_X_SOCKET: xSocket,
        OPENBOT_X_LOCK_DIR: xLockDir,
        OPENBOT_X_SOCKET_DIR: xSocketDir,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      };
      const jarBefore = committedCookieStoreSnapshot(jar);
      const discarded = spawnSync("bash", [displaySh, "discard", String(display)], {
        encoding: "utf8",
        env,
        timeout: 10_000,
      });
      assert.equal(discarded.signal, null, discarded.stdout + discarded.stderr);
      assert.equal(discarded.status, 0, discarded.stdout + discarded.stderr);
      await waitUntil(
        () =>
          !processAlive(currentOwned.supervisor) && !processAlive(currentOwned.child)
          && !processAlive(currentOwned.chrome),
      );
      assert.equal(processAlive(currentOwned.xOwner), false, "discard left the exact owned X process alive");
      assert.equal(existsSync(profile), false);
      assert.equal(existsSync(config), false);
      assert.equal(existsSync(ownerDir), false);
      assert.equal(existsSync(xLock), false);
      assert.equal(existsSync(xSocket), false);
      assert.deepEqual(committedCookieStoreSnapshot(jar), jarBefore);

      const repeated = spawnSync("bash", [displaySh, "discard", String(display)], {
        encoding: "utf8",
        env,
        timeout: 5_000,
      });
      assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
      assert.deepEqual(committedCookieStoreSnapshot(jar), jarBefore);
    } finally {
      if (owned) {
        for (const processId of [owned.supervisor, owned.child, owned.chrome, owned.xOwner]) {
          if (processAlive(processId)) process.kill(processId, "SIGKILL");
        }
      }
      if (processAlive(manager.pid)) manager.kill("SIGTERM");
      if (manager.exitCode === null && manager.signalCode === null) {
        await new Promise<void>((resolveManager) => manager.once("close", () => resolveManager()));
      }
      if (xServer.listening) {
        await new Promise<void>((resolveClose) => xServer.close(() => resolveClose()));
      }
      rmSync(xLock, { force: true });
      rmSync(xSocket, { force: true });
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("display stop retains owner state when final exact identities remain live", async () => {
    const root = await tempDir("openbot-pt-stop-owned-failure-");
    const home = join(root, "home");
    const binDir = join(root, "bin");
    const ownerDir = join(home, ".pinchtab-d1");
    const ownerPath = join(ownerDir, "bridge-owner.json");
    const bashEnv = join(root, "bash-env");
    const killLog = join(root, "kill.log");
    mkdirSync(ownerDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(binDir, "pgrep"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(join(binDir, "pkill"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(binDir, "curl"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    writeFileSync(
      bashEnv,
      `kill() {
  if [ "\${1:-}" = "-0" ]; then
    builtin kill "$@"
    return
  fi
  printf '%s\\n' "$*" >> "$OPENBOT_KILL_LOG"
  return 0
}
`,
    );

    const stubbornCode = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
    const supervisor = spawn(process.execPath, ["-e", stubbornCode], { stdio: "ignore" });
    const child = spawn(process.execPath, ["-e", stubbornCode], { stdio: "ignore" });
    const supervisorPid = supervisor.pid ?? 0;
    const childPid = child.pid ?? 0;
    await waitUntil(
      () =>
        processAlive(supervisorPid) &&
        processAlive(childPid) &&
        processStartId(supervisorPid) !== "" &&
        processStartId(childPid) !== "",
    );
    const owner = {
      schema: 1,
      display: 1,
      port: 19_867,
      supervisorPid,
      supervisorStart: processStartId(supervisorPid),
      childPid,
      childStart: processStartId(childPid),
      binary: "/fixture/pinchtab",
      config: join(ownerDir, "config.json"),
    };
    writeFileSync(ownerPath, JSON.stringify(owner));

    try {
      const result = spawnSync("bash", [displaySh, "stop", "1"], {
        encoding: "utf8",
        env: {
          ...process.env,
          BASH_ENV: bashEnv,
          COOKIE_JAR: join(root, "cookies"),
          OPENBOT_KILL_LOG: killLog,
          OPENBOT_PINCHTAB_PORT_BASE: "19866",
          OPENBOT_SCREEN_HOME: home,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          VNC_USER: process.env.USER ?? "openbot",
        },
        timeout: 4_000,
      });

      assert.equal(result.signal, null, result.stdout + result.stderr);
      assert.equal(
        result.status,
        1,
        `${result.stdout}${result.stderr}\nowner=${existsSync(ownerPath)} killLog=${
          existsSync(killLog) ? readFileSync(killLog, "utf8") : "<missing>"
        }`,
      );
      assert.match(result.stderr, /cleanup.*incomplete|owner.*retain|surviv/iu);
      assert.equal(existsSync(ownerPath), true, "failed cleanup discarded PinchTab ownership");
      assert.deepEqual(JSON.parse(readFileSync(ownerPath, "utf8")), owner);
      assert.equal(processAlive(supervisorPid), true, "fixture supervisor unexpectedly exited");
      assert.equal(processAlive(childPid), true, "fixture child unexpectedly exited");
      assert.match(readFileSync(killLog, "utf8"), /-9/u);
    } finally {
      if (processAlive(supervisorPid)) process.kill(supervisorPid, "SIGKILL");
      if (processAlive(childPid)) process.kill(childPid, "SIGKILL");
      await Promise.all([
        new Promise<void>((resolve) => supervisor.once("close", () => resolve())),
        new Promise<void>((resolve) => child.once("close", () => resolve())),
      ]);
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("display stop preserves the prior cookie generation when Chrome survives final KILL", async () => {
    const root = await tempDir("openbot-display-stop-chrome-live-");
    const home = join(root, "home");
    const jar = join(root, "cookies");
    const binDir = join(root, "bin");
    const killLog = join(root, "pkill.log");
    const profileCookies = join(home, ".config", "google-chrome", "Default");
    mkdirSync(profileCookies, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(jar, "Network"), { recursive: true });
    writeFileSync(join(jar, "Network", "Cookies"), "recoverable-prior");
    writeFileSync(
      join(binDir, "pkill"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$OPENBOT_CHROME_KILL_LOG"\nexit 0\n',
      { mode: 0o755 },
    );
    writeFileSync(join(binDir, "pgrep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(binDir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(binDir, "curl"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });

    const env = {
      ...process.env,
      COOKIE_JAR: jar,
      OPENBOT_CHROME_KILL_LOG: killLog,
      OPENBOT_PINCHTAB_PORT_BASE: "29866",
      OPENBOT_SCREEN_HOME: home,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      VNC_USER: process.env.USER ?? "openbot",
    };
    try {
      const imported = spawnSync("bash", [displaySh, "cookies-in", "1"], { encoding: "utf8", env });
      assert.equal(imported.status, 0, imported.stderr);
      const prior = currentCookieSnapshot(jar);
      writeFileSync(join(profileCookies, "Cookies"), "chrome-cleanup-cookie");
      const result = spawnSync("bash", [displaySh, "stop", "1"], {
        encoding: "utf8",
        env,
        timeout: 3_000,
      });

      assert.equal(result.signal, null, result.stdout + result.stderr);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /Chrome.*(?:profile|remain|failed to stop)/iu);
      assert.match(result.stderr, /cookie export not committed.*prior generation .* preserved/iu);
      assert.doesNotMatch(result.stdout, /cookie export committed generation/u);
      assert.match(readFileSync(killLog, "utf8"), /-9/u);
      assert.equal(currentCookieSnapshot(jar), prior, "unsafe profile data replaced the recoverable prior jar");
      assert.equal(readFileSync(join(prior, "Network", "Cookies"), "utf8"), "recoverable-prior");
      assert.equal(modeOf(prior), 0o700);
      assert.equal(modeOf(join(prior, "manifest")), 0o600);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

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
      const imported = spawnSync("bash", [displaySh, "cookies-in", "1"], { encoding: "utf8", env });
      assert.equal(imported.status, 0, imported.stderr);
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
        .filter((line) => line.includes("<authorization>"));
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
      const imported = spawnSync("bash", [displaySh, "cookies-in", "1"], { encoding: "utf8", env });
      assert.equal(imported.status, 0, imported.stderr);
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

  test("owner publication timeout terminates the exact provisional supervisor", async () => {
    const root = await tempDir("openbot-pt-provisional-supervisor-");
    const home = join(root, "home");
    const binDir = join(root, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const pinchtab = await writeSupervisedBridgeFixture(binDir);
    const setsid = await writeSetsidFixture(binDir);
    await writeOwnerStallingJqFixture(binDir);
    const port = await unusedLoopbackPort();
    const ownerPath = join(home, ".pinchtab-d1", "bridge-owner.json");
    const setsidLog = join(root, "setsid.log");
    const bridgePidLog = join(root, "bridge.pid");
    const env = {
      ...process.env,
      CHROME_USER_DATA_DIR: join(root, "profile"),
      COOKIE_JAR: join(root, "cookies"),
      OPENBOT_BRIDGE_PID_LOG: bridgePidLog,
      OPENBOT_CDP_PORT_BASE: String(port + 100),
      OPENBOT_OWNER_STALL_SEC: "10",
      OPENBOT_PINCHTAB_BIN: pinchtab,
      OPENBOT_PINCHTAB_PORT_BASE: String(port - 1),
      OPENBOT_PINCHTAB_START_TIMEOUT_SEC: "3",
      OPENBOT_SCREEN_HOME: home,
      OPENBOT_SETSID_BIN: setsid,
      OPENBOT_SETSID_LOG: setsidLog,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      PINCHTAB_TOKEN: "provisional-token",
      VNC_USER: process.env.USER ?? "openbot",
    };
    let provisionalPid = 0;
    let bridgePid = 0;
    try {
      const started = Date.now();
      const result = spawnSync("bash", [displaySh, "pinchtab", "1"], {
        encoding: "utf8",
        env,
        timeout: 9_000,
      });
      assert.ok(Date.now() - started < 6_500, `publication cleanup exceeded its startup bound: ${Date.now() - started}ms`);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /supervisor did not publish owner/i);
      assert.equal(existsSync(ownerPath), false);
      assert.equal(existsSync(setsidLog), true, "provisional supervisor did not launch");
      assert.equal(existsSync(bridgePidLog), true, "provisional bridge child did not launch");
      provisionalPid = Number(readFileSync(setsidLog, "utf8").trim().split("\n")[0]);
      bridgePid = Number(readFileSync(bridgePidLog, "utf8").trim());
      assert.equal(Number.isInteger(provisionalPid) && provisionalPid > 0, true, setsidLog);
      assert.equal(Number.isInteger(bridgePid) && bridgePid > 0, true, bridgePidLog);
      assert.equal(processAlive(provisionalPid), false, `provisional supervisor ${provisionalPid} survived timeout`);
      assert.equal(processAlive(bridgePid), false, `provisional bridge child ${bridgePid} survived timeout`);
      const survivors = spawnSync("ps", ["-axo", "pid=,args="], { encoding: "utf8" }).stdout
        .split("\n")
        .filter((line) => line.includes(root));
      assert.deepEqual(survivors, [], survivors.join("\n"));
    } finally {
      if (processAlive(provisionalPid)) process.kill(provisionalPid, "SIGKILL");
      if (processAlive(bridgePid)) process.kill(bridgePid, "SIGKILL");
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("owner publication timeout terminates a surviving provisional process group", async () => {
    const root = await tempDir("openbot-pt-provisional-group-");
    const home = join(root, "home");
    const binDir = join(root, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const pinchtab = await writeSupervisedBridgeFixture(binDir);
    const setsid = await writeSetsidFixture(binDir);
    const port = await unusedLoopbackPort();
    const setsidLog = join(root, "setsid.log");
    const descendantLog = join(root, "descendant.pid");
    const env = {
      ...process.env,
      CHROME_USER_DATA_DIR: join(root, "profile"),
      COOKIE_JAR: join(root, "cookies"),
      OPENBOT_CDP_PORT_BASE: String(port + 100),
      OPENBOT_PINCHTAB_BIN: pinchtab,
      OPENBOT_PINCHTAB_PORT_BASE: String(port - 1),
      OPENBOT_PINCHTAB_START_TIMEOUT_SEC: "1",
      OPENBOT_SCREEN_HOME: home,
      OPENBOT_SETSID_BIN: setsid,
      OPENBOT_SETSID_DESCENDANT_LOG: descendantLog,
      OPENBOT_SETSID_LOG: setsidLog,
      OPENBOT_SETSID_ORPHAN_CHILD: "1",
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      PINCHTAB_TOKEN: "provisional-token",
      VNC_USER: process.env.USER ?? "openbot",
    };
    let leaderPid = 0;
    let descendantPid = 0;
    try {
      const result = spawnSync("bash", [displaySh, "pinchtab", "1"], {
        encoding: "utf8",
        env,
        timeout: 9_000,
      });
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /supervisor did not publish owner/i);
      leaderPid = Number(readFileSync(setsidLog, "utf8").trim().split("\n")[0]);
      descendantPid = Number(readFileSync(descendantLog, "utf8").trim());
      assert.equal(processAlive(leaderPid), false, `provisional group leader ${leaderPid} survived timeout`);
      assert.equal(processAlive(descendantPid), false, `provisional descendant ${descendantPid} survived timeout`);
    } finally {
      if (processAlive(leaderPid)) process.kill(leaderPid, "SIGKILL");
      if (processAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
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
    mkdirSync(join(jar, "Network"), { recursive: true });
    writeFileSync(join(jar, "Network", "Cookies"), "prior-cookie");
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
    const env = {
      ...process.env,
      COOKIE_JAR: jar,
      OPENBOT_CLEANUP_LOG: cleanupLog,
      OPENBOT_PINCHTAB_PORT_BASE: String(foreign.port - display),
      OPENBOT_SCREEN_HOME: home,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      VNC_USER: process.env.USER ?? "openbot",
    };
    try {
      const imported = spawnSync("bash", [displaySh, "cookies-in", String(display)], { encoding: "utf8", env });
      assert.equal(imported.status, 0, imported.stderr);
      writeFileSync(join(profile, "Cookies"), "cleanup-cookie");
      const result = spawnSync("bash", [displaySh, "stop", String(display)], {
        encoding: "utf8",
        env,
        timeout: 10_000,
      });

      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /port.*occupied|unowned|foreign|refusing to kill/i);
      assert.match(result.stdout, /cookie export committed generation/u);
      assert.equal(readFileSync(join(currentCookieSnapshot(jar), "Network", "Cookies"), "utf8"), "cleanup-cookie");
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
      OPENBOT_PINCHTAB_START_TIMEOUT_SEC: "3",
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
        /startup=3s.*connect=1s.*header\/total=3s.*body-inactivity=2s/u,
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

  test("display CLI does not trust a foreign live PID in an incoherent X lock", async () => {
    const root = await tempDir("openbot-foreign-x-lock-");
    const home = join(root, "home");
    const binDir = join(root, "bin");
    const marker = join(root, "su-called");
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "cp"),
      '#!/bin/bash\nfor arg in "$@"; do dest="$arg"; done\nif [ -d "$dest" ]; then dest="$dest/fixture"; fi\nmkdir -p "$(dirname "$dest")"\n: > "$dest"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(binDir, "su"),
      '#!/bin/sh\nprintf "%s\\n" "$*" > "$OPENBOT_SU_MARKER"\n',
      { mode: 0o755 },
    );

    let display = 0;
    let lock = "";
    for (const candidate of [8, 7, 6, 5, 4, 3, 2]) {
      const candidateLock = `/tmp/.X${candidate}-lock`;
      const candidateSocket = `/tmp/.X11-unix/X${candidate}`;
      if (existsSync(candidateLock) || existsSync(candidateSocket)) continue;
      try {
        writeFileSync(candidateLock, `${process.pid}\n`, { flag: "wx" });
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
          PINCHTAB_TOKEN: "",
          VNC_USER: process.env.USER ?? "openbot",
        },
        timeout: 10_000,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /stale|mismatch|foreign|incoherent/iu);
      assert.equal(existsSync(marker), true, `foreign lock returned early: ${result.stdout}${result.stderr}`);
      assert.equal(processAlive(process.pid), true, "foreign lock owner was killed");
      assert.equal(existsSync(lock), false, "foreign lock state was retained after safe relaunch");
    } finally {
      rmSync(lock, { force: true });
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("Computer cookie jar copy", () => {
  test("legacy state becomes one private committed snapshot and the last export wins", async () => {
    const root = await tempDir("openbot-cookie-snapshot-");
    const home = join(root, "home");
    const jar = join(root, "cookies");
    const profile = join(home, ".config", "google-chrome");
    mkdirSync(join(profile, "Default", "Network"), { recursive: true, mode: 0o777 });
    mkdirSync(join(jar, "Network"), { recursive: true, mode: 0o777 });
    writeFileSync(join(jar, "Network", "Cookies"), "legacy-network", { mode: 0o666 });
    writeFileSync(join(jar, "Local State"), "legacy-local-state", { mode: 0o666 });
    const env = {
      ...process.env,
      COOKIE_JAR: jar,
      OPENBOT_SCREEN_HOME: home,
      VNC_USER: process.env.USER ?? "openbot",
    };
    try {
      const imported = spawnSync("bash", [displaySh, "cookies-in", "1"], { encoding: "utf8", env });
      assert.equal(imported.status, 0, imported.stderr);
      assert.equal(existsSync(join(jar, "current")), true, "cookie store has no committed pointer");
      const initial = currentCookieSnapshot(jar);
      assert.equal(readFileSync(join(profile, "Default", "Network", "Cookies"), "utf8"), "legacy-network");
      assert.equal(readFileSync(join(profile, "Local State"), "utf8"), "legacy-local-state");
      assert.equal(modeOf(profile), 0o700);
      assert.equal(modeOf(join(profile, "Default")), 0o700);
      assert.equal(modeOf(join(profile, "Default", "Network")), 0o700);
      assert.equal(modeOf(join(profile, "Default", "Network", "Cookies")), 0o600);
      assert.equal(modeOf(join(profile, "Local State")), 0o600);
      assert.equal(modeOf(join(profile, ".openbot-cookie-epoch")), 0o600);
      assert.equal(modeOf(jar), 0o700);
      assert.equal(modeOf(join(jar, "snapshots")), 0o700);
      assert.equal(modeOf(initial), 0o700);
      assert.equal(modeOf(join(initial, "manifest")), 0o600);
      assert.equal(modeOf(join(initial, "Network", "Cookies")), 0o600);
      assert.equal(modeOf(join(initial, "Local State")), 0o600);
      assert.equal(existsSync(join(jar, "Network", "Cookies")), false, "legacy root remained authoritative");

      writeFileSync(join(profile, "Default", "Network", "Cookies"), "latest-network");
      writeFileSync(join(profile, "Local State"), "latest-local-state");
      const exported = spawnSync("bash", [displaySh, "cookies-out", "1"], { encoding: "utf8", env });
      assert.equal(exported.status, 0, exported.stderr);
      assert.match(exported.stdout, /cookie export committed generation/u);
      const latest = currentCookieSnapshot(jar);
      assert.notEqual(latest, initial, "export did not publish a new generation");
      assert.equal(readFileSync(join(latest, "Network", "Cookies"), "utf8"), "latest-network");
      assert.equal(readFileSync(join(latest, "Local State"), "utf8"), "latest-local-state");
      assert.equal(modeOf(latest), 0o700);
      assert.equal(modeOf(join(latest, "manifest")), 0o600);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("clear publishes a new epoch and stale profiles cannot resurrect the prior jar", async () => {
    const root = await tempDir("openbot-cookie-clear-");
    const home = join(root, "home");
    const jar = join(root, "cookies");
    const profile1 = join(home, ".config", "google-chrome");
    const profile2 = join(home, ".config", "google-chrome-d2");
    mkdirSync(join(jar, "Network"), { recursive: true });
    writeFileSync(join(jar, "Network", "Cookies"), "clear-source");
    writeFileSync(join(jar, "Local State"), "clear-local-state");
    const env = {
      ...process.env,
      COOKIE_JAR: jar,
      OPENBOT_SCREEN_HOME: home,
      VNC_USER: process.env.USER ?? "openbot",
    };
    try {
      for (const display of ["1", "2"]) {
        const imported = spawnSync("bash", [displaySh, "cookies-in", display], { encoding: "utf8", env });
        assert.equal(imported.status, 0, imported.stderr);
      }
      const prior = currentCookieSnapshot(jar);
      const priorEpoch = Number(cookieManifest(prior).epoch);
      writeFileSync(join(profile1, "Default", "Network", "Cookies"), "stale-one");
      writeFileSync(join(profile2, "Default", "Network", "Cookies"), "stale-two");

      const cleared = spawnSync("bash", [displaySh, "cookies-clear", "1"], { encoding: "utf8", env });
      assert.equal(cleared.status, 0, cleared.stderr);
      assert.match(cleared.stdout, /cookie clear committed generation/u);
      const empty = currentCookieSnapshot(jar);
      const emptyManifest = cookieManifest(empty);
      assert.notEqual(empty, prior, "clear did not publish a new generation");
      assert.equal(Number(emptyManifest.epoch), priorEpoch + 1);
      assert.equal(emptyManifest.state, "committed");
      assert.equal(modeOf(empty), 0o700);
      assert.equal(modeOf(join(empty, "manifest")), 0o600);
      assert.equal(existsSync(join(empty, "Network", "Cookies")), false);
      assert.equal(existsSync(prior), false, "clear retained an obsolete snapshot");
      assert.equal(existsSync(join(jar, "previous")), false, "clear retained a recovery pointer");
      for (const profile of [profile1, profile2]) {
        assert.equal(existsSync(join(profile, "Default", "Network", "Cookies")), false);
        assert.equal(existsSync(join(profile, "Local State")), false);
        assert.equal(existsSync(join(profile, ".openbot-cookie-epoch")), false);
      }

      mkdirSync(join(profile2, "Default", "Network"), { recursive: true });
      writeFileSync(join(profile2, "Default", "Network", "Cookies"), "stale-resurrection");
      writeFileSync(join(profile2, ".openbot-cookie-epoch"), `${priorEpoch}\n`);
      const resurrect = spawnSync("bash", [displaySh, "cookies-out", "2"], { encoding: "utf8", env });
      assert.equal(resurrect.status, 1, resurrect.stdout + resurrect.stderr);
      assert.match(resurrect.stderr, /invalidated.*import/iu);
      assert.equal(currentCookieSnapshot(jar), empty, "stale profile replaced the clear generation");
      assert.equal(existsSync(join(empty, "Network", "Cookies")), false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("invalid committed metadata fails closed without deleting the recoverable snapshot", async () => {
    const root = await tempDir("openbot-cookie-invalid-current-");
    const home = join(root, "home");
    const jar = join(root, "cookies");
    mkdirSync(join(jar, "Network"), { recursive: true });
    writeFileSync(join(jar, "Network", "Cookies"), "recoverable-invalid");
    const env = {
      ...process.env,
      COOKIE_JAR: jar,
      OPENBOT_SCREEN_HOME: home,
      VNC_USER: process.env.USER ?? "openbot",
    };
    try {
      const imported = spawnSync("bash", [displaySh, "cookies-in", "1"], { encoding: "utf8", env });
      assert.equal(imported.status, 0, imported.stderr);
      const snapshot = currentCookieSnapshot(jar);
      const manifest = join(snapshot, "manifest");
      chmodSync(manifest, 0o644);

      const rejected = spawnSync("bash", [displaySh, "cookies-in", "2"], { encoding: "utf8", env });
      assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
      assert.match(rejected.stderr, /committed cookie snapshot is invalid/iu);
      assert.equal(currentCookieSnapshot(jar), snapshot);
      assert.equal(existsSync(manifest), true);
      assert.equal(readFileSync(join(snapshot, "Network", "Cookies"), "utf8"), "recoverable-invalid");

      chmodSync(manifest, 0o600);
      const recovered = spawnSync("bash", [displaySh, "cookies-in", "2"], { encoding: "utf8", env });
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.equal(currentCookieSnapshot(jar), snapshot);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("cookie synchronization rejects symlinked state roots without touching their targets", async () => {
    const root = await tempDir("openbot-cookie-root-symlink-");
    const home = join(root, "home");
    const jar = join(root, "cookies");
    const outside = join(root, "outside");
    mkdirSync(jar, { recursive: true });
    mkdirSync(outside, { recursive: true, mode: 0o777 });
    chmodSync(outside, 0o777);
    symlinkSync(outside, join(jar, "snapshots"), "dir");
    try {
      const result = spawnSync("bash", [displaySh, "cookies-in", "1"], {
        encoding: "utf8",
        env: {
          ...process.env,
          COOKIE_JAR: jar,
          OPENBOT_SCREEN_HOME: home,
          VNC_USER: process.env.USER ?? "openbot",
        },
      });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /private directory must not be a symlink/iu);
      assert.equal(modeOf(outside), 0o777, "symlink target permissions changed");
      assert.deepEqual(readdirSync(outside), [], "symlink target was used as cookie state");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("stale lock recovery unlinks a lock symlink without traversing its target", async () => {
    const root = await tempDir("openbot-cookie-lock-symlink-");
    const home = join(root, "home");
    const jar = join(root, "cookies");
    const outside = join(root, "outside-lock");
    mkdirSync(join(jar, "Network"), { recursive: true });
    writeFileSync(join(jar, "Network", "Cookies"), "lock-symlink-source");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "pid"), "outside-pid");
    writeFileSync(join(outside, "start"), "outside-start");
    const env = {
      ...process.env,
      COOKIE_JAR: jar,
      OPENBOT_SCREEN_HOME: home,
      VNC_USER: process.env.USER ?? "openbot",
    };
    try {
      const imported = spawnSync("bash", [displaySh, "cookies-in", "1"], { encoding: "utf8", env });
      assert.equal(imported.status, 0, imported.stderr);
      symlinkSync(outside, join(jar, ".sync.lock"), "dir");

      const recovered = spawnSync("bash", [displaySh, "cookies-in", "2"], {
        encoding: "utf8",
        env,
        timeout: 5_000,
      });
      assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
      assert.match(recovered.stderr, /removing stale cookie synchronization lock/iu);
      assert.equal(readFileSync(join(outside, "pid"), "utf8"), "outside-pid");
      assert.equal(readFileSync(join(outside, "start"), "utf8"), "outside-start");
      assert.equal(existsSync(join(jar, ".sync.lock")), false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("clear invalidates the jar without traversing a symlinked stale profile", async () => {
    const root = await tempDir("openbot-cookie-profile-symlink-");
    const home = join(root, "home");
    const jar = join(root, "cookies");
    const outside = join(root, "outside-profile");
    mkdirSync(join(jar, "Network"), { recursive: true });
    writeFileSync(join(jar, "Network", "Cookies"), "profile-symlink-source");
    mkdirSync(join(home, ".config"), { recursive: true });
    mkdirSync(join(outside, "Default", "Network"), { recursive: true });
    writeFileSync(join(outside, "Default", "Network", "Cookies"), "outside-sentinel");
    const env = {
      ...process.env,
      COOKIE_JAR: jar,
      OPENBOT_SCREEN_HOME: home,
      VNC_USER: process.env.USER ?? "openbot",
    };
    try {
      const imported = spawnSync("bash", [displaySh, "cookies-in", "1"], { encoding: "utf8", env });
      assert.equal(imported.status, 0, imported.stderr);
      symlinkSync(outside, join(home, ".config", "google-chrome-d2"), "dir");

      const cleared = spawnSync("bash", [displaySh, "cookies-clear", "1"], { encoding: "utf8", env });
      assert.equal(cleared.status, 1, cleared.stdout + cleared.stderr);
      assert.match(cleared.stderr, /cookie profile path must be a real directory/iu);
      assert.doesNotMatch(cleared.stdout, /cookie clear committed generation/u);
      assert.equal(
        readFileSync(join(outside, "Default", "Network", "Cookies"), "utf8"),
        "outside-sentinel",
      );
      const snapshot = currentCookieSnapshot(jar);
      assert.equal(existsSync(join(snapshot, "Network", "Cookies")), false);
      assert.equal(cookieManifest(snapshot).state, "committed");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("concurrent exports serialize so the last requested writer commits last", async () => {
    const root = await tempDir("openbot-cookie-concurrent-");
    const home = join(root, "home");
    const jar = join(root, "cookies");
    const binDir = join(root, "bin");
    const held = join(root, "cp-held");
    const release = join(root, "cp-release");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(jar, "Network"), { recursive: true });
    writeFileSync(join(jar, "Network", "Cookies"), "concurrent-source");
    const cp = await writeBlockingCpFixture(binDir);
    const env = {
      ...process.env,
      COOKIE_JAR: jar,
      OPENBOT_CP_HELD_FILE: held,
      OPENBOT_CP_HOLD_MATCH: "google-chrome/Default/Network/Cookies",
      OPENBOT_CP_RELEASE_FILE: release,
      OPENBOT_REAL_CP: cp.real,
      OPENBOT_SCREEN_HOME: home,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      VNC_USER: process.env.USER ?? "openbot",
    };
    let first: ReturnType<typeof spawn> | undefined;
    let second: ReturnType<typeof spawn> | undefined;
    try {
      for (const display of ["1", "2"]) {
        const imported = spawnSync("bash", [displaySh, "cookies-in", display], { encoding: "utf8", env });
        assert.equal(imported.status, 0, imported.stderr);
      }
      const profile1 = join(home, ".config", "google-chrome", "Default", "Network", "Cookies");
      const profile2 = join(home, ".config", "google-chrome-d2", "Default", "Network", "Cookies");
      writeFileSync(profile1, "writer-one");
      writeFileSync(profile2, "writer-two");
      const initial = currentCookieSnapshot(jar);

      first = spawn("bash", [displaySh, "cookies-out", "1"], { env, stdio: ["ignore", "pipe", "pipe"] });
      const firstResult = collectChild(first);
      await waitUntil(() => existsSync(held), 4_000);
      assert.equal(currentCookieSnapshot(jar), initial, "partial first export became authoritative");
      assert.equal(modeOf(join(jar, ".sync.lock")), 0o700);
      assert.equal(modeOf(join(jar, ".sync.lock", "pid")), 0o600);
      assert.equal(modeOf(join(jar, ".sync.lock", "start")), 0o600);

      second = spawn("bash", [displaySh, "cookies-out", "2"], { env, stdio: ["ignore", "pipe", "pipe"] });
      let secondClosed = false;
      second.once("close", () => (secondClosed = true));
      const secondResult = collectChild(second);
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(secondClosed, false, "second writer bypassed the shared synchronization lock");
        assert.equal(currentCookieSnapshot(jar), initial, "a waiting writer changed the committed pointer");
      } finally {
        writeFileSync(release, "release");
      }

      const [one, two] = await Promise.all([firstResult, secondResult]);
      assert.equal(one.status, 0, one.stderr);
      assert.equal(two.status, 0, two.stderr);
      assert.match(one.stdout, /cookie export committed generation/u);
      assert.match(two.stdout, /cookie export committed generation/u);
      const final = currentCookieSnapshot(jar);
      assert.equal(readFileSync(join(final, "Network", "Cookies"), "utf8"), "writer-two");
      assert.equal(modeOf(final), 0o700);
      assert.equal(modeOf(join(final, "Network", "Cookies")), 0o600);
    } finally {
      if (!existsSync(release)) writeFileSync(release, "release");
      if (processAlive(first?.pid)) first?.kill("SIGKILL");
      if (processAlive(second?.pid)) second?.kill("SIGKILL");
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("forced TERM to KILL cannot claim or publish an incomplete final export", async () => {
    const root = await tempDir("openbot-cookie-forced-kill-");
    const home = join(root, "home");
    const jar = join(root, "cookies");
    const binDir = join(root, "bin");
    const held = join(root, "cp-held");
    const release = join(root, "cp-release");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(jar, "Network"), { recursive: true });
    writeFileSync(join(jar, "Network", "Cookies"), "recoverable-prior");
    const cp = await writeBlockingCpFixture(binDir);
    const pinchtabPort = await unusedLoopbackPort();
    const env = {
      ...process.env,
      COOKIE_JAR: jar,
      OPENBOT_CP_HELD_FILE: held,
      OPENBOT_CP_HOLD_MATCH: "google-chrome/Default/Network/Cookies",
      OPENBOT_CP_RELEASE_FILE: release,
      OPENBOT_PINCHTAB_PORT_BASE: String(pinchtabPort - 1),
      OPENBOT_REAL_CP: cp.real,
      OPENBOT_SCREEN_HOME: home,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      VNC_USER: process.env.USER ?? "openbot",
    };
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const imported = spawnSync("bash", [displaySh, "cookies-in", "1"], { encoding: "utf8", env });
      assert.equal(imported.status, 0, imported.stderr);
      const prior = currentCookieSnapshot(jar);
      const priorManifest = cookieManifest(prior);
      writeFileSync(join(home, ".config", "google-chrome", "Default", "Network", "Cookies"), "uncommitted-new");

      child = spawn(
        "bash",
        ["-c", 'trap "" TERM; exec bash "$@"', "forced-cookie-export", displaySh, "stop", "1"],
        { detached: true, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      const resultPromise = collectChild(child);
      await waitUntil(() => existsSync(held), 4_000);
      assert.ok(child.pid, "forced export fixture has no pid");
      process.kill(-(child.pid as number), "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(processAlive(child.pid), true, "fixture did not exercise TERM to KILL escalation");
      process.kill(-(child.pid as number), "SIGKILL");
      const result = await resultPromise;
      assert.equal(result.status, null);
      assert.equal(result.signal, "SIGKILL");
      assert.doesNotMatch(result.stdout + result.stderr, /cookie export committed generation/u);
      assert.equal(currentCookieSnapshot(jar), prior, "forced shutdown changed the committed identity");
      assert.deepEqual(cookieManifest(prior), priorManifest);
      assert.equal(modeOf(jar), 0o700);
      assert.equal(modeOf(prior), 0o700);
      assert.equal(modeOf(join(prior, "manifest")), 0o600);
      assert.equal(readFileSync(join(prior, "Network", "Cookies"), "utf8"), "recoverable-prior");
      assert.ok(readdirSync(jar).some((name) => name.startsWith(".staging.")), "fixture never interrupted staging");

      writeFileSync(release, "release");
      const recovered = spawnSync("bash", [displaySh, "cookies-in", "2"], { encoding: "utf8", env, timeout: 5_000 });
      assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
      assert.equal(readdirSync(jar).some((name) => name.startsWith(".staging.")), false);
      assert.equal(existsSync(join(jar, ".sync.lock")), false);
      assert.equal(currentCookieSnapshot(jar), prior);
    } finally {
      if (!existsSync(release)) writeFileSync(release, "release");
      if (child?.pid && processAlive(child.pid)) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("Computer runtimes create cookie jars privately under a permissive umask", async () => {
    const root = await tempDir("openbot-private-cookie-roots-");
    const previousUmask = process.umask(0);
    try {
      const paths = [join(root, "memory"), join(root, "noop"), join(root, "docker")];
      new MemoryComputerRuntime({ cookiesDir: paths[0] });
      new NoopComputerRuntime(paths[1]);
      new DockerComputerRuntime({ cookiesDir: paths[2] });
      for (const path of paths) assert.equal(modeOf(path), 0o700);
    } finally {
      process.umask(previousUmask);
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("Computer runtimes reject filesystem-root cookie targets before changing their mode", () => {
    const filesystemRoot = resolve(process.cwd(), "/");
    const originalMode = modeOf(filesystemRoot);
    assert.throws(() => assertPrivateDirectoryTarget(filesystemRoot), /filesystem root/iu);
    assert.throws(() => new MemoryComputerRuntime({ cookiesDir: filesystemRoot }), /filesystem root/iu);
    assert.throws(() => new NoopComputerRuntime(filesystemRoot), /filesystem root/iu);
    assert.throws(() => new DockerComputerRuntime({ cookiesDir: filesystemRoot }), /filesystem root/iu);
    assert.equal(modeOf(filesystemRoot), originalMode);
  });

  test("container token setup uses a private parent and file without trace disclosure", async () => {
    const root = await tempDir("openbot-private-token-file-");
    const tokenFile = join(root, "secrets", "pinchtab.token");
    const token = `token-file-${randomBytes(16).toString("hex")}`;
    try {
      const result = spawnSync("bash", ["-x", entrypointSh, "prepare-pinchtab-token"], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENBOT_PINCHTAB_TOKEN_FILE: tokenFile,
          PINCHTAB_TOKEN: token,
        },
      });
      assert.equal(result.status, 0, "private token setup failed");
      assert.equal(result.stdout.includes(token), false, "token setup stdout disclosed the credential");
      assert.equal(result.stderr.includes(token), false, "token setup trace disclosed the credential");
      assert.equal(modeOf(dirname(tokenFile)), 0o700);
      assert.equal(modeOf(tokenFile), 0o600);
      if (process.getuid && process.getgid) {
        assert.equal(statSync(dirname(tokenFile)).uid, process.getuid());
        assert.equal(statSync(dirname(tokenFile)).gid, process.getgid());
        assert.equal(statSync(tokenFile).uid, process.getuid());
        assert.equal(statSync(tokenFile).gid, process.getgid());
      }
      assert.equal(readFileSync(tokenFile, "utf8") === token, true, "token file content changed");

      const outside = join(root, "outside-token");
      writeFileSync(outside, "outside-sentinel");
      rmSync(tokenFile);
      symlinkSync(outside, tokenFile);
      const rejected = spawnSync("bash", [entrypointSh, "prepare-pinchtab-token"], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENBOT_PINCHTAB_TOKEN_FILE: tokenFile,
          PINCHTAB_TOKEN: token,
        },
      });
      assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
      assert.equal(rejected.stdout.includes(token), false);
      assert.equal(rejected.stderr.includes(token), false);
      assert.equal(readFileSync(outside, "utf8"), "outside-sentinel");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("container token setup rejects a filesystem-root parent before any mutation", async () => {
    const root = await tempDir("openbot-token-root-guard-");
    const binDir = join(root, "bin");
    const mutationLog = join(root, "mutation.log");
    const safeTmp = join(root, "safe-token.tmp");
    const token = `root-guard-${randomBytes(16).toString("hex")}`;
    mkdirSync(binDir, { recursive: true });
    for (const command of ["mkdir", "chmod", "chown", "mv"]) {
      writeFileSync(
        join(binDir, command),
        `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(command)} >> "$OPENBOT_MUTATION_LOG"\nexit 0\n`,
        { mode: 0o755 },
      );
    }
    writeFileSync(join(binDir, "mktemp"), '#!/bin/sh\nprintf \'%s\\n\' "$OPENBOT_SAFE_TMP"\n', { mode: 0o755 });
    try {
      const result = spawnSync("bash", [entrypointSh, "prepare-pinchtab-token"], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENBOT_MUTATION_LOG: mutationLog,
          OPENBOT_PINCHTAB_TOKEN_FILE: "/pinchtab.token",
          OPENBOT_SAFE_TMP: safeTmp,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          PINCHTAB_TOKEN: token,
        },
      });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /filesystem root/iu);
      assert.equal(result.stdout.includes(token), false);
      assert.equal(result.stderr.includes(token), false);
      assert.equal(existsSync(mutationLog), false, "root rejection ran a mutating command");
      assert.equal(existsSync(safeTmp), false, "root rejection staged credential content");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("container cleanup runs one serialized Screen stop before terminating VNC", () => {
    const body = readFileSync(entrypointSh, "utf8");
    const cleanup = body.slice(body.indexOf("cleanup()"));
    assert.match(cleanup, /CLEANUP_STARTED.*return "\$CLEANUP_RESULT"/su);
    assert.match(cleanup, /trap - TERM INT EXIT/u);
    assert.ok(
      cleanup.indexOf("openbot-display stop 1") < cleanup.indexOf('kill "$VNC_PID"'),
      "container termination preceded serialized cookie export",
    );
    assert.match(cleanup, /trap signal_cleanup TERM INT/u);
    assert.match(cleanup, /trap exit_cleanup EXIT/u);
    assert.doesNotMatch(cleanup, /trap cleanup TERM INT EXIT/u);
  });

  test("display token fallback rejects a symlinked parent without touching its target", async () => {
    const root = await tempDir("openbot-pinchtab-token-parent-");
    const home = join(root, "home");
    const outside = join(root, "outside-secrets");
    const link = join(root, "secrets-link");
    const tokenFile = join(link, "pinchtab.token");
    const token = `fallback-${randomBytes(16).toString("hex")}`;
    mkdirSync(home, { recursive: true });
    mkdirSync(outside, { recursive: true, mode: 0o777 });
    chmodSync(outside, 0o777);
    writeFileSync(join(outside, "pinchtab.token"), token, { mode: 0o644 });
    symlinkSync(outside, link, "dir");
    try {
      const result = spawnSync("bash", [displaySh, "pinchtab", "1"], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENBOT_PINCHTAB_TOKEN_FILE: tokenFile,
          OPENBOT_SCREEN_HOME: home,
          PINCHTAB_TOKEN: "",
          VNC_USER: process.env.USER ?? "openbot",
        },
      });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /token state must use real private files/iu);
      assert.equal(result.stdout.includes(token), false);
      assert.equal(result.stderr.includes(token), false);
      assert.equal(modeOf(outside), 0o777);
      assert.equal(modeOf(join(outside, "pinchtab.token")), 0o644);
      assert.equal(readFileSync(join(outside, "pinchtab.token"), "utf8") === token, true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

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
      VNC_USER: process.env.USER ?? "openbot",
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
    const snapshot = currentCookieSnapshot(jar);
    assert.equal(readFileSync(join(snapshot, "Cookies"), "utf8"), "jar-out");
    assert.equal(readFileSync(join(snapshot, "Cookies-wal"), "utf8"), "wal-out");
    assert.equal(readFileSync(join(snapshot, "Local State"), "utf8"), '{"os_crypt":{"encrypted_key":"k"}}');
    assert.equal(readFileSync(join(snapshot, "Network", "Cookies"), "utf8"), "net-out");
    assert.equal(readFileSync(join(snapshot, "Network", "Cookies-wal"), "utf8"), "net-wal");
    assert.equal(modeOf(snapshot), 0o700);
    assert.equal(modeOf(join(snapshot, "Network", "Cookies")), 0o600);
  });

  test("display.sh stop copies the jar when Chrome is already gone", async () => {
    const root = await tempDir("openbot-pt-stop-");
    const home = join(root, "home");
    const jar = join(root, "cookies");
    mkdirSync(join(home, ".config", "google-chrome", "Default", "Network"), { recursive: true });
    mkdirSync(jar, { recursive: true });
    const env = {
      ...process.env,
      OPENBOT_SCREEN_HOME: home,
      COOKIE_JAR: jar,
      VNC_USER: process.env.USER ?? "openbot",
    };
    const imported = spawnSync("bash", [displaySh, "cookies-in", "1"], { encoding: "utf8", env });
    assert.equal(imported.status, 0, imported.stderr);
    const prior = currentCookieSnapshot(jar);
    writeFileSync(join(home, ".config", "google-chrome", "Default", "Cookies"), "stop-out");
    writeFileSync(join(home, ".config", "google-chrome", "Default", "Cookies-wal"), "stop-wal");
    writeFileSync(join(home, ".config", "google-chrome", "Local State"), '{"os_crypt":{"encrypted_key":"stop"}}');
    const stopped = spawn("bash", [displaySh, "stop", "1"], { env, stdio: ["ignore", "pipe", "pipe"] });
    const result = await collectChild(stopped);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cookie export committed generation/u);
    const snapshot = currentCookieSnapshot(jar);
    assert.notEqual(snapshot, prior);
    assert.equal(readFileSync(join(snapshot, "Cookies"), "utf8"), "stop-out");
    assert.equal(readFileSync(join(snapshot, "Cookies-wal"), "utf8"), "stop-wal");
    assert.equal(readFileSync(join(snapshot, "Local State"), "utf8"), '{"os_crypt":{"encrypted_key":"stop"}}');
    assert.equal(readFileSync(join(snapshot, "Network", "Cookies"), "utf8"), "stop-out");
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
      VNC_USER: process.env.USER ?? "openbot",
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
  test("binary resolution accepts only executable regular files after following symlinks", async () => {
    const root = await tempDir("openbot-pt-resolver-file-");
    const directoryPath = join(root, "directory-path");
    const fifoPath = join(root, "fifo-path");
    const symlinkPath = join(root, "symlink-path");
    mkdirSync(join(directoryPath, "pinchtab"), { recursive: true, mode: 0o755 });
    mkdirSync(fifoPath, { recursive: true });
    mkdirSync(symlinkPath, { recursive: true });

    const fifo = join(fifoPath, "pinchtab");
    const madeFifo = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    assert.equal(madeFifo.status, 0, madeFifo.stderr);
    chmodSync(fifo, 0o755);

    const executable = join(root, "pinchtab-real");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(executable, 0o755);
    const symlink = join(symlinkPath, "pinchtab");
    symlinkSync(executable, symlink);

    assert.equal(resolvePinchTabBin({ PATH: directoryPath }), null);
    assert.equal(resolvePinchTabBin({ PATH: "", OPENBOT_PINCHTAB: join(directoryPath, "pinchtab") }), null);
    assert.equal(resolvePinchTabBin({ PATH: fifoPath }), null);
    assert.equal(resolvePinchTabBin({ PATH: "", OPENBOT_PINCHTAB: fifo }), null);
    assert.equal(resolvePinchTabBin({ PATH: symlinkPath }), symlink);
    assert.equal(resolvePinchTabBin({ PATH: "", OPENBOT_PINCHTAB: symlink }), symlink);
    assert.equal(resolvePinchTabBin({ PATH: relative(process.cwd(), symlinkPath) }), symlink);
    assert.equal(
      resolvePinchTabBin({ PATH: "", OPENBOT_PINCHTAB: relative(process.cwd(), symlink) }),
      symlink,
    );
  });

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
        OPENBOT_PINCHTAB_MCP_CHILD_REQUEST_TIMEOUT_MS: "876",
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
          (row) =>
            row.name === "OPENBOT_PINCHTAB_MCP_CHILD_REQUEST_TIMEOUT_MS" && row.value === "876",
        ),
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
