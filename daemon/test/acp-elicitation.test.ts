import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AcpClient,
  type ComputerHelpPrompt,
  type PermissionPrompt,
} from "../src/acp.ts";

const FAKE_ACP = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let identity = null;
let generationFile = null;
let delayedGeneration = null;
let promptId = null;
let pendingElicitation = null;
const completionSchema = {
  type: "object",
  properties: {
    completed: { type: "string", enum: ["done"], title: "Completion" }
  },
  required: ["completed"],
  additionalProperties: false
};
const adapterNormalizedCompletionSchema = {
  type: completionSchema.type,
  properties: completionSchema.properties,
  required: completionSchema.required
};
const currentGeneration = () => fs.readFileSync(generationFile, "utf8").trim();
const firstParty = (
  id,
  message = "Complete the visual step on this Computer, then choose I'm done.",
  sessionId = "session-1",
  generation = currentGeneration(),
  requestedSchema = completionSchema
) => send({
  jsonrpc: "2.0",
  id,
  method: "elicitation/create",
  params: {
    sessionId,
    mode: "form",
    message,
    requestedSchema,
    _meta: {
      "openbot/computer-help": {
        kind: "computer-help",
        version: 1,
        identity,
        generation
      }
    }
  }
});
const finishPrompt = (text) => {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "session-1", update: { sessionUpdate: "agent_message", content: { type: "text", text } } }
  });
  send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
};
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    const form = message.params?.clientCapabilities?.elicitation?.form;
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [], _testFormAdvertised: form != null } });
    return;
  }
  if (message.method === "session/new") {
    const server = message.params?.mcpServers?.find((candidate) => candidate.name === "openbot-computer-help");
    identity = server?.env?.find((entry) => entry.name === "OPENBOT_COMPUTER_HELP_IDENTITY")?.value ?? null;
    generationFile = server?.env?.find((entry) => entry.name === "OPENBOT_COMPUTER_HELP_GENERATION_FILE")?.value ?? null;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    const text = message.params?.prompt?.[0]?.text;
    if (text === "arm-delayed") {
      delayedGeneration = currentGeneration();
      finishPrompt("first turn finished");
      return;
    }
    if (text === "receive-delayed") {
      pendingElicitation = 709;
      firstParty(pendingElicitation, undefined, undefined, delayedGeneration);
      return;
    }
    if (text === "ordinary") {
      pendingElicitation = 702;
      send({
        jsonrpc: "2.0",
        id: pendingElicitation,
        method: "elicitation/create",
        params: {
          sessionId: "session-1",
          toolCallId: "request-user-input",
          mode: "form",
          message: "Choose an ordinary answer",
          requestedSchema: {
            type: "object",
            properties: { answer: { type: "string", enum: ["yes", "no"] } },
            required: ["answer"]
          },
          _meta: { codex: { autoResolutionMs: null } }
        }
      });
      return;
    }
    if (text === "malformed") {
      pendingElicitation = 703;
      firstParty(pendingElicitation, "private raw tool input");
      return;
    }
    if (text === "other-session") {
      pendingElicitation = 706;
      firstParty(pendingElicitation, "Complete the visual step on this Computer, then choose I'm done.", "session-2");
      return;
    }
    if (text === "adapter-normalized") {
      pendingElicitation = 707;
      firstParty(
        pendingElicitation,
        undefined,
        undefined,
        undefined,
        adapterNormalizedCompletionSchema
      );
      return;
    }
    if (text === "overflow") {
      for (let index = 0; index < 128; index += 1) {
        send({
          jsonrpc: "2.0",
          id: 900 + index,
          method: "elicitation/create",
          params: {
            sessionId: "session-1",
            mode: "form",
            message: "Ordinary form " + index,
            requestedSchema: {
              type: "object",
              properties: { answer: { type: "string", enum: ["yes"] } },
              required: ["answer"]
            },
            _meta: { codex: { index } }
          }
        });
      }
      pendingElicitation = 2000;
      firstParty(pendingElicitation);
      return;
    }
    if (text === "child-exit") {
      pendingElicitation = 704;
      firstParty(pendingElicitation);
      setTimeout(() => process.exit(0), 20);
      return;
    }
    pendingElicitation = text === "skip" ? 701 : text === "permission-first" ? 705 : 700;
    firstParty(pendingElicitation);
    if (text === "duplicate") firstParty(pendingElicitation);
    return;
  }
  if (message.id === pendingElicitation && message.result) {
    const action = message.result.action;
    const completed = message.result.content?.completed;
    if (pendingElicitation === 705) {
      send({
        jsonrpc: "2.0",
        id: 805,
        method: "session/request_permission",
        params: {
          title: "Permission after resume",
          options: [
            { optionId: "allow-once", name: "Allow", kind: "allow_once" },
            { optionId: "reject-once", name: "Deny", kind: "reject_once" }
          ]
        }
      });
      return;
    }
    finishPrompt(action + ":" + String(completed ?? ""));
    return;
  }
  if (message.id === 805 && message.result) {
    finishPrompt("permission:" + message.result.outcome.optionId);
  }
});
`;

function client(handlers: ConstructorParameters<typeof AcpClient>[2] = {}) {
  return new AcpClient({
    command: process.execPath,
    args: ["-e", FAKE_ACP],
    env: { ...process.env },
  }, process.cwd(), handlers);
}

async function initializedClient(handlers: ConstructorParameters<typeof AcpClient>[2] = {}) {
  const acp = client(handlers);
  await acp.initialize();
  await acp.newSession(process.cwd());
  return acp;
}

function nextPrompt<T>(register: (resolve: (value: T) => void) => void): Promise<T> {
  return Promise.race([
    new Promise<T>((resolve) => register(resolve)),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("timed out waiting for ACP event")), 2_000);
    }),
  ]);
}

describe("ACP Computer-help elicitation", () => {
  test("advertises form elicitation, identifies the first-party event, and sends exact Done and Skip responses", async () => {
    let resolveDone!: (prompt: ComputerHelpPrompt) => void;
    const doneEvent = nextPrompt<ComputerHelpPrompt>((resolve) => { resolveDone = resolve; });
    const done = await initializedClient({ onComputerHelp: resolveDone });
    try {
      const running = done.prompt("done");
      const prompt = await doneEvent;
      let committed = false;
      await done.respondComputerHelp(prompt.rpcId, "done", () => { committed = true; });
      assert.equal(committed, true);
      assert.equal(await running, "accept:done");
      await assert.rejects(done.respondComputerHelp(prompt.rpcId, "done"), /no longer active/);
      assert.equal(done.spec.env.OPENBOT_COMPUTER_HELP_IDENTITY, undefined);
    } finally {
      done.close();
    }

    let resolveSkip!: (prompt: ComputerHelpPrompt) => void;
    const skipEvent = nextPrompt<ComputerHelpPrompt>((resolve) => { resolveSkip = resolve; });
    const skipped = await initializedClient({ onComputerHelp: resolveSkip });
    try {
      const running = skipped.prompt("skip");
      const prompt = await skipEvent;
      await skipped.respondComputerHelp(prompt.rpcId, "skip");
      assert.equal(await running, "decline:");
    } finally {
      skipped.close();
    }
  });

  test("does not map ordinary or malformed forms and suppresses a duplicate first-party request", async () => {
    let calls = 0;
    let resolvePrompt!: (prompt: ComputerHelpPrompt) => void;
    const event = nextPrompt<ComputerHelpPrompt>((resolve) => { resolvePrompt = resolve; });
    const acp = await initializedClient({
      onComputerHelp: (prompt) => {
        calls += 1;
        resolvePrompt(prompt);
      },
    });
    try {
      assert.equal(await acp.prompt("ordinary"), "cancel:");
      assert.equal(await acp.prompt("malformed"), "cancel:");
      assert.equal(await acp.prompt("other-session"), "cancel:");
      const running = acp.prompt("duplicate");
      const prompt = await event;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
      await acp.respondComputerHelp(prompt.rpcId, "done");
      assert.equal(await running, "accept:done");
    } finally {
      acp.close();
    }
  });

  test("accepts the strict one-field Computer-help schema normalized by codex-acp", async () => {
    let resolvePrompt!: (prompt: ComputerHelpPrompt) => void;
    const event = nextPrompt<ComputerHelpPrompt>((resolve) => { resolvePrompt = resolve; });
    const acp = await initializedClient({ onComputerHelp: resolvePrompt });
    try {
      const running = acp.prompt("adapter-normalized");
      const prompt = await event;
      await acp.respondComputerHelp(prompt.rpcId, "done");
      assert.equal(await running, "accept:done");
    } finally {
      acp.close();
    }
  });

  test("allows a completed JSON-RPC id to be reused by a later prompt lifecycle", async () => {
    const events: ComputerHelpPrompt[] = [];
    const waiters: Array<(prompt: ComputerHelpPrompt) => void> = [];
    const acp = await initializedClient({
      onComputerHelp: (prompt) => {
        const waiter = waiters.shift();
        if (waiter) waiter(prompt);
        else events.push(prompt);
      },
    });
    const nextEvent = () => {
      const event = events.shift();
      return event
        ? Promise.resolve(event)
        : nextPrompt<ComputerHelpPrompt>((resolve) => { waiters.push(resolve); });
    };
    try {
      const firstTurn = acp.prompt("done");
      const first = await nextEvent();
      await acp.respondComputerHelp(first.rpcId, "done");
      await firstTurn;

      const secondTurn = acp.prompt("reuse");
      const second = await nextEvent();
      assert.equal(second.rpcId, first.rpcId);
      await acp.respondComputerHelp(second.rpcId, "skip");
      assert.equal(await secondTurn, "decline:");
    } finally {
      acp.close();
    }
  });

  test("rejects a delayed first-party event from the prior prompt generation", async () => {
    let calls = 0;
    const acp = await initializedClient({
      onComputerHelp: () => { calls += 1; },
    });
    try {
      assert.equal(await acp.prompt("arm-delayed"), "first turn finished");
      assert.equal(await acp.prompt("receive-delayed"), "cancel:");
      assert.equal(calls, 0);
    } finally {
      acp.close();
    }
  });

  test("fails closed when a valid first-party event is terminal-ledger cap plus one", async () => {
    const acp = await initializedClient();
    const running = acp.prompt("overflow");
    await assert.rejects(
      Promise.race([
        running,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("overflow left the ACP prompt pending")), 2_000);
        }),
      ]),
      /ACP client closed|ACP child exited/,
    );
    acp.close();
  });

  test("commits the response flush before a permission-first resume continues", async () => {
    let resolveHelp!: (prompt: ComputerHelpPrompt) => void;
    const help = nextPrompt<ComputerHelpPrompt>((resolve) => { resolveHelp = resolve; });
    let resolvePermission!: (prompt: PermissionPrompt) => void;
    const permission = nextPrompt<PermissionPrompt>((resolve) => { resolvePermission = resolve; });
    let committed = false;
    const acp = await initializedClient({
      onComputerHelp: resolveHelp,
      onPermission: (prompt) => {
        assert.equal(committed, true);
        resolvePermission(prompt);
      },
    });
    try {
      const running = acp.prompt("permission-first");
      const helpPrompt = await help;
      await acp.respondComputerHelp(helpPrompt.rpcId, "done", () => { committed = true; });
      const permissionPrompt = await permission;
      await acp.respondPermission(permissionPrompt.rpcId, "allow-once");
      assert.equal(await running, "permission:allow-once");
    } finally {
      acp.close();
    }
  });

  test("cancels one pending event on client cancellation and reports child exit without a late response", async () => {
    let resolveCancelledHelp!: (prompt: ComputerHelpPrompt) => void;
    const cancelledHelp = nextPrompt<ComputerHelpPrompt>((resolve) => { resolveCancelledHelp = resolve; });
    let cancellationCount = 0;
    const cancelled = await initializedClient({
      onComputerHelp: resolveCancelledHelp,
      onComputerHelpCancelled: () => { cancellationCount += 1; },
    });
    try {
      const running = cancelled.prompt("done");
      const prompt = await cancelledHelp;
      cancelled.cancel();
      await assert.rejects(running, /cancelled/);
      assert.equal(cancellationCount, 1);
      await assert.rejects(cancelled.respondComputerHelp(prompt.rpcId, "done"), /no longer active/);
    } finally {
      cancelled.close();
    }

    let resolveExitedHelp!: (prompt: ComputerHelpPrompt) => void;
    const exitedHelp = nextPrompt<ComputerHelpPrompt>((resolve) => { resolveExitedHelp = resolve; });
    let exitCount = 0;
    const exited = await initializedClient({
      onComputerHelp: resolveExitedHelp,
      onComputerHelpCancelled: () => { exitCount += 1; },
    });
    const running = exited.prompt("child-exit");
    const prompt = await exitedHelp;
    await assert.rejects(running, /ACP child exited/);
    assert.equal(exitCount, 1);
    await assert.rejects(exited.respondComputerHelp(prompt.rpcId, "skip"), /no longer active/);
    exited.close();
  });
});
