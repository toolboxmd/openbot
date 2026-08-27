import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  AcpClient,
  cancellationClosedTransport,
  type AcpHandlers,
} from "../src/acp.ts";
import { BotStore } from "../src/bots.ts";
import { startBox, type RunningBox } from "../src/box.ts";
import { HomeStore } from "../src/home.ts";
import type { SpawnSpec } from "../src/harness.ts";

const SILENT_ACP = String.raw`
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", () => {});
`;

const TERM_IGNORING_ACP = String.raw`
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", () => {});
process.on("SIGTERM", () => process.stderr.write("ignored\n"));
setInterval(() => {}, 1_000);
process.stderr.write("ready\n");
`;

const TERM_IGNORING_PROCESS_TREE_ACP = String.raw`
const { spawn } = require("node:child_process");
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", () => {});
const grandchild = spawn(process.execPath, [
  "-e",
  'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);'
], { stdio: "ignore" });
process.stderr.write("grandchild:" + grandchild.pid + "\n");
setInterval(() => {}, 1_000);
`;

const SILENT_SESSION_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
  }
});
`;

const SLOW_INITIALIZE_THEN_SILENT_SESSION_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    setTimeout(() => {
      send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    }, 50);
  }
});
`;

const NON_READING_PROMPT_ACP = String.raw`
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
    input.pause();
    setInterval(() => {}, 1_000);
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "blocked-session" } });
  }
});
`;

const LONG_RUNNING_ACP = String.raw`
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "long-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    setTimeout(() => {
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }, 800);
  }
});
`;

const LATE_AFTER_TIMEOUT_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let initializeId = null;
input.once("line", (line) => {
  initializeId = JSON.parse(line).id;
});
process.on("SIGTERM", () => {
  setTimeout(() => {
    send({ jsonrpc: "2.0", id: initializeId, result: { authMethods: [] } });
    setTimeout(() => process.exit(0), 5);
  }, 5);
});
`;

const HEALTHY_RETRY_ACP = String.raw`
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "retry-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`;

const RESTORE_SEED_ACP = String.raw`
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "stored-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "stored-session",
        update: {
          sessionUpdate: "agent_message",
          messageId: "seed-reply",
          content: { type: "text", text: "seed reply" }
        }
      }
    });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`;

const LOAD_TIMEOUT_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
  }
});
`;

const RESTORE_FALLBACK_ACP = String.raw`
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "replacement-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    const text = message.params.prompt[0].text;
    const reply = text.includes("remember LOAD-FALLBACK-MARKER")
      && text.includes("New message from You:\nafter load timeout")
      ? "restored after timeout"
      : "history missing";
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "replacement-session",
        update: {
          sessionUpdate: "agent_message",
          messageId: "fallback-reply",
          content: { type: "text", text: reply }
        }
      }
    });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`;

const CANCEL_REPLACEMENT_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const update = (text, messageId) => send({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "cancel-session",
    update: {
      sessionUpdate: "agent_message",
      messageId,
      content: { type: "text", text }
    }
  }
});
let firstPromptId = null;
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "cancel-session" } });
    return;
  }
  if (message.method === "session/cancel") {
    setTimeout(() => {
      update("OLD", "cancelled-reply");
      send({ jsonrpc: "2.0", id: firstPromptId, result: { stopReason: "cancelled" } });
    }, 20);
    return;
  }
  if (message.method !== "session/prompt") return;
  if (firstPromptId === null) {
    firstPromptId = message.id;
    return;
  }
  update("NEW", "replacement-reply");
  send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
});
`;

const INVALID_CANCELLED_TERMINAL_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const update = (text, messageId) => send({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "invalid-cancel-session",
    update: {
      sessionUpdate: "agent_message",
      messageId,
      content: { type: "text", text }
    }
  }
});
let firstPromptId = null;
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "invalid-cancel-session" } });
    return;
  }
  if (message.method === "session/cancel") {
    setTimeout(() => send({ jsonrpc: "2.0", id: firstPromptId, result: {} }), 10);
    return;
  }
  if (message.method !== "session/prompt") return;
  if (firstPromptId === null) {
    firstPromptId = message.id;
    return;
  }
  update("OLD", "invalid-cancelled-reply");
  update("NEW", "replacement-reply");
  send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
});
`;

const STALE_CANCELLED_UPDATE_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const update = (text, messageId) => send({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "stale-session",
    update: {
      sessionUpdate: "agent_message",
      messageId,
      content: { type: "text", text }
    }
  }
});
let firstPromptId = null;
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "stale-session" } });
    return;
  }
  if (message.method !== "session/prompt") return;
  if (firstPromptId === null) {
    firstPromptId = message.id;
    setTimeout(() => {
      update("OLD", "old-reply");
      send({ jsonrpc: "2.0", id: firstPromptId, result: { stopReason: "cancelled" } });
    }, 140);
    return;
  }
  setTimeout(() => update("NEW", "same-client-replacement"), 80);
  setTimeout(() => {
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }, 90);
});
`;

const FRESH_AFTER_CANCEL_ACP = String.raw`
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
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId: "fresh-cancel-session" }
    });
    return;
  }
  if (message.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: "agent_message",
          messageId: "fresh-replacement",
          content: { type: "text", text: "NEW" }
        }
      }
    });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`;

const CANCEL_FRESH_CLIENT_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/load") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: message.params.sessionId } });
    return;
  }
  if (message.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: "agent_message",
          messageId: "fresh-client-reply",
          content: { type: "text", text: "fresh client answer" }
        }
      }
    });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`;

function client(source: string, startDeadlineMs = 30): AcpClient {
  return new AcpClient({
    command: process.execPath,
    args: ["-e", source],
    env: { ...process.env },
  }, process.cwd(), {}, { startDeadlineMs });
}

async function within<T>(promise: Promise<T>, milliseconds = 500): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("test safety timeout")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !processIsAlive(pid);
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

async function waitForBot(
  box: RunningBox,
  cookie: string,
  botId: string,
  predicate: (bot: { write?: boolean; messages?: Array<{ text?: string }> }) => boolean,
): Promise<{ write?: boolean; messages?: Array<{ text?: string; card?: { kind?: string } }> }> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    const response = await fetch(`${box.url}/api/bots/${botId}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const bot = (await response.json()) as {
      write?: boolean;
      messages?: Array<{ text?: string; card?: { kind?: string } }>;
    };
    if (predicate(bot)) return bot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for Bot state");
}

describe("AcpClient start deadline", () => {
  test("bounds initialize and invalidates the unusable child transport", async () => {
    const acp = client(SILENT_ACP);
    let rejectionCount = 0;
    const initializing = acp.initialize().catch((error: unknown) => {
      rejectionCount += 1;
      throw error;
    });
    try {
      await assert.rejects(
        within(initializing),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP start timed out");
          return true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(rejectionCount, 1);
      await assert.rejects(within(acp.initialize(), 100), /ACP start timed out/);
    } finally {
      acp.close();
    }
  });

  test("reaps an uncooperative child after rejecting the start timeout", async () => {
    let resolveReady!: () => void;
    let resolveIgnored!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const ignored = new Promise<void>((resolve) => { resolveIgnored = resolve; });
    const acp = new AcpClient({
      command: process.execPath,
      args: ["-e", TERM_IGNORING_ACP],
      env: { ...process.env },
    }, process.cwd(), {
      onStderr(line) {
        if (line === "ready") resolveReady();
        if (line === "ignored") resolveIgnored();
      },
    }, { startDeadlineMs: 50, terminateGraceMs: 500 });
    const pid = acp.pid;
    assert.ok(pid);
    try {
      await within(ready);
      await assert.rejects(within(acp.initialize(), 1_000), /ACP start timed out/);
      await within(ignored);
      assert.equal(processIsAlive(pid), true, "caller rejection must not wait for reap");
      assert.equal(
        await waitForProcessExit(pid, 1_500),
        true,
        "the ACP child must not survive the bounded TERM-to-KILL lifecycle",
      );
    } finally {
      acp.close();
      if (processIsAlive(pid)) process.kill(pid, "SIGKILL");
      await waitForProcessExit(pid, 500);
    }
  });

  test("reaps a descendant after the ACP process-group leader exits on TERM", {
    skip: process.platform === "win32",
  }, async () => {
    let resolveGrandchild!: (pid: number) => void;
    const grandchildPid = new Promise<number>((resolve) => { resolveGrandchild = resolve; });
    const acp = new AcpClient({
      command: process.execPath,
      args: ["-e", TERM_IGNORING_PROCESS_TREE_ACP],
      env: { ...process.env },
    }, process.cwd(), {
      onStderr(line) {
        if (line.startsWith("grandchild:")) resolveGrandchild(Number(line.slice("grandchild:".length)));
      },
    }, { startDeadlineMs: 80, terminateGraceMs: 50 });
    const wrapperPid = acp.pid;
    assert.ok(wrapperPid);
    let descendantPid: number | undefined;
    try {
      descendantPid = await within(grandchildPid);
      assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
      await assert.rejects(within(acp.initialize(), 500), /ACP start timed out/);
      assert.equal(
        await waitForProcessExit(descendantPid, 500),
        true,
        "the failed ACP transport must reap descendants owned by its process group",
      );
      assert.equal(await waitForProcessExit(wrapperPid, 500), true);
    } finally {
      acp.close();
      if (processIsAlive(wrapperPid)) process.kill(wrapperPid, "SIGKILL");
      if (descendantPid !== undefined && processIsAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
      await waitForProcessExit(wrapperPid, 500);
      if (descendantPid !== undefined) await waitForProcessExit(descendantPid, 500);
    }
  });

  test("bounds session creation, load, and resume", async (t) => {
    const cases = [
      ["session/new", (acp: AcpClient) => acp.newSession(process.cwd())],
      ["session/load", (acp: AcpClient) => acp.loadSession("existing-session")],
      ["session/resume", (acp: AcpClient) => acp.resumeSession("existing-session")],
    ] as const;
    for (const [name, attach] of cases) {
      await t.test(name, async () => {
        const acp = client(SILENT_SESSION_ACP, 100);
        try {
          await within(acp.initialize());
          await assert.rejects(within(attach(acp)), /ACP start timed out/);
        } finally {
          acp.close();
        }
      });
    }
  });

  test("bounds prompt write-to-flush without reporting a handed-off Turn", async () => {
    const acp = client(NON_READING_PROMPT_ACP, 100);
    let written = 0;
    let flushed = 0;
    let rejectionCount = 0;
    try {
      await within(acp.initialize());
      await within(acp.newSession(process.cwd()));
      const running = acp.prompt("x".repeat(4 * 1024 * 1024), {
        onPromptWritten() {
          written += 1;
        },
        onPromptFlushed() {
          flushed += 1;
        },
      }).catch((error: unknown) => {
        rejectionCount += 1;
        throw error;
      });
      await assert.rejects(within(running, 1_000), /ACP start timed out/);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(written, 1);
      assert.equal(flushed, 0);
      assert.equal(rejectionCount, 1);
    } finally {
      acp.close();
    }
  });

  test("does not expire a Bot Turn after prompt flush", async () => {
    const acp = client(LONG_RUNNING_ACP, 500);
    let resolveFlushed!: () => void;
    const flushed = new Promise<void>((resolve) => { resolveFlushed = resolve; });
    let settled = false;
    try {
      await within(acp.initialize());
      await within(acp.newSession(process.cwd()));
      const running = acp.prompt("keep working", { onPromptFlushed: resolveFlushed });
      void running.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      await within(flushed);
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.equal(settled, false);
      assert.equal(await within(running), "");
    } finally {
      acp.close();
    }
  });

  test("reuses the client when cancellation reaches a terminal response inside the drain bound", async () => {
    const acp = client(CANCEL_REPLACEMENT_ACP, 100);
    let resolveFlushed!: () => void;
    const flushed = new Promise<void>((resolve) => { resolveFlushed = resolve; });
    let firstRejections = 0;
    try {
      await within(acp.initialize());
      await within(acp.newSession(process.cwd()));
      const first = acp.prompt("first prompt", { onPromptFlushed: resolveFlushed }).catch((error: unknown) => {
        firstRejections += 1;
        throw error;
      });
      await within(flushed);
      acp.cancel();
      await assert.rejects(within(first), /cancelled/);
      assert.equal(firstRejections, 1);
      assert.equal(await within(acp.prompt("replacement prompt"), 500), "NEW");
      assert.equal(firstRejections, 1, "late old response must not settle the cancelled Turn again");
    } finally {
      acp.close();
    }
  });

  test("rejects an invalid cancelled-prompt terminal before reusing the session", async () => {
    const acp = client(INVALID_CANCELLED_TERMINAL_ACP, 100);
    let resolveFlushed!: () => void;
    const flushed = new Promise<void>((resolve) => { resolveFlushed = resolve; });
    const replacementText: string[] = [];
    try {
      await within(acp.initialize());
      await within(acp.newSession(process.cwd()));
      const first = acp.prompt("first prompt", { onPromptFlushed: resolveFlushed });
      await within(flushed);
      acp.cancel();
      await assert.rejects(within(first), /cancelled/);
      await assert.rejects(
        within(acp.prompt("replacement prompt", {
          onAssistant(text) {
            replacementText.push(text);
          },
        }), 500),
        /ACP transport protocol error/,
      );
      assert.deepEqual(replacementText, []);
    } finally {
      acp.close();
    }
  });

  test("invalidates the client when a cancelled generation outlives its drain bound", async () => {
    const stale = client(STALE_CANCELLED_UPDATE_ACP, 100);
    let resolveFlushed!: () => void;
    const flushed = new Promise<void>((resolve) => { resolveFlushed = resolve; });
    try {
      await within(stale.initialize());
      await within(stale.newSession(process.cwd()));
      const first = stale.prompt("first prompt", { onPromptFlushed: resolveFlushed });
      await within(flushed);
      stale.cancel();
      await assert.rejects(within(first), /cancelled/);
      await assert.rejects(
        within(stale.prompt("replacement prompt"), 500),
        (error: unknown) => {
          assert.equal(cancellationClosedTransport(error), true);
          return true;
        },
      );
      await assert.rejects(
        within(stale.prompt("later retry"), 100),
        (error: unknown) => {
          assert.equal(cancellationClosedTransport(error), true);
          return true;
        },
      );
    } finally {
      stale.close();
    }

    const fresh = client(FRESH_AFTER_CANCEL_ACP, 100);
    try {
      await within(fresh.initialize());
      await within(fresh.newSession(process.cwd()));
      assert.equal(await within(fresh.prompt("replacement prompt")), "NEW");
    } finally {
      fresh.close();
    }
  });

  test("cancelling a blocked pre-flush handoff settles safely and reaps its child", async () => {
    const acp = new AcpClient({
      command: process.execPath,
      args: ["-e", NON_READING_PROMPT_ACP],
      env: { ...process.env },
    }, process.cwd(), {}, { startDeadlineMs: 500, terminateGraceMs: 50 });
    const pid = acp.pid;
    assert.ok(pid);
    let resolveWritten!: () => void;
    const written = new Promise<void>((resolve) => { resolveWritten = resolve; });
    let rejectionCount = 0;
    try {
      await within(acp.initialize());
      await within(acp.newSession(process.cwd()));
      const running = acp.prompt("x".repeat(4 * 1024 * 1024), {
        onPromptWritten: resolveWritten,
      }).catch((error: unknown) => {
        rejectionCount += 1;
        throw error;
      });
      await within(written);
      acp.cancel();
      await assert.rejects(within(running, 300), /cancelled/);
      assert.equal(rejectionCount, 1);
      assert.equal(await waitForProcessExit(pid, 500), true, "blocked child must be reaped");
    } finally {
      acp.close();
      if (processIsAlive(pid)) process.kill(pid, "SIGKILL");
      await waitForProcessExit(pid, 500);
    }

    const fresh = client(HEALTHY_RETRY_ACP, 100);
    try {
      await within(fresh.initialize());
      await within(fresh.newSession(process.cwd()));
      assert.equal(await within(fresh.prompt("fresh retry")), "");
    } finally {
      fresh.close();
    }
  });

  test("BotStore replaces a client invalidated by pre-flush cancellation", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-acp-cancel-replace-home-"));
    let spawned = 0;
    const store = new BotStore(homeDir, {
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp(_spec, cwd, handlers = {}) {
        spawned += 1;
        return new AcpClient({
          command: process.execPath,
          args: ["-e", spawned === 1 ? NON_READING_PROMPT_ACP : CANCEL_FRESH_CLIENT_ACP],
          env: { ...process.env },
        }, cwd, handlers, { startDeadlineMs: 500, terminateGraceMs: 50 });
      },
    });
    try {
      const ada = await store.create("Ada");
      await store.pickHarness(ada.id, "codex");
      await store.send(ada.id, "x".repeat(4 * 1024 * 1024));
      assert.equal(store.get(ada.id)?.write, true);
      await within(store.send(ada.id, "replacement message"), 1_000);
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        const bot = store.get(ada.id);
        if (bot?.write === false && bot.messages?.some((message) => message.text === "fresh client answer")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const bot = store.get(ada.id);
      assert.equal(spawned, 2);
      assert.equal(bot?.write, false);
      assert.equal(bot?.messages?.filter((message) => message.text === "replacement message").length, 1);
      assert.equal(bot?.messages?.filter((message) => message.text === "fresh client answer").length, 1);
      assert.equal(bot?.messages?.filter((message) => message.card?.kind === "bot-failure").length, 0);
    } finally {
      store.close();
    }
  });

  test("BotStore retries a replacement on a fresh client after cancelled drain expiry", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-acp-cancel-drain-home-"));
    let spawned = 0;
    const store = new BotStore(homeDir, {
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp(_spec, cwd, handlers = {}) {
        spawned += 1;
        return new AcpClient({
          command: process.execPath,
          args: ["-e", spawned === 1 ? STALE_CANCELLED_UPDATE_ACP : FRESH_AFTER_CANCEL_ACP],
          env: { ...process.env },
        }, cwd, handlers, { startDeadlineMs: 100, terminateGraceMs: 50 });
      },
    });
    try {
      const ada = await store.create("Ada");
      await store.pickHarness(ada.id, "codex");
      await store.send(ada.id, "first message");
      const flushDeadline = Date.now() + 1_000;
      while (Date.now() < flushDeadline) {
        const firstMessage = store.get(ada.id)?.messages?.find((message) => message.text === "first message");
        if (firstMessage?.receipt === "read") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        store.get(ada.id)?.messages?.find((message) => message.text === "first message")?.receipt,
        "read",
      );

      await within(store.send(ada.id, "replacement message"), 1_000);
      const completionDeadline = Date.now() + 1_500;
      while (Date.now() < completionDeadline) {
        const bot = store.get(ada.id);
        if (bot?.write === false && bot.messages?.some((message) => message.text === "NEW")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const bot = store.get(ada.id);
      assert.equal(spawned, 2);
      assert.equal(bot?.write, false);
      assert.equal(bot?.messages?.filter((message) => message.text === "replacement message").length, 1);
      assert.equal(bot?.messages?.filter((message) => message.text === "NEW").length, 1);
      assert.equal(bot?.messages?.some((message) => message.text.includes("OLD")), false);
      assert.equal(bot?.messages?.filter((message) => message.card?.kind === "bot-failure").length, 0);
    } finally {
      store.close();
    }
  });

  test("settles once when timeout is followed by a late response and child exit", async () => {
    const acp = client(LATE_AFTER_TIMEOUT_ACP, 40);
    let rejectionCount = 0;
    const initializing = acp.initialize().catch((error: unknown) => {
      rejectionCount += 1;
      throw error;
    });
    try {
      await assert.rejects(within(initializing), /ACP start timed out/);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(rejectionCount, 1);
      await assert.rejects(within(acp.initialize(), 100), /ACP start timed out/);
    } finally {
      acp.close();
    }

    const fresh = client(LONG_RUNNING_ACP, 100);
    try {
      assert.deepEqual(await within(fresh.initialize()), { authMethods: [] });
      assert.equal(await within(fresh.newSession(process.cwd())), "long-session");
    } finally {
      fresh.close();
    }
  });

  test("bounds the public Talk action and retries through a fresh client", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-acp-timeout-home-"));
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-acp-timeout-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    let spawned = 0;
    const spawnAcp = (
      _spec: SpawnSpec,
      cwd: string,
      handlers: AcpHandlers = {},
    ) => {
      spawned += 1;
      return new AcpClient({
        command: process.execPath,
        args: ["-e", spawned === 1 ? SLOW_INITIALIZE_THEN_SILENT_SESSION_ACP : HEALTHY_RETRY_ACP],
        env: { ...process.env },
      }, cwd, handlers, { startDeadlineMs: 250 });
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

      const startedAt = Date.now();
      const failed = await within(fetch(`${box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Bound this startup." }),
      }), 1_000);
      assert.ok(
        Date.now() - startedAt >= 280,
        "initialize and session/new must receive independent outbound deadlines",
      );
      assert.equal(failed.status, 200);
      const failedBody = (await failed.json()) as {
        messages: Array<{
          id: string;
          card?: { kind?: string; body?: string; actions?: Array<{ command?: { kind?: string } }> };
        }>;
      };
      const failure = failedBody.messages.find((message) => message.card?.kind === "bot-failure");
      assert.ok(failure);
      assert.doesNotMatch(JSON.stringify(failure), /ACP_START_TIMEOUT|ACP start timed out|node:|SILENT_ACP/);
      assert.equal(spawned, 1);

      const retry = await within(fetch(`${box.url}/api/bots/${botId}/cards/${failure.id}/retry`, {
        method: "POST",
        headers: { cookie },
      }));
      assert.equal(retry.status, 200);
      assert.equal(spawned, 2);
      const afterRetry = await fetch(`${box.url}/api/bots/${botId}`, { headers: { cookie } });
      assert.equal(afterRetry.status, 200);
    } finally {
      await box.close();
    }
  });

  test("replaces a timed-out session restore and injects history exactly once", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-acp-restore-timeout-home-"));
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-acp-restore-timeout-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const harnesses = () => [{ id: "codex" as const, name: "Codex", bin: "codex", talk: true }];
    const spawnSource = (source: string) => (
      _spec: SpawnSpec,
      cwd: string,
      handlers: AcpHandlers = {},
    ) => new AcpClient({
      command: process.execPath,
      args: ["-e", source],
      env: { ...process.env },
    }, cwd, handlers, { startDeadlineMs: 200, terminateGraceMs: 50 });

    const first = await startBox({
      password: "correct-horse",
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      listHarnesses: harnesses,
      spawnAcp: spawnSource(RESTORE_SEED_ACP),
    });
    let botId = "";
    try {
      const cookie = await login(first);
      const created = await fetch(`${first.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      });
      assert.equal(created.status, 201);
      botId = ((await created.json()) as { id: string }).id;
      const selected = await fetch(`${first.url}/api/bots/${botId}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ harness: "codex" }),
      });
      assert.equal(selected.status, 200);
      const seeded = await fetch(`${first.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "remember LOAD-FALLBACK-MARKER" }),
      });
      assert.equal(seeded.status, 200);
      await waitForBot(first, cookie, botId, (bot) => (
        bot.write === false && bot.messages?.some((message) => message.text === "seed reply") === true
      ));
    } finally {
      await first.close();
    }

    let spawned = 0;
    const second = await startBox({
      password: "correct-horse",
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      listHarnesses: harnesses,
      spawnAcp(_spec, cwd, handlers = {}) {
        spawned += 1;
        return new AcpClient({
          command: process.execPath,
          args: ["-e", spawned === 1 ? LOAD_TIMEOUT_ACP : RESTORE_FALLBACK_ACP],
          env: { ...process.env },
        }, cwd, handlers, { startDeadlineMs: 200, terminateGraceMs: 50 });
      },
    });
    try {
      const cookie = await login(second);
      const sent = await within(fetch(`${second.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "after load timeout" }),
      }), 1_000);
      assert.equal(sent.status, 200);
      assert.equal(spawned, 2, "session/load timeout must replace the invalidated client");
      const bot = await waitForBot(second, cookie, botId, (candidate) => (
        candidate.write === false
        && candidate.messages?.some((message) => message.text === "restored after timeout") === true
      ));
      const messages = bot.messages ?? [];
      assert.equal(messages.filter((message) => message.text === "remember LOAD-FALLBACK-MARKER").length, 1);
      assert.equal(messages.filter((message) => message.text === "seed reply").length, 1);
      assert.equal(messages.filter((message) => message.text === "after load timeout").length, 1);
      assert.equal(messages.filter((message) => message.text === "restored after timeout").length, 1);
      assert.equal(messages.filter((message) => message.card?.kind === "bot-failure").length, 0);
    } finally {
      await second.close();
    }

    const home = new HomeStore(homeDir);
    try {
      const channelId = home.directChannelId(botId);
      assert.ok(channelId);
      assert.equal(home.getSessionId(botId, channelId), "replacement-session");
    } finally {
      home.close();
    }
  });
});
