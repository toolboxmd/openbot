import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AcpClient, isCancelled } from "../src/acp.ts";

const FAKE_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
let firstPromptId = null;
const cancelledPermissions = new Set();
let cancellationTailDone = false;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const finishCancelledPrompt = () => {
  if (!cancellationTailDone) return;
  if (!cancelledPermissions.has(700) || !cancelledPermissions.has(701)) return;
  send({ jsonrpc: "2.0", id: firstPromptId, result: { stopReason: "cancelled" } });
};
const update = (text) => send({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "s1",
    update: { sessionUpdate: "agent_message", content: { type: "text", text } },
  },
});
const chunk = (text, messageId) => send({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "s1",
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text },
    },
  },
});
const tool = () => send({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "s1",
    update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Tool" },
  },
});
const thought = () => send({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "s1",
    update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
  },
});
const permission = (id, title) => send({
  jsonrpc: "2.0",
  id,
  method: "session/request_permission",
  params: { sessionId: "s1", title, options: [] },
});
const idle = () => send({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId: "s1", update: { sessionUpdate: "state_update", state: "idle" } },
});

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "s1" } });
    return;
  }
  if (message.method === "session/prompt") {
    const text = message.params.prompt[0].text;
    if (text === "old") {
      firstPromptId = message.id;
      chunk("partial old", "old-message");
      permission(700, "pending permission");
      return;
    }
    if (text === "new") {
      setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: {} }), 5);
      setTimeout(() => update("fresh"), 10);
      setTimeout(idle, 14);
    }
    if (text === "boundary-tool") {
      chunk("Complete ", "tool-message");
      tool();
      chunk("after tool.", "tool-message");
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
    if (text === "boundary-thought") {
      chunk("Complete ", "thought-message");
      thought();
      chunk("after thought.", "thought-message");
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
    if (text === "boundary-anonymous") {
      chunk("Identified.", "identified-message");
      tool();
      chunk("Anonymous.");
      idle();
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
    if (text === "boundary-anonymous-complete") {
      chunk("Identified complete.", "identified-complete-message");
      tool();
      update("Anonymous complete.");
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
    return;
  }
  if (message.method === "session/cancel") {
    setTimeout(() => permission(701, "stale permission"), 2);
    setTimeout(() => update("late old"), 4);
    setTimeout(() => {
      idle();
      cancellationTailDone = true;
      finishCancelledPrompt();
    }, 6);
    return;
  }
  if (message.id === 700 || message.id === 701) {
    if (message.result?.outcome?.outcome === "cancelled") {
      cancelledPermissions.add(message.id);
    }
    finishCancelledPrompt();
  }
});
`;

function defer() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("AcpClient cancellation boundary", () => {
  test("drains cancelled updates before assigning replacement Turn handlers", async () => {
    const oldStarted = defer();
    const oldPermission = defer();
    const oldMessages: string[] = [];
    const oldPermissions: string[] = [];
    const replacementMessages: string[] = [];
    const replacementPermissions: string[] = [];
    const client = new AcpClient({
      command: process.execPath,
      args: ["-e", FAKE_ACP],
      env: { ...process.env },
    }, process.cwd());

    try {
      await client.initialize();
      await client.newSession(process.cwd());
      const oldSettled = client.prompt("old", {
        onAssistant(text) {
          oldMessages.push(text);
          oldStarted.resolve();
        },
        onPermission(prompt) {
          oldPermissions.push(prompt.title);
          oldPermission.resolve();
        },
      }).catch((error: unknown) => error);
      await oldStarted.promise;
      await oldPermission.promise;

      client.cancel();
      const replacement = client.prompt("new", {
        onAssistant(text) {
          replacementMessages.push(text);
        },
        onPermission(prompt) {
          replacementPermissions.push(prompt.title);
        },
      });

      assert.equal(isCancelled(await oldSettled), true);
      assert.equal(
        await Promise.race([
          replacement,
          new Promise<string>((_resolve, reject) => {
            setTimeout(() => reject(new Error("replacement stayed blocked behind cancelled permission")), 750);
          }),
        ]),
        "fresh",
      );
      assert.deepEqual(oldMessages, ["partial old"]);
      assert.deepEqual(oldPermissions, ["pending permission"]);
      assert.deepEqual(replacementMessages, ["fresh"]);
      assert.deepEqual(replacementPermissions, []);
    } finally {
      client.close();
    }
  });

  test("keeps one message identity across tool and thought boundaries", async () => {
    const events: Array<{
      text: string;
      delta?: { start?: boolean; done?: boolean; messageId?: string };
    }> = [];
    const client = new AcpClient({
      command: process.execPath,
      args: ["-e", FAKE_ACP],
      env: { ...process.env },
    }, process.cwd());

    try {
      await client.initialize();
      await client.newSession(process.cwd());
      await client.prompt("boundary-tool", {
        onAssistant(text, delta) {
          events.push({ text, delta });
        },
      });
      await client.prompt("boundary-thought", {
        onAssistant(text, delta) {
          events.push({ text, delta });
        },
      });

      assert.deepEqual(events, [
        { text: "Complete ", delta: { start: true, messageId: "tool-message" } },
        { text: "Complete ", delta: { done: true, messageId: "tool-message" } },
        { text: "Complete after tool.", delta: { messageId: "tool-message" } },
        { text: "Complete after tool.", delta: { done: true, messageId: "tool-message" } },
        { text: "Complete ", delta: { start: true, messageId: "thought-message" } },
        { text: "Complete ", delta: { done: true, messageId: "thought-message" } },
        { text: "Complete after thought.", delta: { messageId: "thought-message" } },
        { text: "Complete after thought.", delta: { done: true, messageId: "thought-message" } },
      ]);
    } finally {
      client.close();
    }
  });

  test("clears a completed message identity when an anonymous stream starts", async () => {
    const events: Array<{
      text: string;
      delta?: { start?: boolean; done?: boolean; messageId?: string };
    }> = [];
    const client = new AcpClient({
      command: process.execPath,
      args: ["-e", FAKE_ACP],
      env: { ...process.env },
    }, process.cwd());

    try {
      await client.initialize();
      await client.newSession(process.cwd());
      await client.prompt("boundary-anonymous", {
        onAssistant(text, delta) {
          events.push({ text, delta });
        },
      });
      await client.prompt("boundary-anonymous-complete", {
        onAssistant(text, delta) {
          events.push({ text, delta });
        },
      });

      assert.deepEqual(events, [
        { text: "Identified.", delta: { start: true, messageId: "identified-message" } },
        { text: "Identified.", delta: { done: true, messageId: "identified-message" } },
        { text: "Anonymous.", delta: { start: true } },
        { text: "Anonymous.", delta: { done: true } },
        {
          text: "Identified complete.",
          delta: { start: true, messageId: "identified-complete-message" },
        },
        {
          text: "Identified complete.",
          delta: { done: true, messageId: "identified-complete-message" },
        },
        { text: "Anonymous complete.", delta: { start: true, done: true } },
      ]);
    } finally {
      client.close();
    }
  });
});
