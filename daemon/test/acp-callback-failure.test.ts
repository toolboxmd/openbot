import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  AcpClient,
  cancellationClosedTransport,
  computerHelpResponseWasFlushed,
  isCancelled,
  type AcpHandlers,
} from "../src/acp.ts";
import { startBox, type RunningBox } from "../src/box.ts";
import type { SpawnSpec } from "../src/harness.ts";

const PERMISSION_CALLBACK_ACP = String.raw`
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);"
], { stdio: "ignore" });
process.on("SIGTERM", () => {});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "callback-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 700,
        method: "session/request_permission",
        params: {
          sessionId: "callback-session",
          title: "Allow callback fixture?",
          options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }]
        }
      })
      + "\n"
      + JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { stopReason: "end_turn" }
      })
      + "\n"
    );
  }
});
`;

const HEALTHY_ACP = String.raw`
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fresh-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`;

const ASSISTANT_CALLBACK_ACP = String.raw`
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "assistant-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    const update = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "assistant-session",
        update: {
          sessionUpdate: process.argv[1] === "stream"
            ? "agent_message_chunk"
            : "agent_message",
          content: { type: "text", text: "PRIVATE-ASSISTANT-TEXT" },
          messageId: "assistant-message"
        }
      }
    };
    process.stdout.write(
      JSON.stringify(update)
      + "\n"
      + JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { stopReason: "end_turn" }
      })
      + "\n"
    );
  }
});
`;

const STDERR_CALLBACK_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
process.on("SIGTERM", () => {
  process.stderr.write("PRIVATE-STDERR-AFTER-FAILURE\n");
});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "stderr-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    process.stderr.write("PRIVATE-STDERR-LINE\n");
    setImmediate(() => {
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    });
  }
});
`;

const COMPUTER_HELP_CALLBACK_ACP = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let identity = null;
let generationFile = null;
let promptId = null;
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "computer-help-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    const request = {
      jsonrpc: "2.0",
      id: 701,
      method: "elicitation/create",
      params: {
        sessionId: "computer-help-session",
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
    const terminal = process.argv[1] === "pending"
      ? ""
      : JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { stopReason: "end_turn" }
        }) + "\n";
    process.stdout.write(JSON.stringify(request) + "\n" + terminal);
    return;
  }
  if (message.id === 701 && message.result?.action === "accept") {
    const completed = message.result?.content?.completed;
    if (completed !== "done") process.exit(42);
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  }
});
`;

const COMPUTER_HELP_FLUSH_RACE_ACP = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const triggerFile = process.argv[1];
const receiptFile = process.argv[2];
let identity = null;
let generationFile = null;
let promptId = null;
spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);"
], { stdio: "ignore" });
process.on("SIGTERM", () => {});
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "flush-race-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    send({
      jsonrpc: "2.0",
      id: 702,
      method: "elicitation/create",
      params: {
        sessionId: "flush-race-session",
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
    const timer = setInterval(() => {
      if (!fs.existsSync(triggerFile)) return;
      clearInterval(timer);
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "flush-race-session",
          update: {
            sessionUpdate: "agent_message",
            content: { type: "text", text: "Controlled callback C." },
            messageId: "callback-c"
          }
        }
      });
    }, 5);
    return;
  }
  if (message.id === 702 && message.result?.action === "accept") {
    if (message.result?.content?.completed !== "done") process.exit(42);
    fs.appendFileSync(receiptFile, "1", { mode: 0o600 });
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  }
});
`;

const ORDERED_ASSISTANT_CALLBACK_ACP = String.raw`
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "ordered-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    const update = (text, messageId) => ({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ordered-session",
        update: {
          sessionUpdate: "agent_message",
          content: { type: "text", text },
          messageId
        }
      }
    });
    process.stdout.write(
      JSON.stringify(update("A", "ordered-a"))
      + "\n"
      + JSON.stringify(update("B", "ordered-b"))
      + "\n"
      + JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { stopReason: "end_turn" }
      })
      + "\n"
    );
  }
});
`;

const NEVER_SETTLING_CALLBACK_ACP = String.raw`
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);"
], { stdio: "ignore" });
process.on("SIGTERM", () => {});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "never-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "never-session",
          update: {
            sessionUpdate: "agent_message",
            content: { type: "text", text: "NEVER" },
            messageId: "never-message"
          }
        }
      })
      + "\n"
      + JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { stopReason: "end_turn" }
      })
      + "\n"
    );
    if (process.argv[1] === "exit") setTimeout(() => process.exit(0), 25);
  }
});
`;

const PUBLIC_CALLBACK_ACP = String.raw`
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const mode = process.argv[1];
const healthyText = process.argv[2];
if (mode === "permission") {
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "public-callback-session" } });
    return;
  }
  if (message.method === "session/prompt" && mode === "permission") {
    send({
      jsonrpc: "2.0",
      id: 801,
      method: "session/request_permission",
      params: {
        sessionId: "public-callback-session",
        title: "Run the controlled callback fixture?",
        toolCall: { title: "Controlled fixture", kind: "execute" },
        options: [
          { optionId: "allow-once", name: "Allow", kind: "allow_once" },
          { optionId: "reject-once", name: "Deny", kind: "reject_once" }
        ]
      }
    });
    return;
  }
  if (message.method === "session/prompt") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "public-callback-session",
          update: {
            sessionUpdate: "agent_message",
            content: { type: "text", text: healthyText },
            messageId: "healthy-public-message"
          }
        }
      })
      + "\n"
      + JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { stopReason: "end_turn" }
      })
      + "\n"
    );
  }
});
`;

const DETACHED_QUEUE_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
process.on("SIGUSR1", () => process.exit(0));
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "detached-queue-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    const permission = (id, title) => ({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId: "detached-queue-session",
        title,
        options: [
          { optionId: "allow-" + id, name: "Allow", kind: "allow_once" },
          { optionId: "reject-" + id, name: "Deny", kind: "reject_once" }
        ]
      }
    });
    process.stdout.write(
      JSON.stringify(permission(901, "First controlled permission"))
      + "\n"
      + JSON.stringify(permission(902, "Second controlled permission"))
      + "\n"
    );
  }
});
`;

const RECOVERY_PERMISSION_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let sessionId = "recovery-permission-session";
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    sessionId = "recovery-permission-session";
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    return;
  }
  if (message.method === "session/load") {
    sessionId = message.params.sessionId;
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      id: 903,
      method: "session/request_permission",
      params: {
        sessionId,
        title: "Fresh client permission",
        options: [
          { optionId: "allow-fresh", name: "Allow", kind: "allow_once" },
          { optionId: "reject-fresh", name: "Deny", kind: "reject_once" }
        ]
      }
    });
  }
});
`;

async function within<T>(promise: Promise<T>, milliseconds = 500): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("ACP operation stayed pending")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForFile(file: string, milliseconds = 500): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error("timed out waiting for controlled child receipt");
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

type CallbackPublicBot = {
  id: string;
  write: boolean;
  needsYou?: {
    reason?: string;
    eventId?: string;
    cardId?: string;
  } | null;
  permission?: unknown;
  messages: Array<{
    id: string;
    role?: string;
    text?: string;
    card?: {
      kind?: string;
      body?: string;
      actions?: Array<{ label?: string }>;
      status?: { tone?: string; label?: string };
    };
  }>;
};

async function createBot(box: RunningBox, cookie: string, name: string): Promise<string> {
  const created = await fetch(`${box.url}/api/bots`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name }),
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

async function getBot(box: RunningBox, cookie: string, botId: string): Promise<CallbackPublicBot> {
  const response = await fetch(`${box.url}/api/bots/${botId}`, { headers: { cookie } });
  assert.equal(response.status, 200);
  return (await response.json()) as CallbackPublicBot;
}

async function waitForBot(
  box: RunningBox,
  cookie: string,
  botId: string,
  predicate: (bot: CallbackPublicBot) => boolean,
): Promise<CallbackPublicBot> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    const bot = await getBot(box, cookie, botId);
    if (predicate(bot)) return bot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for public Bot state");
}

async function resolveComputerHelp(
  box: RunningBox,
  cookie: string,
  botId: string,
  cardId: string,
  eventId: string,
): Promise<Response> {
  return fetch(`${box.url}/api/bots/${botId}/cards/${cardId}/needs-you`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ eventId, resolution: "done" }),
  });
}

function client(source: string, terminateGraceMs = 25): AcpClient {
  return new AcpClient({
    command: process.execPath,
    args: ["-e", source],
    env: { ...process.env },
  }, process.cwd(), {}, { startDeadlineMs: 250, terminateGraceMs });
}

function clientWithArgs(source: string, args: string[]): AcpClient {
  return new AcpClient({
    command: process.execPath,
    args: ["-e", source, ...args],
    env: { ...process.env },
  }, process.cwd(), {}, { startDeadlineMs: 250, terminateGraceMs: 25 });
}

function clientWithHandlers(source: string, handlers: AcpHandlers): AcpClient {
  return new AcpClient({
    command: process.execPath,
    args: ["-e", source],
    env: { ...process.env },
  }, process.cwd(), handlers, { startDeadlineMs: 250, terminateGraceMs: 25 });
}

describe("AcpClient callback containment", () => {
  test("contains a synchronous permission callback failure and permits a fresh client", async () => {
    const uncaught: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUncaught = (error: unknown) => { uncaught.push(error); };
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandled);

    const broken = client(PERMISSION_CALLBACK_ACP);
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      await within(broken.initialize());
      await within(broken.newSession(process.cwd()));
      await assert.rejects(
        within(broken.prompt("contain the callback", {
          onPermission() {
            throw new Error("PRIVATE-PERMISSION-CALLBACK");
          },
        })),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport callback failed");
          assert.doesNotMatch(String(error), /PRIVATE-PERMISSION-CALLBACK/);
          return true;
        },
      );
      await waitForProcessGroupGone(groupId);
      assert.deepEqual(uncaught, []);
      assert.deepEqual(unhandled, []);
    } finally {
      broken.close();
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandled);
      await waitForProcessGroupGone(groupId);
    }

    const fresh = client(HEALTHY_ACP);
    try {
      assert.deepEqual(await within(fresh.initialize()), { authMethods: [] });
      assert.equal(await within(fresh.newSession(process.cwd())), "fresh-session");
      assert.equal(await within(fresh.prompt("retry on a fresh client")), "");
    } finally {
      fresh.close();
      if (fresh.pid) await waitForProcessGroupGone(fresh.pid);
    }
  });

  test("lets a returned permission rejection beat a terminal response from the same child write", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);

    const broken = client(PERMISSION_CALLBACK_ACP);
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      await within(broken.initialize());
      await within(broken.newSession(process.cwd()));
      await assert.rejects(
        within(broken.prompt("order callback before terminal", {
          async onPermission() {
            await new Promise((resolve) => setImmediate(resolve));
            throw new Error("PRIVATE-ASYNC-PERMISSION-CALLBACK");
          },
        })),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport callback failed");
          assert.doesNotMatch(String(error), /PRIVATE-ASYNC-PERMISSION-CALLBACK/);
          return true;
        },
      );
      await waitForProcessGroupGone(groupId);
      assert.deepEqual(unhandled, []);
    } finally {
      broken.close();
      process.off("unhandledRejection", onUnhandled);
      await waitForProcessGroupGone(groupId);
    }
  });

  test("allows a serialized permission handler to await its own confirmed response", async () => {
    const live = client(PERMISSION_CALLBACK_ACP);
    const groupId = live.pid;
    assert.ok(groupId);
    try {
      await within(live.initialize());
      await within(live.newSession(process.cwd()));
      const reply = await within(live.prompt("confirm inside callback", {
        onPermission(prompt) {
          return live.respondPermission(prompt.rpcId, "allow-once");
        },
      }));
      assert.equal(reply, "");
    } finally {
      live.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("contains an assistant callback throw from a complete child update", async () => {
    const broken = clientWithArgs(ASSISTANT_CALLBACK_ACP, ["complete"]);
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      await within(broken.initialize());
      await within(broken.newSession(process.cwd()));
      await assert.rejects(
        within(broken.prompt("contain assistant delivery", {
          onAssistant() {
            throw new Error("PRIVATE-ASSISTANT-CALLBACK");
          },
        })),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport callback failed");
          assert.doesNotMatch(String(error), /PRIVATE-ASSISTANT/);
          return true;
        },
      );
      await waitForProcessGroupGone(groupId);
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("contains an assistant callback throw while finalizing a streamed message", async () => {
    const broken = clientWithArgs(ASSISTANT_CALLBACK_ACP, ["stream"]);
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      await within(broken.initialize());
      await within(broken.newSession(process.cwd()));
      await assert.rejects(
        within(broken.prompt("contain streaming finalization", {
          onAssistant() {
            throw new Error("PRIVATE-STREAMING-CALLBACK");
          },
        })),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport callback failed");
          assert.doesNotMatch(String(error), /PRIVATE-STREAMING-CALLBACK/);
          return true;
        },
      );
      await waitForProcessGroupGone(groupId);
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("contains a prompt-written callback throw inside the existing handoff phase", async () => {
    const broken = client(HEALTHY_ACP);
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      await within(broken.initialize());
      await within(broken.newSession(process.cwd()));
      await assert.rejects(
        within(broken.prompt("contain prompt-written", {
          onPromptWritten() {
            throw new Error("PRIVATE-PROMPT-WRITTEN-CALLBACK");
          },
        })),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport callback failed");
          assert.doesNotMatch(String(error), /PRIVATE-PROMPT-WRITTEN-CALLBACK/);
          return true;
        },
      );
      await waitForProcessGroupGone(groupId);
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("contains a returned prompt-flushed rejection inside the existing handoff phase", async () => {
    const broken = client(HEALTHY_ACP);
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      await within(broken.initialize());
      await within(broken.newSession(process.cwd()));
      await assert.rejects(
        within(broken.prompt("contain prompt-flushed", {
          async onPromptFlushed() {
            await new Promise((resolve) => setImmediate(resolve));
            throw new Error("PRIVATE-PROMPT-FLUSHED-CALLBACK");
          },
        })),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport callback failed");
          assert.doesNotMatch(String(error), /PRIVATE-PROMPT-FLUSHED-CALLBACK/);
          return true;
        },
      );
      await waitForProcessGroupGone(groupId);
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("contains a stderr callback throw without exposing the child line", async () => {
    let callbackCalls = 0;
    const broken = clientWithHandlers(STDERR_CALLBACK_ACP, {
      onStderr() {
        callbackCalls += 1;
        throw new Error("PRIVATE-STDERR-CALLBACK");
      },
    });
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      await within(broken.initialize());
      await within(broken.newSession(process.cwd()));
      await assert.rejects(
        within(broken.prompt("contain stderr delivery")),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport callback failed");
          assert.doesNotMatch(String(error), /PRIVATE-STDERR/);
          return true;
        },
      );
      await waitForProcessGroupGone(groupId);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(callbackCalls, 1);
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("contains a Computer-help callback throw after claiming the server request", async () => {
    const broken = client(COMPUTER_HELP_CALLBACK_ACP);
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      await within(broken.initialize());
      await within(broken.newSession(process.cwd()));
      await assert.rejects(
        within(broken.prompt("contain Computer-help", {
          onComputerHelp() {
            throw new Error("PRIVATE-COMPUTER-HELP-CALLBACK");
          },
        })),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport callback failed");
          assert.doesNotMatch(String(error), /PRIVATE-COMPUTER-HELP-CALLBACK/);
          return true;
        },
      );
      await waitForProcessGroupGone(groupId);
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("makes a client non-reusable when its normal cancellation callback throws", async () => {
    let resolveHelp!: () => void;
    const help = within(new Promise<void>((resolve) => { resolveHelp = resolve; }));
    const broken = clientWithArgs(COMPUTER_HELP_CALLBACK_ACP, ["pending"]);
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      await within(broken.initialize());
      await within(broken.newSession(process.cwd()));
      const prompting = broken.prompt("cancel Computer-help", {
        onComputerHelp() {
          resolveHelp();
        },
        onComputerHelpCancelled() {
          throw new Error("PRIVATE-CANCELLATION-CALLBACK");
        },
      });
      void prompting.catch(() => undefined);
      await help;
      await new Promise((resolve) => setImmediate(resolve));
      broken.cancel();
      await assert.rejects(within(prompting), /cancel/i);
      await assert.rejects(
        within(broken.initialize()),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport callback failed");
          assert.equal(cancellationClosedTransport(error), true);
          assert.doesNotMatch(String(error), /PRIVATE-CANCELLATION-CALLBACK/);
          return true;
        },
      );
      await waitForProcessGroupGone(groupId);
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("guards rejecting cleanup callbacks across close, child error, stdin error, and exit", async () => {
    const uncaught: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUncaught = (error: unknown) => { uncaught.push(error); };
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandled);

    try {
      for (const origin of ["close", "error", "stdin", "exit"] as const) {
        let resolveHelp!: () => void;
        const help = within(new Promise<void>((resolve) => { resolveHelp = resolve; }));
        let cancellations = 0;
        const broken = clientWithArgs(COMPUTER_HELP_CALLBACK_ACP, ["pending"]);
        const groupId = broken.pid;
        assert.ok(groupId);
        let prompting: Promise<string> | undefined;
        try {
          await within(broken.initialize());
          await within(broken.newSession(process.cwd()));
          prompting = broken.prompt(`cleanup after ${origin}`, {
            onComputerHelp() {
              resolveHelp();
            },
            onComputerHelpCancelled() {
              cancellations += 1;
              return Promise.reject(new Error(`PRIVATE-${origin.toUpperCase()}-CLEANUP`));
            },
          });
          void prompting.catch(() => undefined);
          await help;

          const internals = broken as unknown as {
            child: {
              emit(event: "error", error: Error): boolean;
              stdin: { emit(event: "error", error: Error): boolean };
            };
          };
          if (origin === "close") broken.close();
          if (origin === "error") internals.child.emit("error", new Error("PRIVATE-CHILD-ERROR"));
          if (origin === "stdin") internals.child.stdin.emit("error", new Error("PRIVATE-STDIN-ERROR"));
          if (origin === "exit") process.kill(-groupId, "SIGKILL");

          await assert.rejects(
            within(prompting),
            (error: unknown) => {
              const expected = origin === "close"
                ? "ACP client closed"
                : origin === "exit" ? "ACP child exited" : "ACP transport closed";
              assert.equal((error as Error).message, expected);
              assert.doesNotMatch(String(error), /PRIVATE-/);
              return true;
            },
          );
          await waitForProcessGroupGone(groupId);
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(cancellations, 1);
        } finally {
          if (prompting) await prompting.catch(() => undefined);
          broken.close();
          await waitForProcessGroupGone(groupId);
        }
      }
      assert.deepEqual(uncaught, []);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("lets a prompt-finalization cancellation rejection beat the terminal result", async () => {
    const broken = client(COMPUTER_HELP_CALLBACK_ACP);
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      await within(broken.initialize());
      await within(broken.newSession(process.cwd()));
      await assert.rejects(
        within(broken.prompt("finalize Computer-help", {
          onComputerHelp() {
            // The unresolved request is retired when the child finishes the Turn.
          },
          async onComputerHelpCancelled() {
            await new Promise((resolve) => setImmediate(resolve));
            throw new Error("PRIVATE-FINALIZATION-CALLBACK");
          },
        })),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport callback failed");
          assert.doesNotMatch(String(error), /PRIVATE-FINALIZATION-CALLBACK/);
          return true;
        },
      );
      await waitForProcessGroupGone(groupId);
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("serializes child callbacks before dispatching the next frame or settling terminal", async () => {
    let releaseA!: () => void;
    const aGate = new Promise<void>((resolve) => { releaseA = resolve; });
    let resolveAStarted!: () => void;
    const aStarted = within(new Promise<void>((resolve) => { resolveAStarted = resolve; }));
    const events: string[] = [];
    const uncaught: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUncaught = (error: unknown) => { uncaught.push(error); };
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandled);

    const acp = client(ORDERED_ASSISTANT_CALLBACK_ACP);
    const groupId = acp.pid;
    assert.ok(groupId);
    let prompting: Promise<string> | undefined;
    try {
      await within(acp.initialize());
      await within(acp.newSession(process.cwd()));
      prompting = acp.prompt("preserve callback source order", {
        onAssistant(text) {
          if (text === "A") {
            events.push("A:start");
            resolveAStarted();
            return aGate.then(() => { events.push("A:end"); });
          }
          events.push(`${text}:start`);
        },
      });
      let settled = false;
      void prompting.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      await aStarted;
      await new Promise((resolve) => setImmediate(resolve));
      const beforeRelease = [...events];
      assert.equal(settled, false);
      releaseA();
      assert.equal(await within(prompting), "AB");
      assert.deepEqual(beforeRelease, ["A:start"]);
      assert.deepEqual(events, ["A:start", "A:end", "B:start"]);
      assert.deepEqual(uncaught, []);
      assert.deepEqual(unhandled, []);
    } finally {
      releaseA();
      if (prompting) await prompting.catch(() => undefined);
      acp.close();
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandled);
      await waitForProcessGroupGone(groupId);
    }
  });

  test("detaches a never-settling callback when the Turn is cancelled", async () => {
    let rejectCallback!: (error: Error) => void;
    const callback = new Promise<void>((_resolve, reject) => { rejectCallback = reject; });
    let resolveStarted!: () => void;
    const started = within(new Promise<void>((resolve) => { resolveStarted = resolve; }));
    const uncaught: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUncaught = (error: unknown) => { uncaught.push(error); };
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandled);

    const broken = clientWithArgs(NEVER_SETTLING_CALLBACK_ACP, ["stay"]);
    const groupId = broken.pid;
    assert.ok(groupId);
    let prompting: Promise<string> | undefined;
    try {
      await within(broken.initialize());
      await within(broken.newSession(process.cwd()));
      prompting = broken.prompt("cancel blocked callback", {
        onAssistant() {
          resolveStarted();
          return callback;
        },
      });
      void prompting.catch(() => undefined);
      await started;
      assert.equal(broken.cancel(), false);
      await assert.rejects(
        within(prompting),
        (error: unknown) => {
          assert.equal(isCancelled(error), true);
          assert.equal(cancellationClosedTransport(error), true);
          return true;
        },
      );
      await waitForProcessGroupGone(groupId);
      rejectCallback(new Error("PRIVATE-LATE-CANCELLED-CALLBACK"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(uncaught, []);
      assert.deepEqual(unhandled, []);
    } finally {
      rejectCallback(new Error("PRIVATE-LATE-CANCELLED-CLEANUP"));
      if (prompting) await prompting.catch(() => undefined);
      broken.close();
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandled);
      await waitForProcessGroupGone(groupId);
    }
  });

  test("detaches a never-settling callback when the child exits", async () => {
    let rejectCallback!: (error: Error) => void;
    const callback = new Promise<void>((_resolve, reject) => { rejectCallback = reject; });
    let resolveStarted!: () => void;
    const started = within(new Promise<void>((resolve) => { resolveStarted = resolve; }));
    const uncaught: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUncaught = (error: unknown) => { uncaught.push(error); };
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandled);

    const broken = clientWithArgs(NEVER_SETTLING_CALLBACK_ACP, ["exit"]);
    const groupId = broken.pid;
    assert.ok(groupId);
    let prompting: Promise<string> | undefined;
    try {
      await within(broken.initialize());
      await within(broken.newSession(process.cwd()));
      prompting = broken.prompt("exit during blocked callback", {
        onAssistant() {
          resolveStarted();
          return callback;
        },
      });
      void prompting.catch(() => undefined);
      await started;
      await assert.rejects(within(prompting), /ACP child exited/);
      await waitForProcessGroupGone(groupId);
      rejectCallback(new Error("PRIVATE-LATE-EXIT-CALLBACK"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(uncaught, []);
      assert.deepEqual(unhandled, []);
    } finally {
      rejectCallback(new Error("PRIVATE-LATE-EXIT-CLEANUP"));
      if (prompting) await prompting.catch(() => undefined);
      broken.close();
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandled);
      await waitForProcessGroupGone(groupId);
    }
  });

  test("invalidates after a flushed Computer-help response callback rejects", async () => {
    let resolveHelp!: (rpcId: string | number) => void;
    const help = within(new Promise<string | number>((resolve) => { resolveHelp = resolve; }));
    const uncaught: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUncaught = (error: unknown) => { uncaught.push(error); };
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandled);

    const broken = clientWithArgs(COMPUTER_HELP_CALLBACK_ACP, ["pending"]);
    const groupId = broken.pid;
    assert.ok(groupId);
    let prompting: Promise<string> | undefined;
    try {
      await within(broken.initialize());
      await within(broken.newSession(process.cwd()));
      prompting = broken.prompt("flush Computer-help response", {
        onComputerHelp(prompt) {
          resolveHelp(prompt.rpcId);
        },
      });
      void prompting.catch(() => undefined);
      const rpcId = await help;
      await assert.rejects(
        within(broken.respondComputerHelp(rpcId, "done", async () => {
          await new Promise((resolve) => setImmediate(resolve));
          throw new Error("PRIVATE-POST-FLUSH-CALLBACK");
        })),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport callback failed");
          assert.equal(computerHelpResponseWasFlushed(error), true);
          assert.doesNotMatch(String(error), /PRIVATE-POST-FLUSH-CALLBACK/);
          return true;
        },
      );
      await assert.rejects(
        within(prompting),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport callback failed");
          assert.equal(computerHelpResponseWasFlushed(error), true);
          return true;
        },
      );
      await assert.rejects(
        broken.respondComputerHelp(rpcId, "done"),
        /no longer active/,
      );
      await waitForProcessGroupGone(groupId);
      assert.deepEqual(uncaught, []);
      assert.deepEqual(unhandled, []);
    } finally {
      if (prompting) await prompting.catch(() => undefined);
      broken.close();
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandled);
      await waitForProcessGroupGone(groupId);
    }
  });

  test("keeps one public unconfirmed Card when the local post-flush commit callback fails", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-post-flush-home-"));
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-post-flush-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const clients: AcpClient[] = [];
    const pids: number[] = [];
    const spawnAcp = (
      _spec: SpawnSpec,
      cwd: string,
      handlers: AcpHandlers = {},
    ) => {
      const real = new AcpClient({
        command: process.execPath,
        args: ["-e", COMPUTER_HELP_CALLBACK_ACP, "pending"],
        env: { ...process.env },
      }, cwd, handlers, { startDeadlineMs: 250, terminateGraceMs: 25 });
      const respond = real.respondComputerHelp.bind(real);
      real.respondComputerHelp = (rpcId, resolution) => respond(
        rpcId,
        resolution,
        () => { throw new Error("PRIVATE-LOCAL-CARD-COMMIT"); },
      );
      if (real.pid) pids.push(real.pid);
      clients.push(real);
      return real;
    };
    const uncaught: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUncaught = (error: unknown) => { uncaught.push(error); };
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandled);

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
      const botId = await createBot(box, cookie, "Ada");
      const sent = await fetch(`${box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Need controlled Computer help." }),
      });
      assert.equal(sent.status, 200);
      const pending = await waitForBot(
        box,
        cookie,
        botId,
        (bot) => bot.needsYou?.reason === "computer-help",
      );
      const { cardId, eventId } = pending.needsYou ?? {};
      assert.equal(typeof cardId, "string");
      assert.equal(typeof eventId, "string");

      const resolved = await resolveComputerHelp(box, cookie, botId, cardId!, eventId!);
      assert.equal(resolved.status, 409);
      const responseText = await resolved.text();
      assert.match(responseText, /sent.*could not confirm/i);
      assert.doesNotMatch(responseText, /PRIVATE-|ACP transport callback failed|ACP_CALLBACK_FAILED/);

      const unconfirmed = await waitForBot(box, cookie, botId, (bot) => (
        bot.write === false
        && bot.needsYou === null
        && bot.messages.some((message) => (
          message.id === cardId
          && message.card?.status?.label === "No longer available"
        ))
      ));
      const cards = unconfirmed.messages.filter((message) => message.card?.kind === "computer");
      assert.equal(cards.length, 1);
      assert.equal(cards[0]?.id, cardId);
      assert.deepEqual(cards[0]?.card?.status, { tone: "neutral", label: "No longer available" });
      assert.equal(
        cards[0]?.card?.body,
        "OpenBot sent your response but could not confirm this request's final state.",
      );
      assert.deepEqual(cards[0]?.card?.actions?.map((action) => action.label), ["Open computer"]);
      assert.equal(unconfirmed.messages.filter((message) => message.card?.kind === "bot-failure").length, 0);
      assert.doesNotMatch(
        JSON.stringify(unconfirmed),
        /PRIVATE-|ACP transport callback failed|ACP_CALLBACK_FAILED|node:|\/Users\//,
      );

      const duplicate = await resolveComputerHelp(box, cookie, botId, cardId!, eventId!);
      assert.equal(duplicate.status, 409);
      assert.ok(pids[0]);
      await waitForProcessGroupGone(pids[0]);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(uncaught, []);
      assert.deepEqual(unhandled, []);
    } finally {
      for (const client of clients) client.close();
      for (const pid of pids) await waitForProcessGroupGone(pid);
      await box.close();
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandled);
      await rm(homeDir, { recursive: true, force: true });
      await rm(pwaDir, { recursive: true, force: true });
    }
  });

  test("marks a flushed Computer-help response when an earlier queued callback fails first", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-flush-race-home-"));
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-flush-race-pwa-"));
    const raceDir = await mkdtemp(join(tmpdir(), "openbot-flush-race-fixture-"));
    const triggerFile = join(raceDir, "trigger");
    const receiptFile = join(raceDir, "receipt");
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    let resolveCallbackStarted!: () => void;
    const callbackStarted = within(new Promise<void>((resolve) => { resolveCallbackStarted = resolve; }));
    let rejectCallback!: (error: Error) => void;
    const blockedCallback = new Promise<void>((_resolve, reject) => { rejectCallback = reject; });
    const clients: AcpClient[] = [];
    const pids: number[] = [];
    const spawnAcp = (
      _spec: SpawnSpec,
      cwd: string,
      handlers: AcpHandlers = {},
    ) => {
      const real = new AcpClient({
        command: process.execPath,
        args: ["-e", COMPUTER_HELP_FLUSH_RACE_ACP, triggerFile, receiptFile],
        env: { ...process.env },
      }, cwd, handlers, { startDeadlineMs: 250, terminateGraceMs: 25 });
      const prompt = real.prompt.bind(real);
      real.prompt = (text, promptHandlers = {}) => prompt(text, {
        ...promptHandlers,
        onAssistant(assistantText, delta) {
          const applied = promptHandlers.onAssistant?.(assistantText, delta);
          resolveCallbackStarted();
          return Promise.resolve(applied).then(() => blockedCallback);
        },
      });
      if (real.pid) pids.push(real.pid);
      clients.push(real);
      return real;
    };
    const uncaught: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUncaught = (error: unknown) => { uncaught.push(error); };
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandled);

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
      const botId = await createBot(box, cookie, "Ada");
      const sent = await fetch(`${box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Exercise the controlled flush race." }),
      });
      assert.equal(sent.status, 200);
      const pending = await waitForBot(
        box,
        cookie,
        botId,
        (bot) => bot.needsYou?.reason === "computer-help",
      );
      const { cardId, eventId } = pending.needsYou ?? {};
      assert.equal(typeof cardId, "string");
      assert.equal(typeof eventId, "string");

      await writeFile(triggerFile, "1", { mode: 0o600 });
      await callbackStarted;
      const resolving = resolveComputerHelp(box, cookie, botId, cardId!, eventId!);
      void resolving.catch(() => undefined);
      await waitForFile(receiptFile);
      assert.equal(await readFile(receiptFile, "utf8"), "1");
      rejectCallback(new Error("PRIVATE-EARLIER-CALLBACK-C"));

      const response = await within(resolving);
      assert.equal(response.status, 409);
      const responseText = await response.text();
      assert.match(responseText, /sent.*could not confirm/i);
      assert.doesNotMatch(responseText, /PRIVATE-|ACP transport callback failed|ACP_CALLBACK_FAILED/);

      const unconfirmed = await waitForBot(box, cookie, botId, (bot) => (
        bot.write === false
        && bot.needsYou === null
        && bot.messages.some((message) => (
          message.id === cardId
          && message.card?.status?.label === "No longer available"
        ))
        && bot.messages.every((message) => message.card?.kind !== "bot-failure")
      ));
      const cards = unconfirmed.messages.filter((message) => message.card?.kind === "computer");
      assert.equal(cards.length, 1);
      assert.equal(cards[0]?.id, cardId);
      assert.deepEqual(cards[0]?.card?.status, { tone: "neutral", label: "No longer available" });
      assert.deepEqual(cards[0]?.card?.actions?.map((action) => action.label), ["Open computer"]);
      assert.doesNotMatch(
        JSON.stringify(unconfirmed),
        /PRIVATE-|ACP transport callback failed|ACP_CALLBACK_FAILED|node:|\/Users\//,
      );

      const duplicate = await resolveComputerHelp(box, cookie, botId, cardId!, eventId!);
      assert.equal(duplicate.status, 409);
      assert.equal(await readFile(receiptFile, "utf8"), "1");
      assert.ok(pids[0]);
      await waitForProcessGroupGone(pids[0]);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(uncaught, []);
      assert.deepEqual(unhandled, []);
    } finally {
      rejectCallback(new Error("PRIVATE-FLUSH-RACE-CLEANUP"));
      for (const client of clients) client.close();
      for (const pid of pids) await waitForProcessGroupGone(pid);
      await box.close();
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandled);
      await rm(homeDir, { recursive: true, force: true });
      await rm(pwaDir, { recursive: true, force: true });
      await rm(raceDir, { recursive: true, force: true });
    }
  });

  test("advances a stuck BotStore queue generation so a fresh client can publish permission state", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-detached-queue-home-"));
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-detached-queue-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    let resolveBlockedResponse!: () => void;
    const blockedResponse = new Promise<void>((resolve) => { resolveBlockedResponse = resolve; });
    let resolveBlockedStarted!: () => void;
    const blockedStarted = within(new Promise<void>((resolve) => { resolveBlockedStarted = resolve; }));
    const clients: AcpClient[] = [];
    const pids: number[] = [];
    let spawned = 0;
    const spawnAcp = (
      _spec: SpawnSpec,
      cwd: string,
      handlers: AcpHandlers = {},
    ) => {
      spawned += 1;
      const first = spawned === 1;
      const real = new AcpClient({
        command: process.execPath,
        args: ["-e", first ? DETACHED_QUEUE_ACP : RECOVERY_PERMISSION_ACP],
        env: { ...process.env },
      }, cwd, handlers, { startDeadlineMs: 250, terminateGraceMs: 25 });
      if (first) {
        real.respondPermission = () => {
          resolveBlockedStarted();
          assert.ok(real.pid);
          process.kill(real.pid, "SIGUSR1");
          return blockedResponse;
        };
      }
      if (real.pid) pids.push(real.pid);
      clients.push(real);
      return real;
    };
    const uncaught: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUncaught = (error: unknown) => { uncaught.push(error); };
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandled);

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
      const botId = await createBot(box, cookie, "Ada");
      const sent = await fetch(`${box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Detach one stuck permission queue." }),
      });
      assert.equal(sent.status, 200);
      await blockedStarted;
      const blocked = await getBot(box, cookie, botId);
      const oldPermissionCard = blocked.messages.find((message) => message.card?.kind === "permission");
      assert.ok(oldPermissionCard);
      const failed = await waitForBot(box, cookie, botId, (bot) => (
        bot.write === false
        && bot.messages.some((message) => message.card?.kind === "bot-failure")
      ));
      const failure = failed.messages.find((message) => message.card?.kind === "bot-failure");
      assert.ok(failure);
      const stalePermissionCard = failed.messages.find((message) => message.id === oldPermissionCard.id);
      assert.equal(stalePermissionCard?.card?.kind, "permission");
      assert.deepEqual(stalePermissionCard?.card?.actions, []);
      assert.equal(failed.permission, null);
      assert.ok(pids[0]);
      await waitForProcessGroupGone(pids[0]);

      const retried = await fetch(`${box.url}/api/bots/${botId}/cards/${failure.id}/retry`, {
        method: "POST",
        headers: { cookie },
      });
      assert.equal(retried.status, 200);
      const recovered = await waitForBot(box, cookie, botId, (bot) => (
        Boolean(bot.permission)
        && bot.messages.some((message) => (
          message.card?.kind === "permission"
          && (message.card.actions?.length ?? 0) > 0
        ))
      ));
      assert.equal(spawned, 2);
      const freshPermissionCard = recovered.messages.find((message) => (
        message.card?.kind === "permission"
        && (message.card.actions?.length ?? 0) > 0
      ));
      assert.ok(freshPermissionCard);
      assert.notEqual(freshPermissionCard.id, oldPermissionCard.id);
      assert.deepEqual(
        recovered.messages.find((message) => message.id === oldPermissionCard.id)?.card?.actions,
        [],
      );
      assert.equal(
        recovered.messages.filter((message) => (
          message.card?.kind === "permission"
          && (message.card.actions?.length ?? 0) > 0
        )).length,
        1,
      );

      resolveBlockedResponse();
      await new Promise((resolve) => setImmediate(resolve));
      const afterLateSettlement = await getBot(box, cookie, botId);
      assert.ok(afterLateSettlement.permission);
      assert.deepEqual(
        afterLateSettlement.messages.find((message) => message.id === oldPermissionCard.id)?.card?.actions,
        [],
      );
      assert.equal(
        afterLateSettlement.messages.find((message) => message.id === freshPermissionCard.id)?.card?.actions?.length,
        2,
      );
      assert.equal(
        afterLateSettlement.messages.filter((message) => (
          message.card?.kind === "permission"
          && (message.card.actions?.length ?? 0) > 0
        )).length,
        1,
      );
      assert.doesNotMatch(
        JSON.stringify(afterLateSettlement),
        /PRIVATE-|ACP transport callback failed|ACP_CALLBACK_FAILED|node:|\/Users\//,
      );
      assert.deepEqual(uncaught, []);
      assert.deepEqual(unhandled, []);
    } finally {
      resolveBlockedResponse();
      for (const client of clients) client.close();
      for (const pid of pids) await waitForProcessGroupGone(pid);
      await box.close();
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandled);
      await rm(homeDir, { recursive: true, force: true });
      await rm(pwaDir, { recursive: true, force: true });
    }
  });

  test("rotates a blocked BotStore queue on intentional replacement without a failure Card", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-replaced-queue-home-"));
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-replaced-queue-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    let resolveBlockedResponse!: () => void;
    const blockedResponse = new Promise<void>((resolve) => { resolveBlockedResponse = resolve; });
    let resolveBlockedStarted!: () => void;
    const blockedStarted = within(new Promise<void>((resolve) => { resolveBlockedStarted = resolve; }));
    const clients: AcpClient[] = [];
    const pids: number[] = [];
    let spawned = 0;
    const spawnAcp = (
      _spec: SpawnSpec,
      cwd: string,
      handlers: AcpHandlers = {},
    ) => {
      spawned += 1;
      const first = spawned === 1;
      const real = new AcpClient({
        command: process.execPath,
        args: ["-e", first ? DETACHED_QUEUE_ACP : RECOVERY_PERMISSION_ACP],
        env: { ...process.env },
      }, cwd, handlers, { startDeadlineMs: 250, terminateGraceMs: 25 });
      if (first) {
        real.respondPermission = () => {
          resolveBlockedStarted();
          return blockedResponse;
        };
      }
      if (real.pid) pids.push(real.pid);
      clients.push(real);
      return real;
    };
    const uncaught: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUncaught = (error: unknown) => { uncaught.push(error); };
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandled);

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
      const botId = await createBot(box, cookie, "Ada");
      const first = await fetch(`${box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Block the old permission queue." }),
      });
      assert.equal(first.status, 200);
      await blockedStarted;
      const blocked = await getBot(box, cookie, botId);
      const oldPermissionCard = blocked.messages.find((message) => message.card?.kind === "permission");
      assert.ok(oldPermissionCard);

      const replacement = await within(fetch(`${box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Replace the blocked queue intentionally." }),
      }));
      assert.equal(replacement.status, 200);
      const recovered = await waitForBot(box, cookie, botId, (bot) => (
        Boolean(bot.permission)
        && bot.messages.some((message) => (
          message.id !== oldPermissionCard.id
          && message.card?.kind === "permission"
          && (message.card.actions?.length ?? 0) > 0
        ))
      ));
      const freshPermissionCard = recovered.messages.find((message) => (
        message.id !== oldPermissionCard.id
        && message.card?.kind === "permission"
        && (message.card.actions?.length ?? 0) > 0
      ));
      assert.ok(freshPermissionCard);
      assert.equal(spawned, 2);
      assert.deepEqual(
        recovered.messages.find((message) => message.id === oldPermissionCard.id)?.card?.actions,
        [],
      );
      assert.equal(recovered.messages.filter((message) => message.card?.kind === "bot-failure").length, 0);
      assert.equal(
        recovered.messages.filter((message) => message.text === "Block the old permission queue.").length,
        1,
      );
      assert.equal(
        recovered.messages.filter((message) => message.text === "Replace the blocked queue intentionally.").length,
        1,
      );

      resolveBlockedResponse();
      await new Promise((resolve) => setImmediate(resolve));
      const afterLateSettlement = await getBot(box, cookie, botId);
      assert.deepEqual(
        afterLateSettlement.messages.find((message) => message.id === oldPermissionCard.id)?.card?.actions,
        [],
      );
      assert.equal(
        afterLateSettlement.messages.find((message) => message.id === freshPermissionCard.id)?.card?.actions?.length,
        2,
      );
      assert.equal(
        afterLateSettlement.messages.filter((message) => message.card?.kind === "bot-failure").length,
        0,
      );
      assert.doesNotMatch(
        JSON.stringify(afterLateSettlement),
        /PRIVATE-|ACP transport callback failed|ACP_CALLBACK_FAILED|node:|\/Users\//,
      );
      assert.ok(pids[0]);
      await waitForProcessGroupGone(pids[0]);
      assert.deepEqual(uncaught, []);
      assert.deepEqual(unhandled, []);
    } finally {
      resolveBlockedResponse();
      for (const client of clients) client.close();
      for (const pid of pids) await waitForProcessGroupGone(pid);
      await box.close();
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandled);
      await rm(homeDir, { recursive: true, force: true });
      await rm(pwaDir, { recursive: true, force: true });
    }
  });

  test("contains one Bot callback failure while another Bot lives and retry uses a fresh client", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-callback-home-"));
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-callback-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const spawnCounts = new Map<string, number>();
    const pids: number[] = [];
    const clients: AcpClient[] = [];
    let failingCwd: string | null = null;
    let queuePromiseObserved = false;
    let queueSettledBeforeFailure = false;
    const spawnAcp = (
      _spec: SpawnSpec,
      cwd: string,
      handlers: AcpHandlers = {},
    ) => {
      if (failingCwd === null) failingCwd = cwd;
      const attempt = (spawnCounts.get(cwd) ?? 0) + 1;
      spawnCounts.set(cwd, attempt);
      const failing = cwd === failingCwd && attempt === 1;
      const client = new AcpClient({
        command: process.execPath,
        args: [
          "-e",
          PUBLIC_CALLBACK_ACP,
          failing ? "permission" : "healthy",
          cwd === failingCwd
            ? "Recovered on a fresh callback client."
            : "Unrelated Bot stayed alive.",
        ],
        env: { ...process.env },
      }, cwd, handlers, { startDeadlineMs: 250, terminateGraceMs: 25 });
      if (failing) {
        const prompt = client.prompt.bind(client);
        client.prompt = (text, promptHandlers = {}) => prompt(text, {
          ...promptHandlers,
          onPermission(permission) {
            const queued = promptHandlers.onPermission?.(permission);
            if (!queued || typeof (queued as Promise<void>).then !== "function") {
              throw new Error("PRIVATE-PERMISSION-QUEUE-NOT-RETURNED");
            }
            queuePromiseObserved = true;
            return Promise.resolve(queued).then(() => {
              queueSettledBeforeFailure = true;
              throw new Error("PRIVATE-BOT-CALLBACK-FAILURE");
            });
          },
        });
      }
      if (client.pid) pids.push(client.pid);
      clients.push(client);
      return client;
    };
    const uncaught: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUncaught = (error: unknown) => { uncaught.push(error); };
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandled);

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
      const failingBotId = await createBot(box, cookie, "Ada");
      const healthyBotId = await createBot(box, cookie, "Grace");

      const failingSend = await fetch(`${box.url}/api/bots/${failingBotId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Trigger one contained callback." }),
      });
      assert.equal(failingSend.status, 200);
      const healthySend = await fetch(`${box.url}/api/bots/${healthyBotId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Stay available." }),
      });
      assert.equal(healthySend.status, 200);

      const failed = await waitForBot(box, cookie, failingBotId, (bot) => (
        bot.write === false
        && bot.messages.some((message) => message.card?.kind === "bot-failure")
      ));
      const healthy = await waitForBot(box, cookie, healthyBotId, (bot) => (
        bot.write === false
        && bot.messages.some((message) => message.text === "Unrelated Bot stayed alive.")
      ));
      assert.equal(queuePromiseObserved, true);
      assert.equal(queueSettledBeforeFailure, true);
      assert.equal(failed.messages.filter((message) => message.text === "Trigger one contained callback.").length, 1);
      assert.equal(failed.messages.filter((message) => message.card?.kind === "bot-failure").length, 1);
      assert.equal(
        failed.messages.filter((message) => message.card?.kind === "permission" && (message.card.actions?.length ?? 0) > 0).length,
        0,
      );
      assert.equal(healthy.messages.filter((message) => message.text === "Stay available.").length, 1);
      assert.equal(healthy.messages.filter((message) => message.text === "Unrelated Bot stayed alive.").length, 1);
      assert.equal(healthy.messages.filter((message) => message.card?.kind === "bot-failure").length, 0);
      assert.doesNotMatch(
        JSON.stringify(failed),
        /PRIVATE-|ACP transport callback failed|ACP_CALLBACK_FAILED|node:|\/Users\//,
      );
      assert.ok(failingCwd);
      assert.equal(spawnCounts.get(failingCwd), 1);
      assert.ok(pids[0]);
      await waitForProcessGroupGone(pids[0]);

      const failure = failed.messages.find((message) => message.card?.kind === "bot-failure");
      assert.ok(failure);
      const retried = await fetch(`${box.url}/api/bots/${failingBotId}/cards/${failure.id}/retry`, {
        method: "POST",
        headers: { cookie },
      });
      assert.equal(retried.status, 200);
      const recovered = await waitForBot(box, cookie, failingBotId, (bot) => (
        bot.write === false
        && bot.messages.some((message) => message.text === "Recovered on a fresh callback client.")
      ));
      assert.equal(spawnCounts.get(failingCwd), 2);
      assert.equal(recovered.messages.filter((message) => message.text === "Trigger one contained callback.").length, 2);
      assert.equal(recovered.messages.filter((message) => message.text === "Recovered on a fresh callback client.").length, 1);
      assert.equal(recovered.messages.filter((message) => message.card?.kind === "bot-failure").length, 1);
      assert.equal(
        recovered.messages.filter((message) => message.card?.kind === "permission" && (message.card.actions?.length ?? 0) > 0).length,
        0,
      );
      assert.deepEqual(uncaught, []);
      assert.deepEqual(unhandled, []);
    } finally {
      for (const client of clients) client.close();
      for (const pid of pids) await waitForProcessGroupGone(pid);
      await new Promise((resolve) => setImmediate(resolve));
      await box.close();
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandled);
      await rm(homeDir, { recursive: true, force: true });
      await rm(pwaDir, { recursive: true, force: true });
    }
  });
});
