import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { afterEach, describe, test } from "node:test";
import {
  COMPUTER_HELP_COMPLETE_FIELD,
  COMPUTER_HELP_COMPLETE_VALUE,
  COMPUTER_HELP_IDENTITY_ENV,
  COMPUTER_HELP_META_KEY,
  COMPUTER_HELP_TOOL_NAME,
  computerHelpMcpServer,
} from "../src/computer-help.ts";

type RpcMessage = Record<string, unknown> & { id?: string | number };

const children = new Set<ChildProcessWithoutNullStreams>();
const generationDirectories = new Set<string>();

afterEach(async () => {
  for (const child of children) child.kill("SIGTERM");
  children.clear();
  await Promise.all([...generationDirectories].map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
  generationDirectories.clear();
});

function startServer(identity = "opaque-test-identity", cwd = process.cwd()) {
  const generationDirectory = mkdtempSync(join(tmpdir(), "openbot-computer-help-generation-"));
  const generationFile = join(generationDirectory, "generation");
  const generation = "prompt-generation";
  writeFileSync(generationFile, generation, { mode: 0o600 });
  generationDirectories.add(generationDirectory);
  const spec = computerHelpMcpServer(identity, generationFile);
  const child = spawn(spec.command, spec.args, {
    cwd,
    env: {
      ...process.env,
      ...Object.fromEntries(spec.env.map((entry) => [entry.name, entry.value])),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  const messages: RpcMessage[] = [];
  const waiters: Array<{
    predicate: (message: RpcMessage) => boolean;
    resolve: (message: RpcMessage) => void;
  }> = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as RpcMessage;
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      waiters.splice(waiterIndex, 1)[0]!.resolve(message);
      return;
    }
    messages.push(message);
  });
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const next = (predicate: (message: RpcMessage) => boolean): Promise<RpcMessage> => {
    const existingIndex = messages.findIndex(predicate);
    if (existingIndex >= 0) return Promise.resolve(messages.splice(existingIndex, 1)[0]!);
    return Promise.race([
      new Promise<RpcMessage>((resolve) => waiters.push({ predicate, resolve })),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for MCP message")), 2_000);
      }),
    ]);
  };
  return { child, identity, generation, generationFile, send, next, messages };
}

async function initialize(server: ReturnType<typeof startServer>): Promise<void> {
  server.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: { elicitation: {} },
      clientInfo: { name: "test", version: "1" },
    },
  });
  const initialized = await server.next((message) => message.id === 1);
  assert.equal((initialized.result as { protocolVersion?: string }).protocolVersion, "2025-06-18");
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
}

describe("first-party Computer-help MCP", () => {
  test("launches its advertised command from an unrelated cwd without PATH or repository lookup", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "openbot-computer-help-cwd-"));
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const server = startServer("cwd-independent-identity", cwd);
      await initialize(server);
      server.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const listed = await server.next((message) => message.id === 2);
      assert.equal((listed.result as { tools: unknown[] }).tools.length, 1);
    } finally {
      process.env.PATH = originalPath;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("publishes one deliberately narrow tool and a non-empty restricted form", async () => {
    const server = startServer();
    await initialize(server);
    server.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = await server.next((message) => message.id === 2);
    const tools = (listed.result as { tools: Array<Record<string, unknown>> }).tools;
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, COMPUTER_HELP_TOOL_NAME);
    assert.match(String(tools[0]?.description), /current OpenBot Screen/i);
    assert.match(String(tools[0]?.description), /never use for Harness CLI login/i);
    assert.match(String(tools[0]?.description), /Codex CLI login/i);
    assert.match(String(tools[0]?.description), /never ask for .*secret.*Chat/i);

    server.send({
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: { name: COMPUTER_HELP_TOOL_NAME, arguments: { blocker: "captcha" } },
    });
    const elicitation = await server.next((message) => message.method === "elicitation/create");
    const params = elicitation.params as Record<string, unknown>;
    const schema = params.requestedSchema as {
      properties: Record<string, { type?: string; enum?: string[] }>;
      required?: string[];
    };
    assert.equal(params.mode, "form");
    assert.match(String(params.message), /visual check/i);
    assert.deepEqual(schema.properties[COMPUTER_HELP_COMPLETE_FIELD]?.enum, [COMPUTER_HELP_COMPLETE_VALUE]);
    assert.deepEqual(schema.required, [COMPUTER_HELP_COMPLETE_FIELD]);
    assert.equal((params.requestedSchema as { additionalProperties?: boolean }).additionalProperties, false);
    assert.deepEqual((params._meta as Record<string, unknown>)[COMPUTER_HELP_META_KEY], {
      kind: "computer-help",
      version: 1,
      identity: server.identity,
      generation: server.generation,
    });
  });

  test("Done accepts the exact completion value and Skip declines without claiming completion", async () => {
    const done = startServer("done-identity");
    await initialize(done);
    done.send({
      jsonrpc: "2.0",
      id: "done-call",
      method: "tools/call",
      params: { name: COMPUTER_HELP_TOOL_NAME, arguments: { blocker: "two-factor" } },
    });
    const doneRequest = await done.next((message) => message.method === "elicitation/create");
    done.send({
      jsonrpc: "2.0",
      id: doneRequest.id,
      result: {
        action: "accept",
        content: { [COMPUTER_HELP_COMPLETE_FIELD]: COMPUTER_HELP_COMPLETE_VALUE },
      },
    });
    const doneResult = await done.next((message) => message.id === "done-call");
    assert.equal(doneResult.error, undefined);
    assert.match(JSON.stringify(doneResult.result), /continue the task/i);

    const skipped = startServer("skip-identity");
    await initialize(skipped);
    skipped.send({
      jsonrpc: "2.0",
      id: "skip-call",
      method: "tools/call",
      params: { name: COMPUTER_HELP_TOOL_NAME, arguments: { blocker: "payment" } },
    });
    const skipRequest = await skipped.next((message) => message.method === "elicitation/create");
    skipped.send({ jsonrpc: "2.0", id: skipRequest.id, result: { action: "decline" } });
    const skipResult = await skipped.next((message) => message.id === "skip-call");
    assert.equal(skipResult.error, undefined);
    assert.match(JSON.stringify(skipResult.result), /skipped/i);
    assert.doesNotMatch(JSON.stringify(skipResult.result), /completed|finished successfully/i);

    const cancelled = startServer("cancelled-identity");
    await initialize(cancelled);
    cancelled.send({
      jsonrpc: "2.0",
      id: "cancelled-call",
      method: "tools/call",
      params: { name: COMPUTER_HELP_TOOL_NAME, arguments: { blocker: "other" } },
    });
    const cancelledRequest = await cancelled.next((message) => message.method === "elicitation/create");
    cancelled.send({ jsonrpc: "2.0", id: cancelledRequest.id, result: { action: "cancel" } });
    const cancelledResult = await cancelled.next((message) => message.id === "cancelled-call");
    assert.match(JSON.stringify(cancelledResult.result), /cancelled before a response/i);
    assert.doesNotMatch(JSON.stringify(cancelledResult.result), /person skipped|was completed/i);
  });

  test("fails malformed calls closed and emits one terminal response across duplicates, cancellation, and late replies", async () => {
    const server = startServer();
    await initialize(server);
    server.send({
      jsonrpc: "2.0",
      id: "malformed",
      method: "tools/call",
      params: { name: COMPUTER_HELP_TOOL_NAME, arguments: { blocker: "password-from-chat" } },
    });
    const malformed = await server.next((message) => message.id === "malformed");
    assert.ok(malformed.error);
    assert.equal(server.messages.some((message) => message.method === "elicitation/create"), false);

    const call = {
      jsonrpc: "2.0",
      id: "duplicate",
      method: "tools/call",
      params: { name: COMPUTER_HELP_TOOL_NAME, arguments: { blocker: "other" } },
    };
    server.send(call);
    server.send(call);
    const elicitation = await server.next((message) => message.method === "elicitation/create");
    server.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "duplicate", reason: "turn cancelled" },
    });
    const forwardedCancel = await server.next((message) => (
      message.method === "notifications/cancelled"
      && (message.params as { requestId?: unknown }).requestId === elicitation.id
    ));
    assert.equal((forwardedCancel.params as { reason?: string }).reason, "request cancelled");
    const terminal = await server.next((message) => message.id === "duplicate");
    assert.equal((terminal.error as { code?: number }).code, -32800);

    server.send({
      jsonrpc: "2.0",
      id: elicitation.id,
      result: {
        action: "accept",
        content: { [COMPUTER_HELP_COMPLETE_FIELD]: COMPUTER_HELP_COMPLETE_VALUE },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(server.messages.filter((message) => message.id === "duplicate").length, 0);

    server.send(call);
    const reused = await server.next((message) => message.method === "elicitation/create");
    server.send({ jsonrpc: "2.0", id: reused.id, result: { action: "decline" } });
    const reusedTerminal = await server.next((message) => message.id === "duplicate");
    assert.match(JSON.stringify(reusedTerminal.result), /skipped/i);
  });
});
