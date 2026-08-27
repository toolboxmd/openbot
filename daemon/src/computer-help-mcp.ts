import fs from "node:fs";
import readline from "node:readline";
import {
  COMPUTER_HELP_COMPLETE_FIELD,
  COMPUTER_HELP_COMPLETE_VALUE,
  COMPUTER_HELP_COMPLETION_SCHEMA,
  COMPUTER_HELP_GENERATION_FILE_ENV,
  COMPUTER_HELP_IDENTITY_ENV,
  COMPUTER_HELP_META_KEY,
  COMPUTER_HELP_TOOL_DESCRIPTION,
  COMPUTER_HELP_TOOL_NAME,
  computerHelpInstruction,
} from "./computer-help.ts";

type RpcId = string | number;
type RpcMessage = Record<string, unknown> & { id?: RpcId };

type PendingCall = {
  callId: RpcId;
  elicitationId: RpcId;
};

const identity = process.env[COMPUTER_HELP_IDENTITY_ENV] ?? "";
const generationFile = process.env[COMPUTER_HELP_GENERATION_FILE_ENV] ?? "";
if (!identity || !generationFile) process.exit(2);

const input = readline.createInterface({ input: process.stdin });
const pendingByElicitation = new Map<RpcId, PendingCall>();
const pendingByCall = new Map<RpcId, PendingCall>();
let nextElicitationId = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id: RpcId, value: unknown): void {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id: RpcId, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function finish(call: PendingCall, value: unknown): void {
  if (!pendingByCall.has(call.callId)) return;
  pendingByCall.delete(call.callId);
  pendingByElicitation.delete(call.elicitationId);
  result(call.callId, value);
}

function fail(call: PendingCall, message: string): void {
  if (!pendingByCall.has(call.callId)) return;
  pendingByCall.delete(call.callId);
  pendingByElicitation.delete(call.elicitationId);
  error(call.callId, -32603, message);
}

function toolResult(text: string): { content: Array<{ type: "text"; text: string }>; isError: false } {
  return { content: [{ type: "text", text }], isError: false };
}

function handleToolCall(id: RpcId, params: unknown): void {
  if (pendingByCall.has(id)) return;
  if (!isRecord(params) || params.name !== COMPUTER_HELP_TOOL_NAME || !isRecord(params.arguments)) {
    error(id, -32602, "Invalid Computer-help tool request");
    return;
  }
  const instruction = computerHelpInstruction(params.arguments.blocker);
  if (!instruction || Object.keys(params.arguments).some((key) => key !== "blocker")) {
    error(id, -32602, "Choose a supported visual blocker");
    return;
  }
  if (pendingByCall.size > 0) {
    error(id, -32600, "A Computer-help request is already pending");
    return;
  }
  let generation: string;
  try {
    generation = fs.readFileSync(generationFile, "utf8").trim();
  } catch {
    error(id, -32603, "Computer-help prompt identity is unavailable");
    return;
  }
  if (!generation) {
    error(id, -32603, "Computer-help prompt identity is unavailable");
    return;
  }
  const elicitationId = `openbot-computer-help-${nextElicitationId++}`;
  const call = { callId: id, elicitationId };
  pendingByCall.set(id, call);
  pendingByElicitation.set(elicitationId, call);
  send({
    jsonrpc: "2.0",
    id: elicitationId,
    method: "elicitation/create",
    params: {
      mode: "form",
      message: instruction,
      requestedSchema: COMPUTER_HELP_COMPLETION_SCHEMA,
      _meta: {
        [COMPUTER_HELP_META_KEY]: {
          kind: "computer-help",
          version: 1,
          identity,
          generation,
        },
      },
    },
  });
}

function handleElicitationResponse(message: RpcMessage): void {
  if (message.id === undefined) return;
  const call = pendingByElicitation.get(message.id);
  if (!call) return;
  if (message.error !== undefined || !isRecord(message.result)) {
    fail(call, "Computer-help request was not completed");
    return;
  }
  const action = message.result.action;
  if (action === "accept") {
    const content = message.result.content;
    if (
      !isRecord(content)
      || content[COMPUTER_HELP_COMPLETE_FIELD] !== COMPUTER_HELP_COMPLETE_VALUE
      || Object.keys(content).some((key) => key !== COMPUTER_HELP_COMPLETE_FIELD)
    ) {
      fail(call, "Computer-help completion was not confirmed");
      return;
    }
    finish(call, toolResult("The visual blocker was completed on the current Screen. Continue the task."));
    return;
  }
  if (action === "decline") {
    finish(call, toolResult("The person skipped this visual blocker. Choose a safe alternative or explain what remains."));
    return;
  }
  if (action === "cancel") {
    finish(call, toolResult("Computer help was cancelled before a response. Treat the visual step as unresolved."));
    return;
  }
  fail(call, "Computer-help request returned an unsupported response");
}

function handleCancellation(params: unknown): void {
  if (!isRecord(params)) return;
  const requestId = params.requestId;
  if (typeof requestId !== "string" && typeof requestId !== "number") return;
  const call = pendingByCall.get(requestId);
  if (!call) return;
  pendingByCall.delete(call.callId);
  pendingByElicitation.delete(call.elicitationId);
  send({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: call.elicitationId, reason: "request cancelled" },
  });
  error(call.callId, -32800, "Request cancelled");
}

function handleRequest(message: RpcMessage): void {
  const id = message.id;
  if (message.method === "notifications/initialized") return;
  if (message.method === "notifications/cancelled") {
    handleCancellation(message.params);
    return;
  }
  if (message.method === undefined) {
    handleElicitationResponse(message);
    return;
  }
  if (id === undefined) return;
  if (message.method === "initialize") {
    const params = isRecord(message.params) ? message.params : {};
    result(id, {
      protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "OpenBot Computer help", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "ping") {
    result(id, {});
    return;
  }
  if (message.method === "tools/list") {
    result(id, {
      tools: [{
        name: COMPUTER_HELP_TOOL_NAME,
        title: "Ask for help on this Computer",
        description: COMPUTER_HELP_TOOL_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            blocker: {
              type: "string",
              title: "Visual blocker",
              enum: ["site-password", "two-factor", "captcha", "payment", "other"],
            },
          },
          required: ["blocker"],
          additionalProperties: false,
        },
      }],
    });
    return;
  }
  if (message.method === "tools/call") {
    handleToolCall(id, message.params);
    return;
  }
  error(id, -32601, "Method not found");
}

input.on("line", (line) => {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(message)) return;
  handleRequest(message);
});
