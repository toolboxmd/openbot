import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AcpClient,
  acpResponseWasFlushed,
  cancellationClosedTransport,
  type AcpHandlers,
} from "../src/acp.ts";
import { startBox, type RunningBox } from "../src/box.ts";
import type { SpawnSpec } from "../src/harness.ts";

const BATCH_INITIALIZE_ACP = String.raw`
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).once("line", (line) => {
  const message = JSON.parse(line);
  process.stdout.write(JSON.stringify([{
    jsonrpc: "2.0",
    id: message.id,
    result: { authMethods: [] }
  }]) + "\n");
});
`;

const GROUPED_REQUESTS_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const includeInvalid = process.argv[1] === "invalid";
let promptId = null;
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "batch-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    const entries = [
      { jsonrpc: "2.0", id: 701, method: "fixture/first", params: {} },
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "batch-session",
          update: {
            sessionUpdate: "agent_message",
            content: { type: "text", text: "BATCH" },
            messageId: "batch-message"
          }
        }
      },
      { jsonrpc: "2.0", id: 703, method: "fixture/second", params: {} }
    ];
    if (includeInvalid) entries.splice(1, 0, { jsonrpc: "2.0", id: 702, method: 42 });
    send(entries);
    return;
  }
  if (Array.isArray(message)) {
    const summary = message.map((entry) => [entry.id, entry.error?.code]);
    const expected = includeInvalid
      ? [[701, -32601], [null, -32600], [703, -32601]]
      : [[701, -32601], [703, -32601]];
    if (JSON.stringify(summary) === JSON.stringify(expected)) {
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    }
  }
});
`;

const DELAYED_PERMISSION_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let promptId = null;
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "permission-batch" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    send([
      { jsonrpc: "2.0", id: 700, method: "fixture/instant", params: {} },
      {
        jsonrpc: "2.0",
        id: 701,
        method: "session/request_permission",
        params: {
          sessionId: "permission-batch",
          title: "Allow the batch action?",
          options: [
            { optionId: "allow-once", name: "Allow", kind: "allow_once" },
            { optionId: "reject-once", name: "Deny", kind: "reject_once" }
          ]
        }
      }
    ]);
    return;
  }
  if (Array.isArray(message)) {
    const correct = message.length === 2
      && message[0]?.id === 700
      && message[0]?.error?.code === -32601
      && message[1]?.id === 701
      && message[1]?.result?.outcome?.optionId === "allow-once";
    if (correct) {
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    }
  }
});
`;

const TWO_REENTRANT_PERMISSIONS_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const mode = process.argv[1] ?? "two";
let promptId = null;
const permission = (id) => ({
  jsonrpc: "2.0",
  id,
  method: "session/request_permission",
  params: {
    sessionId: "reentrant-permissions",
    title: "Permission " + id,
    options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }]
  }
});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "reentrant-permissions" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    if (mode === "blocked") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "reentrant-permissions",
          update: {
            sessionUpdate: "agent_message",
            content: { type: "text", text: "BLOCK" },
            messageId: "blocked-unrelated-callback"
          }
        }
      });
    }
    const ids = mode === "three" ? [701, 702, 703] : [701, 702];
    const entries = ids.map(permission);
    if (mode === "interleaved") {
      entries.splice(1, 0, {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "reentrant-permissions",
          update: {
            sessionUpdate: "agent_message",
            content: { type: "text", text: "BETWEEN" },
            messageId: "interleaved-same-batch-callback"
          }
        }
      });
    }
    send(entries);
    if (mode === "interleaved") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "reentrant-permissions",
          update: {
            sessionUpdate: "agent_message",
            content: { type: "text", text: "OUTSIDE" },
            messageId: "outside-batch-callback"
          }
        }
      });
    }
    return;
  }
  if (Array.isArray(message)) {
    const expectedLength = mode === "three" ? 3 : 2;
    const ordered = message.length === expectedLength
      && message[0]?.id === 701
      && message[0]?.result?.outcome?.optionId === "allow-once"
      && message[1]?.id === 702
      && message[1]?.result?.outcome?.optionId === "allow-once"
      && (expectedLength === 2 || (
        message[2]?.id === 703
        && message[2]?.result?.outcome?.optionId === "allow-once"
      ));
    if (ordered) {
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    }
  }
});
`;

const POST_FLUSH_HANDLER_THROW_ACP = String.raw`
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const mode = process.argv[1] ?? "batch-one";
let promptId = null;
spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);"
], { stdio: "ignore" });
process.on("SIGTERM", () => {});
const permission = (id) => ({
  jsonrpc: "2.0",
  id,
  method: "session/request_permission",
  params: {
    sessionId: "post-flush-handler-throw",
    title: "Permission " + id,
    options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }]
  }
});
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
      result: { sessionId: "post-flush-handler-throw" }
    });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    if (mode === "standalone") {
      send(permission(701));
    } else if (mode === "batch-two") {
      send([permission(701), permission(702)]);
    } else {
      send([permission(701)]);
    }
    return;
  }
  const responses = Array.isArray(message) ? message : [message];
  const expectedIds = mode === "batch-two" ? [701, 702] : [701];
  const correct = responses.length === expectedIds.length
    && responses.every((response, index) => (
      response?.id === expectedIds[index]
      && response?.result?.outcome?.optionId === "allow-once"
    ));
  if (correct) {
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  }
});
`;

const RESPONSE_BEFORE_UPDATE_ACP = String.raw`
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "response-order" } });
    return;
  }
  if (message.method === "session/prompt") {
    send([
      { jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } },
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "response-order",
          update: {
            sessionUpdate: "agent_message",
            content: { type: "text", text: "AFTER" },
            messageId: "after-terminal-slot"
          }
        }
      }
    ]);
  }
});
`;

const EMPTY_BATCH_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let initializeId = null;
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    initializeId = message.id;
    send([]);
    return;
  }
  if (message.id === null && message.error?.code === -32600) {
    send({ jsonrpc: "2.0", id: initializeId, result: { authMethods: [] } });
  }
});
`;

const NOTIFICATION_ONLY_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let promptId = null;
let unexpectedResponse = false;
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "notification-batch" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    send([{
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "notification-batch",
        update: {
          sessionUpdate: "agent_message",
          content: { type: "text", text: "SILENT" },
          messageId: "notification-only"
        }
      }
    }]);
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        id: promptId,
        result: { stopReason: unexpectedResponse ? "unexpected_response" : "end_turn" }
      });
    }, 30);
    return;
  }
  unexpectedResponse = true;
});
`;

const MALFORMED_RESPONSE_SIBLINGS_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let initialized = false;
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send([
      {
        jsonrpc: "2.0",
        id: 888888,
        result: { authMethods: ["PRIVATE-MALFORMED"] },
        error: { code: -32000, message: "PRIVATE-MALFORMED" }
      },
      { jsonrpc: "2.0", id: 999999, result: { ignored: true } },
      { jsonrpc: "2.0", id: message.id, result: { authMethods: [] } }
    ]);
    initialized = true;
    return;
  }
  if (initialized) process.stderr.write("ANSWERED-A-RESPONSE\n");
});
`;

const MATCHING_MALFORMED_RESPONSE_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const mode = process.argv[1] ?? "sole";
let promptId = null;
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "malformed-response" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    const malformed = {
      jsonrpc: "1.0",
      id: message.id,
      result: { stopReason: "end_turn" }
    };
    if (mode === "valid-first") {
      send([
        { jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } },
        malformed
      ]);
      return;
    }
    if (mode === "cancelled") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "malformed-response",
          update: {
            sessionUpdate: "agent_message",
            content: { type: "text", text: "READY" },
            messageId: "cancelled-drain-ready"
          }
        }
      });
      return;
    }
    send([malformed]);
    return;
  }
  if (mode === "cancelled" && message.method === "session/cancel") {
    send([{
      jsonrpc: "1.0",
      id: promptId,
      result: { stopReason: "end_turn" }
    }]);
  }
});
`;

const MATCHING_MIXED_ENVELOPE_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const mode = process.argv[1] ?? "sole";
let promptId = null;
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "mixed-envelope" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    const mixed = {
      jsonrpc: "2.0",
      id: message.id,
      method: "fixture/illegal-mixed-envelope",
      result: { stopReason: "end_turn" }
    };
    if (mode === "valid-first") {
      send([
        { jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } },
        mixed
      ]);
      return;
    }
    if (mode === "invalid-call-overlap") {
      send([{ jsonrpc: "2.0", id: message.id, method: 42 }]);
      return;
    }
    send([mixed]);
    return;
  }
  if (
    mode === "invalid-call-overlap"
    && Array.isArray(message)
    && message.length === 1
    && message[0]?.id === null
    && message[0]?.error?.code === -32600
  ) {
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  }
});
`;

const DELAYED_COMPUTER_HELP_ACP = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const duplicate = process.argv[1] === "duplicate";
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
    const server = message.params?.mcpServers?.find((candidate) => (
      candidate.name === "openbot-computer-help"
    ));
    identity = server?.env?.find((entry) => (
      entry.name === "OPENBOT_COMPUTER_HELP_IDENTITY"
    ))?.value ?? null;
    generationFile = server?.env?.find((entry) => (
      entry.name === "OPENBOT_COMPUTER_HELP_GENERATION_FILE"
    ))?.value ?? null;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "computer-batch" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    const elicitation = {
      jsonrpc: "2.0",
      id: 801,
      method: "elicitation/create",
      params: {
        sessionId: "computer-batch",
        mode: "form",
        message: "Complete the visual step on this Computer, then choose I'm done.",
        requestedSchema: {
          type: "object",
          properties: {
            completed: { type: "string", enum: ["done"], title: "Completion" }
          },
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
    const entries = [
      { jsonrpc: "2.0", id: 800, method: "fixture/instant", params: {} },
      elicitation
    ];
    if (duplicate) entries.push(elicitation);
    send(entries);
    return;
  }
  if (Array.isArray(message)) {
    const correct = message.length === 2
      && message[0]?.id === 800
      && message[0]?.error?.code === -32601
      && message[1]?.id === 801
      && message[1]?.result?.action === "accept"
      && message[1]?.result?.content?.completed === "done";
    if (correct) {
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    }
  }
});
`;

const ITEM_CEILING_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const mode = process.argv[1];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "item-batch" } });
    return;
  }
  if (message.method !== "session/prompt") return;
  if (mode === "allowed") {
    const entries = Array.from({ length: 4_094 }, () => ({
      jsonrpc: "2.0",
      method: "fixture/notification",
      params: {}
    }));
    entries.push({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn" }
    });
    send(entries);
    return;
  }
  const entries = [{
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "item-batch",
      update: {
        sessionUpdate: "agent_message",
        content: { type: "text", text: "MUST-NOT-DISPATCH" }
      }
    }
  }];
  while (entries.length < 4_096) {
    entries.push({ jsonrpc: "2.0", method: "fixture/notification", params: {} });
  }
  send(entries);
});
`;

const SERVER_REQUEST_CEILING_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const mode = process.argv[1];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
let promptId = null;
let nextUnique = 0;
const permission = (id) => ({
  jsonrpc: "2.0",
  id,
  method: "session/request_permission",
  params: {
    sessionId: "server-request-batch",
    title: "Bounded request " + id,
    options: [{ optionId: "reject-once", name: "Deny", kind: "reject_once" }]
  }
});
const sendNextUnique = () => {
  const limit = mode === "unique128" ? 128 : 129;
  if (nextUnique === limit) {
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    return;
  }
  send([permission(1_000 + nextUnique)]);
  nextUnique += 1;
};
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "server-request-batch" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    if (mode.startsWith("active")) {
      const count = mode === "active16" ? 16 : 17;
      send(Array.from({ length: count }, (_, index) => permission(2_000 + index)));
    } else {
      sendNextUnique();
    }
    return;
  }
  if (Array.isArray(message)) {
    if (mode === "active16") {
      if (message.length === 16) {
        send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
      }
      return;
    }
    if (mode.startsWith("unique")) sendNextUnique();
  }
});
`;

const DUPLICATE_BATCH_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const mode = process.argv[1];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
const permission = {
  jsonrpc: "2.0",
  id: 910,
  method: "session/request_permission",
  params: {
    sessionId: "duplicate-batch",
    title: "PRIVATE-DUPLICATE-BATCH",
    options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }]
  }
};
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "duplicate-batch" } });
    return;
  }
  if (message.method !== "session/prompt") return;
  if (mode === "terminal") {
    send([
      { jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } },
      { jsonrpc: "2.0", id: message.id, result: { stopReason: "PRIVATE-DUPLICATE" } }
    ]);
    return;
  }
  if (mode === "cross-kind") {
    send([
      permission,
      {
        jsonrpc: "2.0",
        id: 910,
        method: "elicitation/create",
        params: { mode: "form", message: "PRIVATE-CROSS-KIND", requestedSchema: {} }
      }
    ]);
    return;
  }
  send([permission, permission]);
});
`;

const CANCELLATION_BATCH_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let promptCount = 0;
let cancelledPromptId = null;
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "cancel-batch" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptCount += 1;
    if (promptCount === 1) {
      cancelledPromptId = message.id;
      send([
        { jsonrpc: "2.0", id: 920, method: "fixture/instant", params: {} },
        {
          jsonrpc: "2.0",
          id: 921,
          method: "session/request_permission",
          params: {
            sessionId: "cancel-batch",
            title: "Cancel this batch",
            options: [{ optionId: "reject-once", name: "Deny", kind: "reject_once" }]
          }
        }
      ]);
      return;
    }
    send([
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "cancel-batch",
          update: {
            sessionUpdate: "agent_message",
            content: { type: "text", text: "RECOVERED" },
            messageId: "replacement-batch"
          }
        }
      },
      { jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } }
    ]);
    return;
  }
  if (Array.isArray(message)) {
    const permissionCancelled = message.some((entry) => (
      entry.id === 921 && entry.result?.outcome?.outcome === "cancelled"
    ));
    if (permissionCancelled) {
      send([
        { jsonrpc: "2.0", id: 999_999, result: { ignored: true } },
        { jsonrpc: "2.0", id: cancelledPromptId, result: { stopReason: "cancelled" } }
      ]);
    }
  }
});
`;

const PUBLIC_BATCH_FAILURE_ACP = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const mode = process.argv[1];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let sessionId = "public-batch-session";
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
    const server = message.params?.mcpServers?.find((candidate) => (
      candidate.name === "openbot-computer-help"
    ));
    identity = server?.env?.find((entry) => (
      entry.name === "OPENBOT_COMPUTER_HELP_IDENTITY"
    ))?.value ?? null;
    generationFile = server?.env?.find((entry) => (
      entry.name === "OPENBOT_COMPUTER_HELP_GENERATION_FILE"
    ))?.value ?? null;
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
    send([
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message",
            messageId: "batch-recovery",
            content: { type: "text", text: "Recovered on a fresh batch client." }
          }
        }
      },
      { jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } }
    ]);
    return;
  }
  send([
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message",
          messageId: "batch-committed",
          content: { type: "text", text: "Committed before batch overflow." }
        }
      }
    },
    {
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
    },
    {
      jsonrpc: "2.0",
      id: 40_002,
      method: "session/request_permission",
      params: {
        sessionId,
        title: "PRIVATE-BATCH-PERMISSION",
        toolCall: { title: "PRIVATE-BATCH-COMMAND", kind: "execute" },
        options: [
          { optionId: "allow-private", name: "Allow", kind: "allow_once" },
          { optionId: "reject-private", name: "Deny", kind: "reject_once" }
        ]
      }
    }
  ]);
  setTimeout(() => {
    const privateText = "PRIVATE-BATCH-UNCOMMITTED-" + "u".repeat(64 * 1024);
    for (let index = 0; index < 17; index += 1) {
      send([{
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "batch-uncommitted",
            content: { type: "text", text: privateText }
          }
        }
      }]);
    }
  }, 100);
});
`;

const REVERSE_DELAYED_RESPONSES_ACP = String.raw`
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
    const server = message.params?.mcpServers?.find((candidate) => (
      candidate.name === "openbot-computer-help"
    ));
    identity = server?.env?.find((entry) => (
      entry.name === "OPENBOT_COMPUTER_HELP_IDENTITY"
    ))?.value ?? null;
    generationFile = server?.env?.find((entry) => (
      entry.name === "OPENBOT_COMPUTER_HELP_GENERATION_FILE"
    ))?.value ?? null;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "reverse-batch" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    send([
      {
        jsonrpc: "2.0",
        id: 930,
        method: "session/request_permission",
        params: {
          sessionId: "reverse-batch",
          title: "Permission first in source order",
          options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }]
        }
      },
      {
        jsonrpc: "2.0",
        id: 931,
        method: "elicitation/create",
        params: {
          sessionId: "reverse-batch",
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
      }
    ]);
    return;
  }
  if (Array.isArray(message)) {
    const correct = message.length === 2
      && message[0]?.id === 930
      && message[0]?.result?.outcome?.optionId === "allow-once"
      && message[1]?.id === 931
      && message[1]?.result?.action === "accept";
    if (correct) {
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    }
  }
});
`;

async function within<T>(promise: Promise<T>, milliseconds = 1_000): Promise<T> {
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

function processGroupExists(groupId: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessGroupGone(groupId: number): Promise<void> {
  const deadline = Date.now() + 1_000;
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

type PublicBatchBot = {
  write: boolean;
  permission?: {
    cardId?: string;
    options?: Array<{ optionId?: string }>;
  } | null;
  needsYou?: { reason?: string } | null;
  messages: Array<{
    id: string;
    text?: string;
    card?: {
      kind?: string;
      actions?: Array<{ label?: string }>;
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

async function getBot(box: RunningBox, cookie: string, botId: string): Promise<PublicBatchBot> {
  const response = await fetch(`${box.url}/api/bots/${botId}`, { headers: { cookie } });
  assert.equal(response.status, 200);
  return response.json() as Promise<PublicBatchBot>;
}

async function waitForBot(
  box: RunningBox,
  cookie: string,
  botId: string,
  predicate: (bot: PublicBatchBot) => boolean,
): Promise<PublicBatchBot> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const bot = await getBot(box, cookie, botId);
    if (predicate(bot)) return bot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for batch Bot state");
}

test("AcpClient correlates a pending response delivered in one batch frame", async () => {
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", BATCH_INITIALIZE_ACP],
    env: { ...process.env },
  }, process.cwd());
  try {
    assert.deepEqual(await within(acp.initialize()), { authMethods: [] });
  } finally {
    acp.close();
  }
});

test("AcpClient groups request responses after dispatching batch notifications in source order", async () => {
  const assistant: string[] = [];
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", GROUPED_REQUESTS_ACP],
    env: { ...process.env },
  }, process.cwd(), {
    onAssistant(text) {
      assistant.push(text);
    },
  });
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    assert.equal(await within(acp.prompt("exercise grouped responses")), "BATCH");
    assert.deepEqual(assistant, ["BATCH"]);
  } finally {
    acp.close();
  }
});

test("AcpClient preserves valid batch siblings around an invalid call-shaped entry", async () => {
  const assistant: string[] = [];
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", GROUPED_REQUESTS_ACP, "invalid"],
    env: { ...process.env },
  }, process.cwd(), {
    onAssistant(text) {
      assistant.push(text);
    },
  });
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    assert.equal(await within(acp.prompt("preserve valid batch siblings")), "BATCH");
    assert.deepEqual(assistant, ["BATCH"]);
  } finally {
    acp.close();
  }
});

test("AcpClient waits for a delayed permission before flushing one grouped response", async () => {
  let resolvePermission!: (rpcId: number | string) => void;
  const permission = new Promise<number | string>((resolve) => { resolvePermission = resolve; });
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", DELAYED_PERMISSION_ACP],
    env: { ...process.env },
  }, process.cwd(), {
    onPermission(prompt) {
      resolvePermission(prompt.rpcId);
    },
  });
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    const prompting = acp.prompt("wait for a human response");
    const rpcId = await within(permission);
    assert.equal(rpcId, 701);
    await within(acp.respondPermission(rpcId, "allow-once"));
    assert.equal(await within(prompting), "");
  } finally {
    acp.close();
  }
});

test("AcpClient completes two same-batch reentrant permission handlers", async () => {
  const handlerCalls: Array<number | string> = [];
  let acp!: AcpClient;
  acp = new AcpClient({
    command: process.execPath,
    args: ["-e", TWO_REENTRANT_PERMISSIONS_ACP],
    env: { ...process.env },
  }, process.cwd(), {
    async onPermission(prompt) {
      handlerCalls.push(prompt.rpcId);
      await acp.respondPermission(prompt.rpcId, "allow-once");
    },
  });
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    const outcome = await Promise.race([
      acp.prompt("two reentrant permissions").then(() => "complete" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 350)),
    ]);
    assert.deepEqual({ handlerCalls, outcome }, {
      handlerCalls: [701, 702],
      outcome: "complete",
    });
  } finally {
    acp.close();
  }
});

test("AcpClient marks a one-entry batch handler throw after its response flush", async () => {
  let handlerCalls = 0;
  let acp!: AcpClient;
  acp = new AcpClient({
    command: process.execPath,
    args: ["-e", POST_FLUSH_HANDLER_THROW_ACP, "batch-one"],
    env: { ...process.env },
  }, process.cwd(), {
    async onPermission(prompt) {
      handlerCalls += 1;
      await acp.respondPermission(prompt.rpcId, "allow-once");
      throw new Error("PRIVATE-AFTER-FLUSH-HANDLER");
    },
  }, { terminateGraceMs: 25 });
  const pid = acp.pid;
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    let settlements = 0;
    const prompting = acp.prompt("throw after one-entry batch response flush");
    void prompting.then(
      () => { settlements += 1; },
      () => { settlements += 1; },
    );
    await assert.rejects(
      within(prompting),
      (error: unknown) => {
        assert.equal((error as Error).message, "ACP transport callback failed");
        assert.equal(acpResponseWasFlushed(error), true);
        assert.doesNotMatch(
          String(error),
          /PRIVATE-AFTER-FLUSH-HANDLER|stack|credential|\/Users\//i,
        );
        return true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settlements, 1);
    assert.equal(handlerCalls, 1);
  } finally {
    acp.close();
    if (pid) await waitForProcessGroupGone(pid);
  }
});

test("AcpClient marks a standalone handler throw after its response flush", async () => {
  let handlerCalls = 0;
  let acp!: AcpClient;
  acp = new AcpClient({
    command: process.execPath,
    args: ["-e", POST_FLUSH_HANDLER_THROW_ACP, "standalone"],
    env: { ...process.env },
  }, process.cwd(), {
    async onPermission(prompt) {
      handlerCalls += 1;
      await acp.respondPermission(prompt.rpcId, "allow-once");
      throw new Error("PRIVATE-STANDALONE-AFTER-FLUSH");
    },
  }, { terminateGraceMs: 25 });
  const pid = acp.pid;
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    let settlements = 0;
    const prompting = acp.prompt("throw after standalone response flush");
    void prompting.then(
      () => { settlements += 1; },
      () => { settlements += 1; },
    );
    await assert.rejects(
      within(prompting),
      (error: unknown) => {
        assert.equal((error as Error).message, "ACP transport callback failed");
        assert.equal(acpResponseWasFlushed(error), true);
        assert.doesNotMatch(
          String(error),
          /PRIVATE-STANDALONE-AFTER-FLUSH|stack|credential|\/Users\//i,
        );
        return true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settlements, 1);
    assert.equal(handlerCalls, 1);
  } finally {
    acp.close();
    if (pid) await waitForProcessGroupGone(pid);
  }
});

test("AcpClient marks every active handler in one grouped response write", async () => {
  const handlerCalls: Array<number | string> = [];
  const postFlushCalls: Array<number | string> = [];
  let acp!: AcpClient;
  acp = new AcpClient({
    command: process.execPath,
    args: ["-e", POST_FLUSH_HANDLER_THROW_ACP, "batch-two"],
    env: { ...process.env },
  }, process.cwd(), {
    async onPermission(prompt) {
      handlerCalls.push(prompt.rpcId);
      await acp.respondPermission(prompt.rpcId, "allow-once");
      postFlushCalls.push(prompt.rpcId);
      if (prompt.rpcId === 701) {
        throw new Error("PRIVATE-GROUPED-AFTER-FLUSH");
      }
    },
  }, { terminateGraceMs: 25 });
  const pid = acp.pid;
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    let settlements = 0;
    const prompting = acp.prompt("throw after grouped response flush");
    void prompting.then(
      () => { settlements += 1; },
      () => { settlements += 1; },
    );
    await assert.rejects(
      within(prompting),
      (error: unknown) => {
        assert.equal((error as Error).message, "ACP transport callback failed");
        assert.equal(acpResponseWasFlushed(error), true);
        assert.doesNotMatch(
          String(error),
          /PRIVATE-GROUPED-AFTER-FLUSH|stack|credential|\/Users\//i,
        );
        return true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settlements, 1);
    assert.deepEqual(handlerCalls, [701, 702]);
    assert.deepEqual(postFlushCalls, [701, 702]);
  } finally {
    acp.close();
    if (pid) await waitForProcessGroupGone(pid);
  }
});

test("AcpClient keeps a pre-flush batch handler throw marked unflushed", async () => {
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", POST_FLUSH_HANDLER_THROW_ACP, "batch-one"],
    env: { ...process.env },
  }, process.cwd(), {
    onPermission() {
      throw new Error("PRIVATE-BEFORE-BATCH-FLUSH");
    },
  }, { terminateGraceMs: 25 });
  const pid = acp.pid;
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    let settlements = 0;
    const prompting = acp.prompt("throw before batch response flush");
    void prompting.then(
      () => { settlements += 1; },
      () => { settlements += 1; },
    );
    await assert.rejects(
      within(prompting),
      (error: unknown) => {
        assert.equal((error as Error).message, "ACP transport callback failed");
        assert.equal(acpResponseWasFlushed(error), false);
        assert.doesNotMatch(
          String(error),
          /PRIVATE-BEFORE-BATCH-FLUSH|stack|credential|\/Users\//i,
        );
        return true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settlements, 1);
  } finally {
    acp.close();
    if (pid) await waitForProcessGroupGone(pid);
  }
});

test("AcpClient completes reentrant permission and Computer-help handlers in batch order", async () => {
  const handlerOrder: Array<number | string> = [];
  const commitOrder: Array<number | string> = [];
  let acp!: AcpClient;
  acp = new AcpClient({
    command: process.execPath,
    args: ["-e", REVERSE_DELAYED_RESPONSES_ACP],
    env: { ...process.env },
  }, process.cwd(), {
    async onPermission(prompt) {
      handlerOrder.push(prompt.rpcId);
      await acp.respondPermission(prompt.rpcId, "allow-once", () => {
        commitOrder.push(prompt.rpcId);
      });
    },
    async onComputerHelp(prompt) {
      handlerOrder.push(prompt.rpcId);
      await acp.respondComputerHelp(prompt.rpcId, "done", () => {
        commitOrder.push(prompt.rpcId);
      });
    },
  });
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    assert.equal(await within(acp.prompt("mixed reentrant batch")), "");
    assert.deepEqual(handlerOrder, [930, 931]);
    assert.deepEqual(commitOrder, [930, 931]);
  } finally {
    acp.close();
  }
});

test("AcpClient does not let same-batch response handlers bypass a blocked unrelated callback", async () => {
  let assistantStarted!: () => void;
  const blocked = new Promise<void>((resolve) => { assistantStarted = resolve; });
  let releaseAssistant!: () => void;
  const release = new Promise<void>((resolve) => { releaseAssistant = resolve; });
  const handlerCalls: Array<number | string> = [];
  let acp!: AcpClient;
  acp = new AcpClient({
    command: process.execPath,
    args: ["-e", TWO_REENTRANT_PERMISSIONS_ACP, "blocked"],
    env: { ...process.env },
  }, process.cwd(), {
    onAssistant() {
      assistantStarted();
      return release;
    },
    async onPermission(prompt) {
      handlerCalls.push(prompt.rpcId);
      await acp.respondPermission(prompt.rpcId, "allow-once");
    },
  });
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    const prompting = acp.prompt("blocked unrelated callback");
    await within(blocked);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(handlerCalls, []);
    releaseAssistant();
    assert.equal(await within(prompting), "BLOCK");
    assert.deepEqual(handlerCalls, [701, 702]);
  } finally {
    releaseAssistant();
    acp.close();
  }
});

test("AcpClient advances an interleaved same-batch callback without bypassing it", async () => {
  let assistantStarted!: () => void;
  const reachedAssistant = new Promise<void>((resolve) => { assistantStarted = resolve; });
  let releaseAssistant!: () => void;
  const release = new Promise<void>((resolve) => { releaseAssistant = resolve; });
  let secondResponseFlushed!: () => void;
  const groupedResponseFlushed = new Promise<void>((resolve) => { secondResponseFlushed = resolve; });
  const callbackOrder: string[] = [];
  let acp!: AcpClient;
  acp = new AcpClient({
    command: process.execPath,
    args: ["-e", TWO_REENTRANT_PERMISSIONS_ACP, "interleaved"],
    env: { ...process.env },
  }, process.cwd(), {
    async onPermission(prompt) {
      callbackOrder.push(`permission:${prompt.rpcId}`);
      await acp.respondPermission(prompt.rpcId, "allow-once");
      if (prompt.rpcId === 702) secondResponseFlushed();
    },
    onAssistant(text) {
      callbackOrder.push(`assistant:${text}`);
      if (text === "BETWEEN") {
        assistantStarted();
        return release;
      }
    },
  });
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    const prompting = acp.prompt("interleaved same-batch callback");
    await within(reachedAssistant, 350);
    await within(groupedResponseFlushed, 350);
    assert.deepEqual(callbackOrder, [
      "permission:701",
      "assistant:BETWEEN",
      "permission:702",
    ]);
    assert.equal(await Promise.race([
      prompting.then(() => "complete" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 30)),
    ]), "pending");
    releaseAssistant();
    assert.equal(await within(prompting), "BETWEENOUTSIDE");
    assert.deepEqual(callbackOrder, [
      "permission:701",
      "assistant:BETWEEN",
      "permission:702",
      "assistant:OUTSIDE",
    ]);
  } finally {
    releaseAssistant();
    acp.close();
  }
});

test("AcpClient contains ordered same-batch post-flush commits exactly once", async () => {
  const handlerCalls: Array<number | string> = [];
  const commitCalls: Array<number | string> = [];
  let acp!: AcpClient;
  acp = new AcpClient({
    command: process.execPath,
    args: ["-e", TWO_REENTRANT_PERMISSIONS_ACP],
    env: { ...process.env },
  }, process.cwd(), {
    async onPermission(prompt) {
      handlerCalls.push(prompt.rpcId);
      await acp.respondPermission(prompt.rpcId, "allow-once", () => {
        commitCalls.push(prompt.rpcId);
        if (prompt.rpcId === 702) throw new Error("PRIVATE-SECOND-BATCH-COMMIT");
      });
    },
  }, { terminateGraceMs: 25 });
  const pid = acp.pid;
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    let settlements = 0;
    const prompting = acp.prompt("ordered batch commit failure");
    void prompting.then(
      () => { settlements += 1; },
      () => { settlements += 1; },
    );
    await assert.rejects(
      within(prompting),
      (error: unknown) => {
        assert.equal((error as Error).message, "ACP transport callback failed");
        assert.equal(acpResponseWasFlushed(error), true);
        assert.doesNotMatch(String(error), /PRIVATE-SECOND-BATCH-COMMIT|stack|credential|\/Users\//i);
        return true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settlements, 1);
    assert.deepEqual(handlerCalls, [701, 702]);
    assert.deepEqual(commitCalls, [701, 702]);
    if (pid) await waitForProcessGroupGone(pid);
  } finally {
    acp.close();
  }
});

test("AcpClient contains cancellation while same-batch response callbacks are yielded", async () => {
  let thirdStarted!: () => void;
  const reachedThird = new Promise<void>((resolve) => { thirdStarted = resolve; });
  const never = new Promise<void>(() => undefined);
  const handlerCalls: Array<number | string> = [];
  const commitCalls: Array<number | string> = [];
  let acp!: AcpClient;
  acp = new AcpClient({
    command: process.execPath,
    args: ["-e", TWO_REENTRANT_PERMISSIONS_ACP, "three"],
    env: { ...process.env },
  }, process.cwd(), {
    async onPermission(prompt) {
      handlerCalls.push(prompt.rpcId);
      if (prompt.rpcId === 703) {
        thirdStarted();
        await never;
        return;
      }
      await acp.respondPermission(prompt.rpcId, "allow-once", () => {
        commitCalls.push(prompt.rpcId);
      });
    },
  }, { terminateGraceMs: 25 });
  const pid = acp.pid;
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    let settlements = 0;
    const prompting = acp.prompt("cancel yielded batch callbacks");
    void prompting.then(
      () => { settlements += 1; },
      () => { settlements += 1; },
    );
    await within(reachedThird);
    assert.equal(acp.cancel(), false);
    await assert.rejects(
      within(prompting),
      (error: unknown) => {
        assert.equal((error as Error).message, "cancelled");
        assert.equal(cancellationClosedTransport(error), true);
        assert.equal(acpResponseWasFlushed(error), false);
        return true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settlements, 1);
    assert.deepEqual(handlerCalls, [701, 702, 703]);
    assert.deepEqual(commitCalls, []);
    if (pid) await waitForProcessGroupGone(pid);
  } finally {
    acp.close();
  }
});

test("AcpClient dispatches every batch entry before settling an earlier prompt response", async () => {
  let resolveAssistantStarted!: () => void;
  const assistantStarted = new Promise<void>((resolve) => { resolveAssistantStarted = resolve; });
  let releaseAssistant!: () => void;
  const assistantBlocked = new Promise<void>((resolve) => { releaseAssistant = resolve; });
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", RESPONSE_BEFORE_UPDATE_ACP],
    env: { ...process.env },
  }, process.cwd(), {
    onAssistant() {
      resolveAssistantStarted();
      return assistantBlocked;
    },
  });
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    let settled = false;
    const prompting = acp.prompt("settle after all batch callbacks").then((value) => {
      settled = true;
      return value;
    });
    await within(assistantStarted);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    releaseAssistant();
    assert.equal(await within(prompting), "AFTER");
  } finally {
    releaseAssistant();
    acp.close();
  }
});

test("AcpClient answers an empty batch with one standalone Invalid Request", async () => {
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", EMPTY_BATCH_ACP],
    env: { ...process.env },
  }, process.cwd());
  try {
    assert.deepEqual(await within(acp.initialize()), { authMethods: [] });
  } finally {
    acp.close();
  }
});

test("AcpClient emits nothing for a notification-only batch", async () => {
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", NOTIFICATION_ONLY_ACP],
    env: { ...process.env },
  }, process.cwd());
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    assert.equal(await within(acp.prompt("notification-only batch")), "SILENT");
  } finally {
    acp.close();
  }
});

test("AcpClient ignores malformed and unknown response-only siblings without answering them", async () => {
  const stderr: string[] = [];
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", MALFORMED_RESPONSE_SIBLINGS_ACP],
    env: { ...process.env },
  }, process.cwd(), {
    onStderr(line) {
      stderr.push(line);
    },
  });
  try {
    assert.deepEqual(await within(acp.initialize()), { authMethods: [] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(stderr, []);
  } finally {
    acp.close();
  }
});

test("AcpClient fails a malformed batch response that claims its active prompt id", async () => {
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", MATCHING_MALFORMED_RESPONSE_ACP],
    env: { ...process.env },
  }, process.cwd());
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    await assert.rejects(
      within(acp.prompt("PRIVATE-MALFORMED-PENDING"), 350),
      (error: unknown) => {
        assert.equal((error as Error).message, "ACP transport protocol error");
        assert.doesNotMatch(String(error), /PRIVATE-MALFORMED-PENDING|payload|stack|credential|\/Users\//i);
        return true;
      },
    );
  } finally {
    acp.close();
  }

  const fresh = new AcpClient({
    command: process.execPath,
    args: ["-e", GROUPED_REQUESTS_ACP],
    env: { ...process.env },
  }, process.cwd());
  try {
    await within(fresh.initialize());
    await within(fresh.newSession(process.cwd()));
    assert.equal(await within(fresh.prompt("fresh after malformed response")), "BATCH");
  } finally {
    fresh.close();
  }
});

test("AcpClient fails a mixed malformed batch envelope that claims its active prompt id", async () => {
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", MATCHING_MIXED_ENVELOPE_ACP],
    env: { ...process.env },
  }, process.cwd());
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    await assert.rejects(
      within(acp.prompt("PRIVATE-MIXED-MATCHING-ID"), 350),
      (error: unknown) => {
        assert.equal((error as Error).message, "ACP transport protocol error");
        assert.doesNotMatch(
          String(error),
          /PRIVATE-MIXED-MATCHING-ID|fixture\/illegal|payload|stack|credential|\/Users\//i,
        );
        return true;
      },
    );
  } finally {
    acp.close();
  }
});

test("AcpClient lets a matching mixed envelope defeat an earlier valid sibling", async () => {
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", MATCHING_MIXED_ENVELOPE_ACP, "valid-first"],
    env: { ...process.env },
  }, process.cwd());
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    await assert.rejects(
      within(acp.prompt("valid result before matching mixed envelope"), 350),
      /ACP transport protocol error/,
    );
  } finally {
    acp.close();
  }
});

test("AcpClient keeps a method-only invalid call separate from an overlapping outbound id", async () => {
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", MATCHING_MIXED_ENVELOPE_ACP, "invalid-call-overlap"],
    env: { ...process.env },
  }, process.cwd());
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    assert.equal(await within(acp.prompt("overlapping bidirectional numeric id")), "");
  } finally {
    acp.close();
  }
});

test("AcpClient lets a matching malformed response defeat an earlier valid sibling", async () => {
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", MATCHING_MALFORMED_RESPONSE_ACP, "valid-first"],
    env: { ...process.env },
  }, process.cwd());
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    await assert.rejects(
      within(acp.prompt("valid sibling must not win"), 350),
      /ACP transport protocol error/,
    );
  } finally {
    acp.close();
  }
});

test("AcpClient fails a malformed batch response that claims its cancelled prompt drain", async () => {
  let ready!: () => void;
  const childReady = new Promise<void>((resolve) => { ready = resolve; });
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", MATCHING_MALFORMED_RESPONSE_ACP, "cancelled"],
    env: { ...process.env },
  }, process.cwd(), {
    onAssistant(text) {
      if (text === "READY") ready();
    },
  });
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    const prompting = acp.prompt("cancel before malformed drain response");
    await within(childReady);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(acp.cancel(), true);
    await assert.rejects(within(prompting), /cancelled/);
    await assert.rejects(
      within(acp.prompt("replacement after malformed drain"), 350),
      /ACP transport protocol error/,
    );
  } finally {
    acp.close();
  }
});

test("AcpClient waits for delayed Computer help before flushing one grouped response", async () => {
  let resolveComputerHelp!: (rpcId: number | string) => void;
  const computerHelp = new Promise<number | string>((resolve) => {
    resolveComputerHelp = resolve;
  });
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", DELAYED_COMPUTER_HELP_ACP],
    env: { ...process.env },
  }, process.cwd(), {
    onComputerHelp(prompt) {
      resolveComputerHelp(prompt.rpcId);
    },
  });
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    const prompting = acp.prompt("wait for Computer help");
    const rpcId = await within(computerHelp);
    assert.equal(rpcId, 801);
    await within(acp.respondComputerHelp(rpcId, "done"));
    assert.equal(await within(prompting), "");
  } finally {
    acp.close();
  }
});

test("AcpClient suppresses an exact duplicate Computer-help entry without stranding its batch", async () => {
  let calls = 0;
  let resolveComputerHelp!: (rpcId: number | string) => void;
  const computerHelp = new Promise<number | string>((resolve) => {
    resolveComputerHelp = resolve;
  });
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", DELAYED_COMPUTER_HELP_ACP, "duplicate"],
    env: { ...process.env },
  }, process.cwd(), {
    onComputerHelp(prompt) {
      calls += 1;
      resolveComputerHelp(prompt.rpcId);
    },
  });
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    const prompting = acp.prompt("suppress duplicate Computer help");
    const rpcId = await within(computerHelp);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    await within(acp.respondComputerHelp(rpcId, "done"));
    assert.equal(await within(prompting), "");
  } finally {
    acp.close();
  }
});

test("AcpClient counts one batch frame plus its elements at the exact item ceiling", async () => {
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", ITEM_CEILING_ACP, "allowed"],
    env: { ...process.env },
  }, process.cwd(), {}, { terminateGraceMs: 25 });
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    assert.equal(await within(acp.prompt("exact item ceiling"), 2_000), "");
  } finally {
    const pid = acp.pid;
    acp.close();
    if (pid) await waitForProcessGroupGone(pid);
  }
});

test("AcpClient rejects batch element overflow before dispatch and admits a fresh client", async () => {
  let assistantCalls = 0;
  const broken = new AcpClient({
    command: process.execPath,
    args: ["-e", ITEM_CEILING_ACP, "overflow"],
    env: { ...process.env },
  }, process.cwd(), {
    onAssistant() {
      assistantCalls += 1;
    },
  }, { terminateGraceMs: 25 });
  const brokenPid = broken.pid;
  try {
    await within(broken.initialize());
    await within(broken.newSession(process.cwd()));
    await assert.rejects(
      within(broken.prompt("overflow before dispatch"), 2_000),
      (error: unknown) => {
        assert.equal((error as Error).message, "ACP transport protocol error");
        assert.doesNotMatch(String(error), /MUST-NOT-DISPATCH|payload|stack|credential|\/Users\//i);
        return true;
      },
    );
    assert.equal(assistantCalls, 0);
    if (brokenPid) await waitForProcessGroupGone(brokenPid);
  } finally {
    broken.close();
  }

  const fresh = new AcpClient({
    command: process.execPath,
    args: ["-e", GROUPED_REQUESTS_ACP],
    env: { ...process.env },
  }, process.cwd());
  try {
    await within(fresh.initialize());
    await within(fresh.newSession(process.cwd()));
    assert.equal(await within(fresh.prompt("fresh after overflow")), "BATCH");
  } finally {
    fresh.close();
  }
});

test("AcpClient applies active and unique server-request ceilings to batch elements", async (t) => {
  for (const mode of ["active16", "unique128"] as const) {
    await t.test(`allows ${mode} at the exact ceiling`, async () => {
      const acp = new AcpClient({
        command: process.execPath,
        args: ["-e", SERVER_REQUEST_CEILING_ACP, mode],
        env: { ...process.env },
      }, process.cwd(), {}, { terminateGraceMs: 25 });
      try {
        await within(acp.initialize());
        await within(acp.newSession(process.cwd()));
        assert.equal(await within(acp.prompt(mode), 2_000), "");
      } finally {
        const pid = acp.pid;
        acp.close();
        if (pid) await waitForProcessGroupGone(pid);
      }
    });
  }

  for (const mode of ["active17", "unique129"] as const) {
    await t.test(`fails ${mode} before unbounded work`, async () => {
      const acp = new AcpClient({
        command: process.execPath,
        args: ["-e", SERVER_REQUEST_CEILING_ACP, mode],
        env: { ...process.env },
      }, process.cwd(), {}, { terminateGraceMs: 25 });
      const pid = acp.pid;
      try {
        await within(acp.initialize());
        await within(acp.newSession(process.cwd()));
        await assert.rejects(
          within(acp.prompt(mode), 2_000),
          (error: unknown) => {
            assert.equal((error as Error).message, "ACP transport protocol error");
            assert.doesNotMatch(String(error), /Bounded request|payload|stack|credential|\/Users\//i);
            return true;
          },
        );
        if (pid) await waitForProcessGroupGone(pid);
      } finally {
        acp.close();
      }
    });
  }
});

test("AcpClient fails duplicate, cross-kind, and terminal-id races inside one batch", async (t) => {
  for (const mode of ["duplicate", "cross-kind", "terminal"] as const) {
    await t.test(mode, async () => {
      let permissions = 0;
      let computerHelp = 0;
      const acp = new AcpClient({
        command: process.execPath,
        args: ["-e", DUPLICATE_BATCH_ACP, mode],
        env: { ...process.env },
      }, process.cwd(), {
        onPermission() {
          permissions += 1;
        },
        onComputerHelp() {
          computerHelp += 1;
        },
      }, { terminateGraceMs: 25 });
      const pid = acp.pid;
      try {
        await within(acp.initialize());
        await within(acp.newSession(process.cwd()));
        let settlements = 0;
        const prompting = acp.prompt(mode);
        void prompting.then(
          () => { settlements += 1; },
          () => { settlements += 1; },
        );
        await assert.rejects(
          within(prompting, 2_000),
          (error: unknown) => {
            assert.equal((error as Error).message, "ACP transport protocol error");
            assert.doesNotMatch(
              String(error),
              /PRIVATE-DUPLICATE|PRIVATE-CROSS-KIND|payload|stack|credential|\/Users\//i,
            );
            return true;
          },
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(settlements, 1);
        assert.equal(permissions, mode === "terminal" ? 0 : 1);
        assert.equal(computerHelp, 0);
        if (pid) await waitForProcessGroupGone(pid);
      } finally {
        acp.close();
      }
    });
  }
});

test("AcpClient cancels a delayed batch request, drains its terminal, and reuses the client", async () => {
  let permissionCalls = 0;
  let resolvePermission!: () => void;
  const permission = new Promise<void>((resolve) => { resolvePermission = resolve; });
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", CANCELLATION_BATCH_ACP],
    env: { ...process.env },
  }, process.cwd(), {
    onPermission() {
      permissionCalls += 1;
      resolvePermission();
    },
  });
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    const cancelled = acp.prompt("cancel grouped work");
    await within(permission);
    assert.equal(acp.cancel(), true);
    await assert.rejects(within(cancelled), /cancelled/);
    assert.equal(await within(acp.prompt("replacement after grouped cancellation")), "RECOVERED");
    assert.equal(permissionCalls, 1);
  } finally {
    acp.close();
  }
});

test("Talk contains one batch failure, expires actions, preserves bubbles, and recovers", {
  skip: process.platform === "win32",
}, async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-batch-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-batch-pwa-"));
  await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
  const clients: AcpClient[] = [];
  const pids: number[] = [];
  let spawned = 0;
  const spawnAcp = (
    _spec: SpawnSpec,
    cwd: string,
    handlers: AcpHandlers = {},
  ): AcpClient => {
    spawned += 1;
    const client = new AcpClient({
      command: process.execPath,
      args: ["-e", PUBLIC_BATCH_FAILURE_ACP, spawned === 1 ? "overflow" : "healthy"],
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
      body: JSON.stringify({ text: "Contain this batch failure." }),
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
      failed.messages.filter((message) => message.text === "Committed before batch overflow.").length,
      1,
    );
    assert.equal(
      failed.messages.filter((message) => message.text?.includes("PRIVATE-BATCH-UNCOMMITTED") ?? false).length,
      0,
    );
    assert.equal(failed.messages.filter((message) => message.card?.kind === "bot-failure").length, 1);
    const permissions = failed.messages.filter((message) => message.card?.kind === "permission");
    assert.equal(permissions.length, 1);
    assert.equal(permissions[0]?.card?.actions?.length, 0);
    const computers = failed.messages.filter((message) => message.card?.kind === "computer");
    assert.equal(computers.length, 1);
    assert.deepEqual(computers[0]?.card?.actions?.map((action) => action.label), ["Open computer"]);
    assert.doesNotMatch(
      JSON.stringify(failed),
      /PRIVATE-|ACP transport protocol error|node:|\/Users\//,
    );
    assert.equal(pids.length, 1);
    await waitForProcessGroupGone(pids[0]);

    await new Promise((resolve) => setTimeout(resolve, 30));
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
      && bot.messages.some((message) => message.text === "Recovered on a fresh batch client.")
    ));
    assert.equal(spawned, 2);
    assert.equal(
      recovered.messages.filter((message) => message.text === "Committed before batch overflow.").length,
      1,
    );
    assert.equal(
      recovered.messages.filter((message) => message.text === "Recovered on a fresh batch client.").length,
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
    await box.close();
    await rm(homeDir, { recursive: true, force: true });
    await rm(pwaDir, { recursive: true, force: true });
  }
});

test("Talk commits a permission Card only after its grouped batch response flushes", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-batch-permission-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-batch-permission-pwa-"));
  await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
  const clients: AcpClient[] = [];
  const pids: number[] = [];
  const spawnAcp = (
    _spec: SpawnSpec,
    cwd: string,
    handlers: AcpHandlers = {},
  ): AcpClient => {
    const client = new AcpClient({
      command: process.execPath,
      args: ["-e", DELAYED_PERMISSION_ACP],
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
      body: JSON.stringify({ text: "Resolve the grouped permission." }),
    });
    assert.equal(sent.status, 200);
    const pending = await waitForBot(box, cookie, botId, (bot) => Boolean(bot.permission?.cardId));
    const cardId = pending.permission?.cardId;
    assert.equal(typeof cardId, "string");
    const answered = await fetch(`${box.url}/api/bots/${botId}/permissions`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ cardId, optionId: "allow-once" }),
    });
    assert.equal(answered.status, 200);
    assert.doesNotMatch(
      await answered.text(),
      /PRIVATE-|ACP transport|payload|stack|credential|\/Users\//i,
    );
    const resolved = await waitForBot(box, cookie, botId, (bot) => (
      bot.write === false && bot.permission === null
    ));
    const card = resolved.messages.find((message) => message.id === cardId);
    assert.equal(card?.card?.kind, "permission");
    assert.equal(card?.card?.actions?.length, 0);
    assert.equal(resolved.messages.some((message) => message.card?.kind === "bot-failure"), false);
    assert.doesNotMatch(
      JSON.stringify(resolved),
      /PRIVATE-|ACP transport|payload|stack|credential|\/Users\//i,
    );
  } finally {
    for (const client of clients) client.close();
    for (const pid of pids) await waitForProcessGroupGone(pid);
    await box.close();
    await rm(homeDir, { recursive: true, force: true });
    await rm(pwaDir, { recursive: true, force: true });
  }
});

test("AcpClient flushes delayed responses in source order when humans resolve them in reverse", async () => {
  let resolvePermission!: (rpcId: number | string) => void;
  const permission = new Promise<number | string>((resolve) => { resolvePermission = resolve; });
  let resolveComputer!: (rpcId: number | string) => void;
  const computer = new Promise<number | string>((resolve) => { resolveComputer = resolve; });
  const commits: string[] = [];
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", REVERSE_DELAYED_RESPONSES_ACP],
    env: { ...process.env },
  }, process.cwd(), {
    onPermission(prompt) {
      resolvePermission(prompt.rpcId);
    },
    onComputerHelp(prompt) {
      resolveComputer(prompt.rpcId);
    },
  });
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    const prompting = acp.prompt("resolve grouped responses in reverse");
    const [permissionId, computerId] = await Promise.all([
      within(permission),
      within(computer),
    ]);
    let computerSettled = false;
    const computerResponse = acp.respondComputerHelp(computerId, "done", () => {
      commits.push("computer");
    }).then(() => { computerSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(computerSettled, false);
    const permissionResponse = acp.respondPermission(permissionId, "allow-once", () => {
      commits.push("permission");
    });
    await within(Promise.all([permissionResponse, computerResponse]));
    assert.deepEqual(commits, ["permission", "computer"]);
    assert.equal(await within(prompting), "");
  } finally {
    acp.close();
  }
});

test("AcpClient contains a grouped post-flush callback failure exactly once", async () => {
  let resolvePermission!: (rpcId: number | string) => void;
  const permission = new Promise<number | string>((resolve) => { resolvePermission = resolve; });
  const acp = new AcpClient({
    command: process.execPath,
    args: ["-e", DELAYED_PERMISSION_ACP],
    env: { ...process.env },
  }, process.cwd(), {
    onPermission(prompt) {
      resolvePermission(prompt.rpcId);
    },
  }, { terminateGraceMs: 25 });
  const pid = acp.pid;
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    let promptSettlements = 0;
    const prompting = acp.prompt("fail after grouped response flush");
    void prompting.then(
      () => { promptSettlements += 1; },
      () => { promptSettlements += 1; },
    );
    const rpcId = await within(permission);
    await assert.rejects(
      within(acp.respondPermission(rpcId, "allow-once", () => {
        throw new Error("PRIVATE-GROUPED-COMMIT");
      })),
      (error: unknown) => {
        assert.equal(acpResponseWasFlushed(error), true);
        assert.equal((error as Error).message, "ACP transport callback failed");
        assert.doesNotMatch(String(error), /PRIVATE-GROUPED-COMMIT|stack|credential|\/Users\//i);
        return true;
      },
    );
    await assert.rejects(
      within(prompting),
      (error: unknown) => {
        assert.equal(acpResponseWasFlushed(error), true);
        assert.equal((error as Error).message, "ACP transport callback failed");
        return true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(promptSettlements, 1);
    if (pid) await waitForProcessGroupGone(pid);
  } finally {
    acp.close();
  }
});

test("AcpClient lets a batched permission handler await its own flush callback", async () => {
  let committed = false;
  let acp!: AcpClient;
  acp = new AcpClient({
    command: process.execPath,
    args: ["-e", DELAYED_PERMISSION_ACP],
    env: { ...process.env },
  }, process.cwd(), {
    onPermission(prompt) {
      return acp.respondPermission(prompt.rpcId, "allow-once", () => {
        committed = true;
      });
    },
  });
  try {
    await within(acp.initialize());
    await within(acp.newSession(process.cwd()));
    assert.equal(await within(acp.prompt("reentrant grouped permission")), "");
    assert.equal(committed, true);
  } finally {
    acp.close();
  }
});
