import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { AcpClient, type AcpHandlers } from "../src/acp.ts";
import { startBox, type RunningBox } from "../src/box.ts";
import type { SpawnSpec } from "../src/harness.ts";

const OVERSIZED_UNTERMINATED_STDERR_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
process.on("SIGTERM", () => {});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "stderr-bound-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    process.stderr.write("PRIVATE-STDERR-" + "x".repeat(1024 * 1024 + 1));
    setInterval(() => {}, 1_000);
  }
});
`;

const OVERSIZED_STARTUP_STDERR_ACP = String.raw`
process.on("SIGTERM", () => {});
process.stderr.write("PRIVATE-STARTUP-STDERR-" + "s".repeat(1024 * 1024 + 1));
setInterval(() => {}, 1_000);
`;

const STDERR_DELIMITERS_AND_FINAL_FRAGMENT_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const mode = process.argv[1];
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "stderr-delimiter-session" } });
    return;
  }
  if (message.method !== "session/prompt") return;
  if (mode === "cr-exit") {
    process.stderr.write("ONE\r");
    setTimeout(() => {
      process.stderr.write("TWO\r", () => setTimeout(() => process.exit(0), 20));
    }, 150);
    return;
  }
  process.stderr.write("LF\n");
  setTimeout(() => {
    process.stderr.write("CRLF\r");
    setTimeout(() => {
      process.stderr.write("\n");
      setTimeout(() => {
        process.stderr.write("FINAL-DIAGNOSTIC", () => process.exit(0));
      }, 20);
    }, 20);
  }, 20);
});
`;

const ITEM_LIMIT_FINAL_STDERR_FRAGMENT_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "stderr-final-item-session" } });
    return;
  }
  if (message.method !== "session/prompt") return;
  const lines = [];
  for (let index = 0; index < 4096; index += 1) {
    lines.push("stderr-item-" + index + "\n");
  }
  process.stderr.write(lines.join("") + "PRIVATE-FINAL-BUDGET", () => process.exit(0));
});
`;

const MANY_SUB_LIMIT_WIRE_FRAMES_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
process.on("SIGTERM", () => {});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "wire-bound-session" } });
    return;
  }
  if (message.method !== "session/prompt") return;
  const padding = "w".repeat(256 * 1024);
  let index = 0;
  const pump = () => {
    if (index >= 66) {
      setInterval(() => {}, 1_000);
      return;
    }
    const current = index;
    index += 1;
    const target = current % 2 === 0 ? process.stdout : process.stderr;
    const frame = current % 2 === 0
      ? JSON.stringify({
          jsonrpc: "2.0",
          method: "future/progress",
          params: { index: current, padding }
        }) + "\n"
      : "PRIVATE-STDERR-FRAME-" + current + "-" + padding + "\n";
    if (target.write(frame)) setImmediate(pump);
    else target.once("drain", pump);
  };
  pump();
});
`;

const MANY_COMPLETE_ITEMS_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const notificationCount = Number(process.argv[1]);
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "item-bound-session" } });
    return;
  }
  if (message.method !== "session/prompt") return;
  const frames = [];
  for (let index = 0; index < notificationCount; index += 1) {
    frames.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "future/progress",
      params: { index }
    }) + "\n");
  }
  frames.push(JSON.stringify({
    jsonrpc: "2.0",
    id: message.id,
    result: { stopReason: "end_turn" }
  }) + "\n");
  process.stdout.write(frames.join(""));
});
`;

const MANY_STDERR_ITEMS_ACP = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const stderrCount = Number(process.argv[1]);
const readyFile = process.argv[2];
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "stderr-item-session" } });
    return;
  }
  if (message.method !== "session/prompt") return;
  const lines = [];
  for (let index = 0; index < stderrCount; index += 1) {
    lines.push("stderr-item-" + index + "\n");
  }
  process.stderr.write(lines.join(""));
  const timer = setInterval(() => {
    if (!fs.existsSync(readyFile)) return;
    clearInterval(timer);
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }, 2);
});
`;

const ASSISTANT_ACCUMULATION_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const bubbleCount = Number(process.argv[1]);
const utf8 = process.argv[2] === "utf8";
process.on("SIGTERM", () => {});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "assistant-bound-session" } });
    return;
  }
  if (message.method !== "session/prompt") return;
  const text = utf8 ? "💥".repeat(16 * 1024) : "a".repeat(64 * 1024);
  let index = 0;
  const pump = () => {
    if (index >= bubbleCount) {
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "assistant-bound-session",
        update: {
          sessionUpdate: "agent_message",
          messageId: "aggregate-bubble-" + index,
          content: { type: "text", text }
        }
      }
    });
    index += 1;
    setTimeout(pump, 2);
  };
  pump();
});
`;

const ACTIVE_PERMISSION_REQUESTS_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const requestCount = Number(process.argv[1]);
let promptId = null;
let responseCount = 0;
process.on("SIGTERM", () => {});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "active-request-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    const requests = [];
    for (let index = 0; index < requestCount; index += 1) {
      requests.push(JSON.stringify({
        jsonrpc: "2.0",
        id: 10_000 + index,
        method: "session/request_permission",
        params: {
          sessionId: "active-request-session",
          title: "Permission " + index,
          options: [
            { optionId: "allow-" + index, name: "Allow", kind: "allow_once" },
            { optionId: "reject-" + index, name: "Deny", kind: "reject_once" }
          ]
        }
      }) + "\n");
    }
    process.stdout.write(requests.join(""));
    return;
  }
  if (typeof message.id === "number" && message.id >= 10_000) {
    responseCount += 1;
    if (responseCount === requestCount) {
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    }
  }
});
`;

const UNIQUE_PERMISSION_REQUESTS_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const requestCount = Number(process.argv[1]);
let promptId = null;
let nextIndex = 0;
process.on("SIGTERM", () => {});
const sendNext = () => {
  if (nextIndex >= requestCount) {
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    return;
  }
  const index = nextIndex;
  nextIndex += 1;
  send({
    jsonrpc: "2.0",
    id: 20_000 + index,
    method: "session/request_permission",
    params: {
      sessionId: "unique-request-session",
      title: "Unique permission " + index,
      options: [
        { optionId: "allow-" + index, name: "Allow", kind: "allow_once" },
        { optionId: "reject-" + index, name: "Deny", kind: "reject_once" }
      ]
    }
  });
};
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "unique-request-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    sendNext();
    return;
  }
  if (typeof message.id === "number" && message.id >= 20_000) sendNext();
});
`;

const REUSED_PERMISSION_ID_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const requestCount = Number(process.argv[1]);
const changed = process.argv[2] === "changed";
let promptId = null;
let nextIndex = 0;
process.on("SIGTERM", () => {});
const sendNext = () => {
  if (nextIndex >= requestCount) {
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    return;
  }
  const index = nextIndex;
  nextIndex += 1;
  const suffix = changed ? String(index) : "same";
  send({
    jsonrpc: "2.0",
    id: 25_000,
    method: "session/request_permission",
    params: {
      sessionId: "reused-request-session",
      title: "Reused permission " + suffix,
      options: [
        { optionId: "allow-" + suffix, name: "Allow", kind: "allow_once" },
        { optionId: "reject-" + suffix, name: "Deny", kind: "reject_once" }
      ]
    }
  });
};
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "reused-request-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    sendNext();
    return;
  }
  if (message.id === 25_000) sendNext();
});
`;

const DUPLICATE_COMPUTER_HELP_ACP = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const duplicateCount = Number(process.argv[1]);
let identity = null;
let generationFile = null;
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    const server = message.params?.mcpServers?.find(
      (candidate) => candidate.name === "openbot-computer-help"
    );
    identity = server?.env?.find(
      (entry) => entry.name === "OPENBOT_COMPUTER_HELP_IDENTITY"
    )?.value ?? null;
    generationFile = server?.env?.find(
      (entry) => entry.name === "OPENBOT_COMPUTER_HELP_GENERATION_FILE"
    )?.value ?? null;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "duplicate-help-session" } });
    return;
  }
  if (message.method !== "session/prompt") return;
  const request = {
    jsonrpc: "2.0",
    id: 30_001,
    method: "elicitation/create",
    params: {
      sessionId: "duplicate-help-session",
      mode: "form",
      message: "Complete the visual step on this Computer, then choose I'm done.",
      requestedSchema: {
        type: "object",
        properties: { completed: { type: "string", enum: ["done"] } },
        required: ["completed"],
        additionalProperties: false
      },
      _meta: {
        "openbot/computer-help": {
          kind: "computer-help",
          version: 1,
          identity,
          generation: fs.readFileSync(generationFile, "utf8").trim()
        }
      }
    }
  };
  const frames = [];
  for (let index = 0; index < duplicateCount; index += 1) {
    frames.push(JSON.stringify(request) + "\n");
  }
  frames.push(JSON.stringify({
    jsonrpc: "2.0",
    id: message.id,
    result: { stopReason: "end_turn" }
  }) + "\n");
  process.stdout.write(frames.join(""));
});
`;

const TERMINAL_COMPUTER_HELP_REPLAY_ACP = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const requestCount = Number(process.argv[1]);
const changed = process.argv[2] === "changed";
let identity = null;
let generationFile = null;
let promptId = null;
let requestGeneration = null;
const requestFor = (index) => ({
  jsonrpc: "2.0",
  id: 35_001,
  method: "elicitation/create",
  params: {
    sessionId: "terminal-help-replay-session",
    mode: "form",
    message: changed && index > 0
      ? "Complete private visual step " + index + ", then choose I'm done."
      : "Complete the visual step on this Computer, then choose I'm done.",
    requestedSchema: {
      type: "object",
      properties: { completed: { type: "string", enum: ["done"] } },
      required: ["completed"],
      additionalProperties: false
    },
    _meta: {
      "openbot/computer-help": {
        kind: "computer-help",
        version: 1,
        identity,
        generation: requestGeneration
      }
    }
  }
});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    const server = message.params?.mcpServers?.find(
      (candidate) => candidate.name === "openbot-computer-help"
    );
    identity = server?.env?.find(
      (entry) => entry.name === "OPENBOT_COMPUTER_HELP_IDENTITY"
    )?.value ?? null;
    generationFile = server?.env?.find(
      (entry) => entry.name === "OPENBOT_COMPUTER_HELP_GENERATION_FILE"
    )?.value ?? null;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId: "terminal-help-replay-session" }
    });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    requestGeneration = fs.readFileSync(generationFile, "utf8").trim();
    send(requestFor(0));
    return;
  }
  if (message.id !== 35_001) return;
  setTimeout(() => {
    const frames = [];
    for (let index = 1; index < requestCount; index += 1) {
      frames.push(JSON.stringify(requestFor(index)) + "\n");
    }
    frames.push(JSON.stringify({
      jsonrpc: "2.0",
      id: promptId,
      result: { stopReason: "end_turn" }
    }) + "\n");
    process.stdout.write(frames.join(""));
  }, 10);
});
`;

const CANCELLATION_DRAIN_WIRE_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
process.on("SIGTERM", () => {});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "cancel-budget-session" } });
    return;
  }
  if (message.method !== "session/cancel") return;
  const padding = "c".repeat(256 * 1024);
  let index = 0;
  const pump = () => {
    if (index >= 66) {
      setInterval(() => {}, 1_000);
      return;
    }
    const current = index;
    index += 1;
    const target = current % 2 === 0 ? process.stdout : process.stderr;
    const frame = current % 2 === 0
      ? JSON.stringify({
          jsonrpc: "2.0",
          method: "future/cancel_progress",
          params: { index: current, padding }
        }) + "\n"
      : "PRIVATE-CANCEL-STDERR-" + current + "-" + padding + "\n";
    if (target.write(frame)) setImmediate(pump);
    else target.once("drain", pump);
  };
  pump();
});
`;

const PUBLIC_AGGREGATE_OVERFLOW_ACP = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const mode = process.argv[1];
let sessionId = "public-aggregate-session";
let identity = null;
let generationFile = null;
if (mode === "overflow") {
  spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);"
  ], { stdio: "ignore" });
  process.on("SIGTERM", () => {});
}
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    const server = message.params?.mcpServers?.find(
      (candidate) => candidate.name === "openbot-computer-help"
    );
    identity = server?.env?.find(
      (entry) => entry.name === "OPENBOT_COMPUTER_HELP_IDENTITY"
    )?.value ?? null;
    generationFile = server?.env?.find(
      (entry) => entry.name === "OPENBOT_COMPUTER_HELP_GENERATION_FILE"
    )?.value ?? null;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    return;
  }
  if (message.method === "session/load") {
    sessionId = message.params.sessionId;
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method !== "session/prompt") return;
  if (mode === "healthy") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message",
          messageId: "aggregate-recovery",
          content: { type: "text", text: "Recovered on a fresh aggregate client." }
        }
      }
    });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message",
        messageId: "aggregate-committed",
        content: { type: "text", text: "Committed before aggregate overflow." }
      }
    }
  });
  send({
    jsonrpc: "2.0",
    id: 40_001,
    method: "elicitation/create",
    params: {
      sessionId,
      mode: "form",
      message: "Complete the visual step on this Computer, then choose I'm done.",
      requestedSchema: {
        type: "object",
        properties: { completed: { type: "string", enum: ["done"] } },
        required: ["completed"],
        additionalProperties: false
      },
      _meta: {
        "openbot/computer-help": {
          kind: "computer-help",
          version: 1,
          identity,
          generation: fs.readFileSync(generationFile, "utf8").trim()
        }
      }
    }
  });
  send({
    jsonrpc: "2.0",
    id: 40_002,
    method: "session/request_permission",
    params: {
      sessionId,
      title: "PRIVATE-PERMISSION-PAYLOAD",
      toolCall: { title: "PRIVATE-TOOL-COMMAND", kind: "execute" },
      options: [
        { optionId: "allow-private", name: "Allow", kind: "allow_once" },
        { optionId: "reject-private", name: "Deny", kind: "reject_once" }
      ]
    }
  });
  setTimeout(() => {
    const privateText = "PRIVATE-UNCOMMITTED-SECRET-" + "u".repeat(64 * 1024);
    const frames = [];
    for (let index = 0; index < 17; index += 1) {
      frames.push(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "aggregate-uncommitted",
            content: { type: "text", text: privateText }
          }
        }
      }) + "\n");
    }
    process.stdout.write(frames.join(""));
  }, 150);
});
`;

async function within<T>(promise: Promise<T>, milliseconds = 1_500): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("ACP aggregate regression stayed pending")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function processGroupExists(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessGroupGone(groupId: number, milliseconds = 1_000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (processGroupExists(groupId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(processGroupExists(groupId), false, `ACP process group ${groupId} survived`);
}

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

async function login(box: RunningBox): Promise<string> {
  const response = await fetch(`${box.url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "correct-horse" }),
  });
  assert.equal(response.status, 200);
  return cookieHeader(response);
}

type AggregatePublicBot = {
  id: string;
  write: boolean;
  permission?: unknown;
  needsYou?: { reason?: string } | null;
  messages: Array<{
    id: string;
    text?: string;
    card?: {
      kind?: string;
      actions?: Array<{ label?: string }>;
      status?: { tone?: string; label?: string };
    };
  }>;
};

async function createBot(box: RunningBox, cookie: string): Promise<string> {
  const created = await fetch(`${box.url}/api/bots`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada" }),
  });
  assert.equal(created.status, 201);
  const botId = ((await created.json()) as { id: string }).id;
  const selected = await fetch(`${box.url}/api/bots/${botId}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ harness: "codex" }),
  });
  assert.equal(selected.status, 200);
  return botId;
}

async function getBot(box: RunningBox, cookie: string, botId: string): Promise<AggregatePublicBot> {
  const response = await fetch(`${box.url}/api/bots/${botId}`, { headers: { cookie } });
  assert.equal(response.status, 200);
  return (await response.json()) as AggregatePublicBot;
}

async function waitForBot(
  box: RunningBox,
  cookie: string,
  botId: string,
  predicate: (bot: AggregatePublicBot) => boolean,
): Promise<AggregatePublicBot> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const bot = await getBot(box, cookie, botId);
    if (predicate(bot)) return bot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for aggregate Bot state");
}

function client(source: string): AcpClient {
  return new AcpClient({
    command: process.execPath,
    args: ["-e", source],
    env: { ...process.env },
  }, process.cwd(), {}, { startDeadlineMs: 250, terminateGraceMs: 25 });
}

function clientWithArgs(source: string, args: string[]): AcpClient {
  return new AcpClient({
    command: process.execPath,
    args: ["-e", source, ...args],
    env: { ...process.env },
  }, process.cwd(), {}, { startDeadlineMs: 250, terminateGraceMs: 25 });
}

function clientWithHandlers(source: string, args: string[], handlers: AcpHandlers): AcpClient {
  return new AcpClient({
    command: process.execPath,
    args: ["-e", source, ...args],
    env: { ...process.env },
  }, process.cwd(), handlers, { startDeadlineMs: 250, terminateGraceMs: 25 });
}

describe("AcpClient active Turn aggregate bounds", () => {
  test("preserves CR, LF, split CRLF, and final stderr fragment semantics", async () => {
    const cases: Array<[string, string[]]> = [
      ["cr-exit", ["ONE", "TWO"]],
      ["mixed-final", ["LF", "CRLF", "FINAL-DIAGNOSTIC"]],
    ];
    for (const [mode, expected] of cases) {
      const stderr: string[] = [];
      const acp = clientWithHandlers(STDERR_DELIMITERS_AND_FINAL_FRAGMENT_ACP, [mode], {
        onStderr(line) {
          stderr.push(line);
        },
      });
      const groupId = acp.pid;
      assert.ok(groupId);
      let rejectionCount = 0;
      try {
        assert.deepEqual(await within(acp.initialize()), { authMethods: [] });
        assert.equal(await within(acp.newSession(process.cwd())), "stderr-delimiter-session");
        const running = acp.prompt("preserve stderr line semantics").catch((error: unknown) => {
          rejectionCount += 1;
          throw error;
        });
        await assert.rejects(
          within(running),
          (error: unknown) => {
            assert.equal((error as Error).message, "ACP child exited");
            assert.doesNotMatch(String(error), /FINAL-DIAGNOSTIC|preserve stderr/);
            return true;
          },
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(stderr, expected);
        assert.equal(rejectionCount, 1);
        await waitForProcessGroupGone(groupId);
      } finally {
        acp.close();
        await waitForProcessGroupGone(groupId);
      }
    }
  });

  test("charges one final stderr fragment before callback dispatch", async () => {
    let callbacks = 0;
    let leaked = false;
    const broken = clientWithHandlers(ITEM_LIMIT_FINAL_STDERR_FRAGMENT_ACP, [], {
      onStderr(line) {
        callbacks += 1;
        if (line.includes("PRIVATE-FINAL-BUDGET")) leaked = true;
      },
    });
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      assert.deepEqual(await within(broken.initialize()), { authMethods: [] });
      assert.equal(await within(broken.newSession(process.cwd())), "stderr-final-item-session");
      await assert.rejects(
        within(broken.prompt("suppress the item-overflow final fragment")),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport protocol error");
          assert.doesNotMatch(String(error), /PRIVATE-FINAL-BUDGET|suppress the item/);
          return true;
        },
      );
      assert.equal(callbacks, 4096);
      assert.equal(leaked, false);
      await waitForProcessGroupGone(groupId);
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("keeps the stderr line ceiling active from child spawn", async () => {
    const stderr: string[] = [];
    const broken = clientWithHandlers(OVERSIZED_STARTUP_STDERR_ACP, [], {
      onStderr(line) {
        stderr.push(line);
      },
    });
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      await assert.rejects(
        within(broken.initialize()),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport protocol error");
          assert.doesNotMatch(String(error), /PRIVATE-STARTUP-STDERR/);
          return true;
        },
      );
      assert.deepEqual(stderr, []);
      await waitForProcessGroupGone(groupId);
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("bounds oversized unterminated stderr once, reaps, and permits a fresh client", async () => {
    const stderr: string[] = [];
    const broken = clientWithHandlers(OVERSIZED_UNTERMINATED_STDERR_ACP, [], {
      onStderr(line) {
        stderr.push(line);
      },
    });
    const groupId = broken.pid;
    assert.ok(groupId);
    let rejectionCount = 0;
    try {
      assert.deepEqual(await within(broken.initialize()), { authMethods: [] });
      assert.equal(await within(broken.newSession(process.cwd())), "stderr-bound-session");
      const running = broken.prompt("trigger private oversized stderr").catch((error: unknown) => {
        rejectionCount += 1;
        throw error;
      });
      await assert.rejects(
        within(running),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport protocol error");
          assert.doesNotMatch(String(error), /PRIVATE-STDERR|trigger private/);
          return true;
        },
      );
      await waitForProcessGroupGone(groupId);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(rejectionCount, 1);
      assert.deepEqual(stderr, []);
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }

    const fresh = clientWithArgs(MANY_COMPLETE_ITEMS_ACP, ["0"]);
    try {
      assert.deepEqual(await within(fresh.initialize()), { authMethods: [] });
      assert.equal(await within(fresh.newSession(process.cwd())), "item-bound-session");
      assert.equal(await within(fresh.prompt("recover after bounded stderr")), "");
    } finally {
      const freshGroupId = fresh.pid;
      fresh.close();
      if (freshGroupId) await waitForProcessGroupGone(freshGroupId);
    }
  });

  test("bounds combined stdout and stderr wire bytes across sub-limit frames", async () => {
    const broken = client(MANY_SUB_LIMIT_WIRE_FRAMES_ACP);
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      assert.deepEqual(await within(broken.initialize()), { authMethods: [] });
      assert.equal(await within(broken.newSession(process.cwd())), "wire-bound-session");
      await assert.rejects(
        within(broken.prompt("trigger private aggregate wire output")),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport protocol error");
          assert.doesNotMatch(String(error), /PRIVATE-STDERR|trigger private/);
          return true;
        },
      );
      await waitForProcessGroupGone(groupId);
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("allows 4,096 complete transport items and rejects item 4,097", async () => {
    const allowed = clientWithArgs(MANY_COMPLETE_ITEMS_ACP, ["4095"]);
    try {
      assert.deepEqual(await within(allowed.initialize()), { authMethods: [] });
      assert.equal(await within(allowed.newSession(process.cwd())), "item-bound-session");
      assert.equal(await within(allowed.prompt("stay at the item ceiling")), "");
    } finally {
      const groupId = allowed.pid;
      allowed.close();
      if (groupId) await waitForProcessGroupGone(groupId);
    }

    const broken = clientWithArgs(MANY_COMPLETE_ITEMS_ACP, ["4096"]);
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      assert.deepEqual(await within(broken.initialize()), { authMethods: [] });
      assert.equal(await within(broken.newSession(process.cwd())), "item-bound-session");
      await assert.rejects(
        within(broken.prompt("cross the item ceiling")),
        /ACP transport protocol error/,
      );
      await waitForProcessGroupGone(groupId);
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("counts each complete stderr line toward the 4,096-item ceiling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-stderr-items-"));
    const allowedReady = join(directory, "allowed-ready");
    const brokenReady = join(directory, "broken-ready");
    try {
      let allowedCount = 0;
      const allowed = clientWithHandlers(MANY_STDERR_ITEMS_ACP, ["4095", allowedReady], {
        onStderr() {
          allowedCount += 1;
          if (allowedCount === 4095) return writeFile(allowedReady, "ready");
        },
      });
      try {
        await within(allowed.initialize());
        await within(allowed.newSession(process.cwd()));
        assert.equal(await within(allowed.prompt("fill the stderr item ceiling")), "");
        assert.equal(allowedCount, 4095);
      } finally {
        const groupId = allowed.pid;
        allowed.close();
        if (groupId) await waitForProcessGroupGone(groupId);
      }

      let brokenCount = 0;
      const broken = clientWithHandlers(MANY_STDERR_ITEMS_ACP, ["4096", brokenReady], {
        onStderr() {
          brokenCount += 1;
          if (brokenCount === 4096) return writeFile(brokenReady, "ready");
        },
      });
      const groupId = broken.pid;
      assert.ok(groupId);
      try {
        await within(broken.initialize());
        await within(broken.newSession(process.cwd()));
        await assert.rejects(
          within(broken.prompt("cross the stderr item ceiling")),
          /ACP transport protocol error/,
        );
        assert.equal(brokenCount, 4096);
        await waitForProcessGroupGone(groupId);
      } finally {
        broken.close();
        await waitForProcessGroupGone(groupId);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("retains at most 1 MiB of extracted assistant text across bubbles", async () => {
    const allowedBubbles: string[] = [];
    const allowed = clientWithHandlers(ASSISTANT_ACCUMULATION_ACP, ["16"], {
      onAssistant(text) {
        allowedBubbles.push(text);
      },
    });
    try {
      await within(allowed.initialize());
      await within(allowed.newSession(process.cwd()));
      const result = await within(allowed.prompt("stay at the assistant ceiling"));
      assert.equal(Buffer.byteLength(result, "utf8"), 1024 * 1024);
      assert.equal(allowedBubbles.length, 16);
    } finally {
      const groupId = allowed.pid;
      allowed.close();
      if (groupId) await waitForProcessGroupGone(groupId);
    }

    const retainedBubbles: string[] = [];
    const broken = clientWithHandlers(ASSISTANT_ACCUMULATION_ACP, ["17", "utf8"], {
      onAssistant(text) {
        retainedBubbles.push(text);
      },
    });
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      await within(broken.initialize());
      await within(broken.newSession(process.cwd()));
      await assert.rejects(
        within(broken.prompt("cross the private assistant ceiling")),
        /ACP transport protocol error/,
      );
      assert.equal(retainedBubbles.length, 16);
      assert.equal(
        retainedBubbles.reduce((bytes, text) => bytes + Buffer.byteLength(text, "utf8"), 0),
        1024 * 1024,
      );
      await waitForProcessGroupGone(groupId);
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("allows 16 simultaneously active server requests and rejects request 17", async () => {
    let allowed!: AcpClient;
    let allowedCount = 0;
    allowed = clientWithHandlers(ACTIVE_PERMISSION_REQUESTS_ACP, ["16"], {
      onPermission(prompt) {
        allowedCount += 1;
        return allowed.respondPermission(prompt.rpcId, `reject-${allowedCount - 1}`);
      },
    });
    try {
      await within(allowed.initialize());
      await within(allowed.newSession(process.cwd()));
      assert.equal(await within(allowed.prompt("allow the active request ceiling")), "");
      assert.equal(allowedCount, 16);
    } finally {
      const groupId = allowed.pid;
      allowed.close();
      if (groupId) await waitForProcessGroupGone(groupId);
    }

    let dispatched = 0;
    const broken = clientWithHandlers(ACTIVE_PERMISSION_REQUESTS_ACP, ["17"], {
      onPermission() {
        dispatched += 1;
      },
    });
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      await within(broken.initialize());
      await within(broken.newSession(process.cwd()));
      await assert.rejects(
        within(broken.prompt("cross the private active request ceiling")),
        /ACP transport protocol error/,
      );
      assert.equal(dispatched, 16);
      await waitForProcessGroupGone(groupId);
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("allows 128 unique server requests and rejects unique request 129", async () => {
    let allowed!: AcpClient;
    let allowedCount = 0;
    allowed = clientWithHandlers(UNIQUE_PERMISSION_REQUESTS_ACP, ["128"], {
      onPermission(prompt) {
        const optionId = `reject-${allowedCount}`;
        allowedCount += 1;
        return allowed.respondPermission(prompt.rpcId, optionId);
      },
    });
    try {
      await within(allowed.initialize());
      await within(allowed.newSession(process.cwd()));
      assert.equal(await within(allowed.prompt("allow the unique request ceiling")), "");
      assert.equal(allowedCount, 128);
    } finally {
      const groupId = allowed.pid;
      allowed.close();
      if (groupId) await waitForProcessGroupGone(groupId);
    }

    let broken!: AcpClient;
    let dispatched = 0;
    broken = clientWithHandlers(UNIQUE_PERMISSION_REQUESTS_ACP, ["129"], {
      onPermission(prompt) {
        const optionId = `reject-${dispatched}`;
        dispatched += 1;
        return broken.respondPermission(prompt.rpcId, optionId);
      },
    });
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      await within(broken.initialize());
      await within(broken.newSession(process.cwd()));
      await assert.rejects(
        within(broken.prompt("cross the private unique request ceiling")),
        /ACP transport protocol error/,
      );
      assert.equal(dispatched, 128);
      await waitForProcessGroupGone(groupId);
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("distinguishes changed reuse from an exact replay of one completed request id", async () => {
    let replay!: AcpClient;
    let replayCount = 0;
    replay = clientWithHandlers(REUSED_PERMISSION_ID_ACP, ["129", "same"], {
      onPermission(prompt) {
        replayCount += 1;
        return replay.respondPermission(prompt.rpcId, "reject-same");
      },
    });
    try {
      await within(replay.initialize());
      await within(replay.newSession(process.cwd()));
      assert.equal(await within(replay.prompt("replay one completed request exactly")), "");
      assert.equal(replayCount, 129);
    } finally {
      const groupId = replay.pid;
      replay.close();
      if (groupId) await waitForProcessGroupGone(groupId);
    }

    let changed!: AcpClient;
    let changedCount = 0;
    changed = clientWithHandlers(REUSED_PERMISSION_ID_ACP, ["129", "changed"], {
      onPermission(prompt) {
        const optionId = `reject-${changedCount}`;
        changedCount += 1;
        return changed.respondPermission(prompt.rpcId, optionId);
      },
    });
    const groupId = changed.pid;
    assert.ok(groupId);
    try {
      await within(changed.initialize());
      await within(changed.newSession(process.cwd()));
      await assert.rejects(
        within(changed.prompt("change one completed request identity 129 times")),
        /ACP transport protocol error/,
      );
      assert.equal(changedCount, 128);
      await waitForProcessGroupGone(groupId);
    } finally {
      changed.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("charges exact duplicate requests as items without consuming unique slots", async () => {
    let dispatched = 0;
    const allowed = clientWithHandlers(DUPLICATE_COMPUTER_HELP_ACP, ["129"], {
      onComputerHelp() {
        dispatched += 1;
      },
    });
    try {
      await within(allowed.initialize());
      await within(allowed.newSession(process.cwd()));
      assert.equal(await within(allowed.prompt("replay one exact request identity")), "");
      assert.equal(dispatched, 1);
    } finally {
      const groupId = allowed.pid;
      allowed.close();
      if (groupId) await waitForProcessGroupGone(groupId);
    }

    let overflowDispatched = 0;
    const broken = clientWithHandlers(DUPLICATE_COMPUTER_HELP_ACP, ["4096"], {
      onComputerHelp() {
        overflowDispatched += 1;
      },
    });
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      await within(broken.initialize());
      await within(broken.newSession(process.cwd()));
      await assert.rejects(
        within(broken.prompt("charge every duplicate transport item")),
        /ACP transport protocol error/,
      );
      assert.equal(overflowDispatched, 1);
      await waitForProcessGroupGone(groupId);
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("accounts for changed terminal Computer-help replays while suppressing exact ones", async () => {
    let exact!: AcpClient;
    let exactCalls = 0;
    exact = clientWithHandlers(TERMINAL_COMPUTER_HELP_REPLAY_ACP, ["129", "same"], {
      onComputerHelp(prompt) {
        exactCalls += 1;
        return exact.respondComputerHelp(prompt.rpcId, "done");
      },
    });
    try {
      await within(exact.initialize());
      await within(exact.newSession(process.cwd()));
      assert.equal(await within(exact.prompt("suppress exact terminal replays")), "");
      assert.equal(exactCalls, 1);
    } finally {
      const groupId = exact.pid;
      exact.close();
      if (groupId) await waitForProcessGroupGone(groupId);
    }

    let changed!: AcpClient;
    let changedCalls = 0;
    changed = clientWithHandlers(TERMINAL_COMPUTER_HELP_REPLAY_ACP, ["129", "changed"], {
      onComputerHelp(prompt) {
        changedCalls += 1;
        return changed.respondComputerHelp(prompt.rpcId, "done");
      },
    });
    const groupId = changed.pid;
    assert.ok(groupId);
    try {
      await within(changed.initialize());
      await within(changed.newSession(process.cwd()));
      await assert.rejects(
        within(changed.prompt("count changed terminal replays as unique work")),
        /ACP transport protocol error/,
      );
      assert.equal(changedCalls, 1);
      await waitForProcessGroupGone(groupId);
    } finally {
      changed.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("keeps the active Turn ledger through cancellation drain", async () => {
    const broken = client(CANCELLATION_DRAIN_WIRE_ACP);
    const groupId = broken.pid;
    assert.ok(groupId);
    let resolveFlushed!: () => void;
    const flushed = new Promise<void>((resolve) => { resolveFlushed = resolve; });
    try {
      await within(broken.initialize());
      await within(broken.newSession(process.cwd()));
      const running = broken.prompt("cancel before aggregate output", {
        onPromptFlushed: resolveFlushed,
      });
      await within(flushed);
      assert.equal(broken.cancel(), true);
      await assert.rejects(within(running), /cancelled/);
      await assert.rejects(
        within(broken.prompt("wait behind the cancelled drain")),
        /ACP transport protocol error/,
      );
      await waitForProcessGroupGone(groupId);
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("contains one public overflow, preserves committed state, and recovers on a fresh client", {
    skip: process.platform === "win32",
  }, async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-aggregate-home-"));
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-aggregate-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const clients: AcpClient[] = [];
    const pids: number[] = [];
    const spawnCounts = new Map<string, number>();
    const spawnAcp = (
      _spec: SpawnSpec,
      cwd: string,
      handlers: AcpHandlers = {},
    ): AcpClient => {
      const attempt = (spawnCounts.get(cwd) ?? 0) + 1;
      spawnCounts.set(cwd, attempt);
      const client = new AcpClient({
        command: process.execPath,
        args: ["-e", PUBLIC_AGGREGATE_OVERFLOW_ACP, attempt === 1 ? "overflow" : "healthy"],
        env: { ...process.env },
      }, cwd, handlers, { startDeadlineMs: 500, terminateGraceMs: 25 });
      clients.push(client);
      if (client.pid) pids.push(client.pid);
      return client;
    };
    const box = await startBox({
      password: "correct-horse",
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp,
    });
    try {
      const cookie = await login(box);
      const botId = await createBot(box, cookie);
      const sent = await fetch(`${box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Trigger one aggregate containment path." }),
      });
      assert.equal(sent.status, 200);
      assert.doesNotMatch(
        await sent.text(),
        /PRIVATE-|ACP transport protocol error|node:|\/Users\//,
      );

      const failed = await waitForBot(box, cookie, botId, (bot) => (
        bot.write === false
        && bot.messages.some((message) => message.card?.kind === "bot-failure")
      ));
      assert.equal(failed.permission, null);
      assert.equal(failed.needsYou, null);
      assert.equal(
        failed.messages.filter((message) => message.text === "Committed before aggregate overflow.").length,
        1,
      );
      assert.equal(
        failed.messages.filter((message) => message.text?.includes("PRIVATE-UNCOMMITTED") ?? false).length,
        0,
      );
      assert.equal(failed.messages.filter((message) => message.card?.kind === "bot-failure").length, 1);
      const permissionCards = failed.messages.filter((message) => message.card?.kind === "permission");
      assert.equal(permissionCards.length, 1);
      assert.equal(permissionCards[0]?.card?.actions?.length, 0);
      const computerCards = failed.messages.filter((message) => message.card?.kind === "computer");
      assert.equal(computerCards.length, 1);
      assert.deepEqual(
        computerCards[0]?.card?.actions?.map((action) => action.label),
        ["Open computer"],
      );
      assert.doesNotMatch(
        JSON.stringify(failed),
        /PRIVATE-|ACP transport protocol error|node:|\/Users\//,
      );
      assert.equal(pids.length, 1);
      await waitForProcessGroupGone(pids[0]);

      await new Promise((resolve) => setTimeout(resolve, 50));
      const settled = await getBot(box, cookie, botId);
      assert.equal(settled.messages.filter((message) => message.card?.kind === "bot-failure").length, 1);

      const failure = failed.messages.find((message) => message.card?.kind === "bot-failure");
      assert.ok(failure);
      const retried = await fetch(`${box.url}/api/bots/${botId}/cards/${failure.id}/retry`, {
        method: "POST",
        headers: { cookie },
      });
      assert.equal(retried.status, 200);
      assert.doesNotMatch(
        await retried.text(),
        /PRIVATE-|ACP transport protocol error|node:|\/Users\//,
      );
      const recovered = await waitForBot(box, cookie, botId, (bot) => (
        bot.write === false
        && bot.messages.some((message) => message.text === "Recovered on a fresh aggregate client.")
      ));
      assert.equal(spawnCounts.size, 1);
      assert.equal([...spawnCounts.values()][0], 2);
      assert.equal(
        recovered.messages.filter((message) => message.text === "Committed before aggregate overflow.").length,
        1,
      );
      assert.equal(
        recovered.messages.filter((message) => message.text === "Recovered on a fresh aggregate client.").length,
        1,
      );
      assert.equal(recovered.messages.filter((message) => message.card?.kind === "bot-failure").length, 1);
      assert.equal(recovered.permission, null);
      assert.equal(recovered.needsYou, null);
      assert.doesNotMatch(
        JSON.stringify(recovered),
        /PRIVATE-|ACP transport protocol error|node:|\/Users\//,
      );
    } finally {
      for (const client of clients) client.close();
      for (const pid of pids) await waitForProcessGroupGone(pid);
      await new Promise((resolve) => setImmediate(resolve));
      await box.close();
      await rm(homeDir, { recursive: true, force: true });
      await rm(pwaDir, { recursive: true, force: true });
    }
  });
});
