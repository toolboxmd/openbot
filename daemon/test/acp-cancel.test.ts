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
const update = (text, messageId) => send({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "s1",
    update: {
      sessionUpdate: "agent_message",
      ...(messageId ? { messageId } : {}),
      content: { type: "text", text },
    },
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
      setTimeout(() => update("fresh"), 5);
      setTimeout(idle, 10);
      setTimeout(() => send({
        jsonrpc: "2.0",
        id: message.id,
        result: { stopReason: "end_turn" }
      }), 14);
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
    if (text === "consecutive-ids") {
      chunk("First complete.", "message-one");
      chunk("Second complete.", "message-two");
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
    if (text === "chunk-then-complete-message") {
      chunk("Chunk boundary.", "chunk-message");
      update("Complete message.", "complete-message");
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
    if (text === "chunk-then-same-complete-message") {
      chunk("Private partial", "same-message");
      update("Stable complete message.", "same-message");
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
    if (text === "anonymous-chunk-then-complete-message") {
      chunk("Private anonymous partial");
      update("Stable anonymous message.");
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

const MALFORMED_PERMISSION_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
let promptId = null;
let permissionId = null;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "malformed-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    const text = message.params.prompt[0].text;
    if (text === "malformed" || text === "duplicate") {
      promptId = message.id;
      permissionId = text === "malformed" ? 800 : 801;
      send({
        jsonrpc: "2.0",
        id: permissionId,
        method: "session/request_permission",
        params: {
          sessionId: "malformed-session",
          title: "Malformed choices",
          options: text === "malformed"
            ? [null, { optionId: "allow-once", name: "Allow", kind: "allow_once" }]
            : [
              { optionId: "same-choice", name: "Allow", kind: "allow_once" },
              { optionId: "same-choice", name: "Reject", kind: "reject_once" },
            ],
        },
      });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (message.id === permissionId && message.result?.outcome?.outcome === "cancelled") {
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
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
  test("fails malformed and duplicate permission options closed without poisoning the next Turn", async () => {
    const seenOptions: unknown[] = [];
    const client = new AcpClient({
      command: process.execPath,
      args: ["-e", MALFORMED_PERMISSION_ACP],
      env: { ...process.env },
    }, process.cwd());

    try {
      await client.initialize();
      await client.newSession(process.cwd());
      const rejectInvalidPrompt = (text: string) => client.prompt(text, {
        onPermission(prompt) {
          seenOptions.push(prompt.options);
          client.cancel();
        },
      }).catch((error: unknown) => error);
      const malformed = rejectInvalidPrompt("malformed");
      assert.equal(isCancelled(await malformed), true);
      const duplicate = rejectInvalidPrompt("duplicate");
      assert.equal(isCancelled(await duplicate), true);
      assert.deepEqual(seenOptions, [[], []]);
      assert.equal(await client.prompt("recovered"), "");
    } finally {
      client.close();
    }
  });

  test("rejects a permission response when no server request is active", async () => {
    const client = new AcpClient({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      env: { ...process.env },
    }, process.cwd());

    try {
      let transportFailure: unknown;
      const deadline = Date.now() + 1_000;
      while (!transportFailure && Date.now() < deadline) {
        try {
          await client.respondPermission(900, "allow-once");
        } catch (err) {
          transportFailure = err;
        }
        if (!transportFailure) await new Promise((resolve) => setImmediate(resolve));
      }
      assert.match(
        String((transportFailure as Error)?.message ?? transportFailure),
        /Permission request is no longer active/,
      );
    } finally {
      client.close();
    }
  });

  test("drains cancelled updates before assigning replacement Turn handlers", async () => {
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
        },
        onPermission(prompt) {
          oldPermissions.push(prompt.title);
          oldPermission.resolve();
        },
      }).catch((error: unknown) => error);
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
      assert.deepEqual(oldMessages, []);
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
      const toolText = await client.prompt("boundary-tool", {
        onAssistant(text, delta) {
          events.push({ text, delta });
        },
      });
      const thoughtText = await client.prompt("boundary-thought", {
        onAssistant(text, delta) {
          events.push({ text, delta });
        },
      });

      assert.equal(toolText, "Complete after tool.");
      assert.equal(thoughtText, "Complete after thought.");
      assert.deepEqual(events, [
        { text: "Complete after tool.", delta: { done: true, messageId: "tool-message" } },
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
        { text: "Identified.", delta: { done: true, messageId: "identified-message" } },
        { text: "Anonymous.", delta: { done: true } },
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

  test("completes the prior protocol message when a distinct message id begins", async () => {
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
      await client.prompt("consecutive-ids", {
        onAssistant(text, delta) {
          events.push({ text, delta });
        },
      });

      assert.deepEqual(events, [
        { text: "First complete.", delta: { done: true, messageId: "message-one" } },
        { text: "Second complete.", delta: { done: true, messageId: "message-two" } },
      ]);
    } finally {
      client.close();
    }
  });

  test("completes a chunked message before a distinct complete message event", async () => {
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
      await client.prompt("chunk-then-complete-message", {
        onAssistant(text, delta) {
          events.push({ text, delta });
        },
      });

      assert.deepEqual(events, [
        { text: "Chunk boundary.", delta: { done: true, messageId: "chunk-message" } },
        {
          text: "Complete message.",
          delta: { start: true, done: true, messageId: "complete-message" },
        },
      ]);
    } finally {
      client.close();
    }
  });

  test("publishes identified and anonymous chunk streams once when their complete event arrives", async () => {
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
      const identified = await client.prompt("chunk-then-same-complete-message", {
        onAssistant(text, delta) {
          events.push({ text, delta });
        },
      });
      const anonymous = await client.prompt("anonymous-chunk-then-complete-message", {
        onAssistant(text, delta) {
          events.push({ text, delta });
        },
      });

      assert.equal(identified, "Stable complete message.");
      assert.equal(anonymous, "Stable anonymous message.");
      assert.deepEqual(events, [
        {
          text: "Stable complete message.",
          delta: { start: true, done: true, messageId: "same-message" },
        },
        { text: "Stable anonymous message.", delta: { start: true, done: true } },
      ]);
    } finally {
      client.close();
    }
  });
});
