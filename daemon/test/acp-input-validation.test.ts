import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AcpClient } from "../src/acp.ts";

const NULL_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
input.once("line", () => process.stdout.write("null\n"));
`;

const MALFORMED_JSON_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
input.once("line", () => process.stdout.write('{"jsonrpc":\n'));
`;

const OVERSIZED_LINE_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
input.once("line", () => process.stdout.write("x".repeat(1024 * 1024 + 1)));
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

const RAW_LINE_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
input.once("line", () => process.stdout.write(process.argv[1] + "\n"));
`;

const PROMPT_LINE_ACP = String.raw`
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "role-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    process.stdout.write(process.argv[1] + "\n");
  }
});
`;

const FORWARD_COMPAT_ACP = String.raw`
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "future-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    send({ jsonrpc: "2.0", method: "future/progress", params: { value: 1 } });
    send({ jsonrpc: "2.0", method: "future/array_progress", params: [1] });
    send({ jsonrpc: "2.0", id: 900, method: "future/request", params: [2] });
    return;
  }
  if (message.id === 900 && message.error?.code === -32601) {
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  }
});
`;

const BATCHED_INITIALIZE_FAILURE_ACP = String.raw`
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).once("line", (line) => {
  const message = JSON.parse(line);
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } })
      + "\nnull\n"
  );
});
`;

const BATCHED_PROMPT_FAILURE_ACP = String.raw`
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "batched-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
        + "\nnull\n"
    );
  }
});
`;

const DUPLICATE_INITIALIZE_RESPONSE_ACP = String.raw`
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).once("line", (line) => {
  const message = JSON.parse(line);
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } })
      + "\n"
      + JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32_001, message: "PRIVATE-DUPLICATE-INITIALIZE" }
      })
      + "\n"
  );
});
`;

const DELAYED_DUPLICATE_INITIALIZE_RESPONSE_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
let answered = false;
input.on("line", (line) => {
  if (answered) return;
  answered = true;
  const message = JSON.parse(line);
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } }) + "\n"
  );
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32_001, message: "PRIVATE-DELAYED-DUPLICATE" }
    }) + "\n");
  }, 20);
});
`;

const DUPLICATE_PROMPT_RESPONSE_ACP = String.raw`
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "duplicate-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32_001, message: "PRIVATE-DUPLICATE-PROMPT" }
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

const INVALID_PROMPT_RESULT_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const promptResult = JSON.parse(process.argv[1]);
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "invalid-result-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: message.id, result: promptResult });
  }
});
process.stderr.write("ready\n");
`;

const WRONG_SESSION_HANDLED_METHOD_ACP = String.raw`
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "expected-session" } });
    return;
  }
  if (message.method !== "session/prompt") return;
  if (mode === "update") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "wrong-session",
        update: {
          sessionUpdate: "agent_message",
          content: { type: "text", text: "WRONG-SESSION-TEXT" }
        }
      }
    });
  } else {
    send({
      jsonrpc: "2.0",
      id: 700,
      method: "session/request_permission",
      params: {
        sessionId: "wrong-session",
        title: "WRONG-SESSION-PERMISSION",
        options: []
      }
    });
  }
  send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
});
`;

const POST_TERMINAL_HANDLED_METHOD_ACP = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const mode = process.argv[1];
let identity = null;
let generationFile = null;
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    const server = message.params.mcpServers.find((candidate) => candidate.name === "openbot-computer-help");
    identity = server.env.find((entry) => entry.name === "OPENBOT_COMPUTER_HELP_IDENTITY").value;
    generationFile = server.env.find((entry) => entry.name === "OPENBOT_COMPUTER_HELP_GENERATION_FILE").value;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "post-terminal-session" } });
    return;
  }
  if (message.method !== "session/prompt") return;
  send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  setTimeout(() => {
    if (mode === "update") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "post-terminal-session",
          update: {
            sessionUpdate: "agent_message",
            content: { type: "text", text: "LATE" }
          }
        }
      });
      return;
    }
    if (mode === "permission") {
      send({
        jsonrpc: "2.0",
        id: 710,
        method: "session/request_permission",
        params: {
          sessionId: "post-terminal-session",
          title: "LATE PERMISSION",
          options: []
        }
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: 711,
      method: "elicitation/create",
      params: {
        sessionId: "post-terminal-session",
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
  }, 20);
});
`;

const PRE_TERMINAL_BATCHED_UPDATE_ACP = String.raw`
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "batched-update-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "batched-update-session",
          update: {
            sessionUpdate: "agent_message",
            content: { type: "text", text: "BEFORE" }
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

const ACTIVE_SERVER_REQUEST_ID_ACP = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const mode = process.argv[1];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const sendBatch = (messages) => process.stdout.write(
  messages.map((message) => JSON.stringify(message)).join("\n") + "\n"
);
let identity = null;
let generationFile = null;
let promptId = null;
const permission = (id = 700) => ({
  jsonrpc: "2.0",
  id,
  method: "session/request_permission",
  params: {
    sessionId: "request-id-session",
    title: "Approve the active request",
    options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }]
  }
});
const elicitation = (
  id = 700,
  message = "Complete the visual step on this Computer, then choose I'm done."
) => ({
  jsonrpc: "2.0",
  id,
  method: "elicitation/create",
  params: {
    sessionId: "request-id-session",
    mode: "form",
    message,
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
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    const server = message.params.mcpServers.find((candidate) => candidate.name === "openbot-computer-help");
    identity = server.env.find((entry) => entry.name === "OPENBOT_COMPUTER_HELP_IDENTITY").value;
    generationFile = server.env.find((entry) => entry.name === "OPENBOT_COMPUTER_HELP_GENERATION_FILE").value;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "request-id-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    if (mode === "duplicate-permission") {
      sendBatch([permission(), permission()]);
      return;
    }
    if (mode === "duplicate-elicitation") {
      sendBatch([elicitation(), elicitation()]);
      return;
    }
    if (mode === "changed-duplicate-elicitation") {
      sendBatch([elicitation(), elicitation(700, "Changed active request payload")]);
      return;
    }
    if (mode === "permission-then-elicitation") {
      sendBatch([permission(), elicitation()]);
      return;
    }
    if (mode === "elicitation-then-permission") {
      sendBatch([elicitation(), permission()]);
      return;
    }
    if (mode === "permission-then-terminal") {
      sendBatch([
        permission(),
        { jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } }
      ]);
      return;
    }
    if (mode === "permission-reuse") send(permission());
    return;
  }
  if (
    (mode === "permission-reuse" || mode === "duplicate-elicitation")
    && message.id === 700
    && message.result
  ) {
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  }
});
`;

const SESSION_ATTACHMENT_UPDATE_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const mode = process.argv[1];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const sendBatch = (messages) => process.stdout.write(
  messages.map((message) => JSON.stringify(message)).join("\n") + "\n"
);
const update = (sessionId, sessionUpdate, extra = {}) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId, update: { sessionUpdate, ...extra } }
});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    const response = { jsonrpc: "2.0", id: message.id, result: { sessionId: "new-session" } };
    const sessionId = mode === "new-wrong-session" ? "wrong-session" : "new-session";
    sendBatch([response, update(sessionId, "current_mode_update", { currentModeId: "default" })]);
    return;
  }
  if (message.method === "session/load") {
    const response = { jsonrpc: "2.0", id: message.id, result: {} };
    const sessionId = mode === "load-wrong-session" ? "wrong-session" : message.params.sessionId;
    const replay = update(sessionId, "agent_message", {
      content: { type: "text", text: "REPLAY-MUST-NOT-APPEND" }
    });
    if (mode === "load-response-update-malformed") {
      process.stdout.write(
        JSON.stringify(response) + "\n" + JSON.stringify(replay) + "\nnull\n"
      );
      return;
    }
    sendBatch(mode === "load-update-before-response" ? [replay, response] : [response, replay]);
    return;
  }
  if (message.method === "session/resume") {
    const response = { jsonrpc: "2.0", id: message.id, result: {} };
    const sessionId = mode === "resume-wrong-session" ? "wrong-session" : message.params.sessionId;
    sendBatch([response, update(sessionId, "available_commands_update", { availableCommands: [] })]);
  }
});
`;

const DEEPLY_NESTED_UPDATE_ACP = String.raw`
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "nested-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    const nested = '{"content":'.repeat(20_000)
      + '{"text":"PRIVATE-DEEP-CONTENT"}'
      + '}'.repeat(20_000);
    process.stdout.write(
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":'
        + '{"sessionUpdate":"agent_message","content":' + nested + '}}}\n'
    );
  }
});
`;

const NESTED_CONTENT_ACP = String.raw`
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "nested-normal-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "nested-normal-session",
        update: {
          sessionUpdate: "agent_message",
          content: ["one ", { content: [{ text: "two " }, { content: "three" }] }]
        }
      }
    });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`;

const ACTIVE_STATE_THEN_NULL_ACP = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let identity = null;
let generationFile = null;
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    const server = message.params.mcpServers.find((candidate) => candidate.name === "openbot-computer-help");
    identity = server.env.find((entry) => entry.name === "OPENBOT_COMPUTER_HELP_IDENTITY").value;
    generationFile = server.env.find((entry) => entry.name === "OPENBOT_COMPUTER_HELP_GENERATION_FILE").value;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "active-state-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      id: 700,
      method: "session/request_permission",
      params: {
        sessionId: "active-state-session",
        title: "Pending permission",
        options: []
      }
    });
    send({
      jsonrpc: "2.0",
      id: 701,
      method: "elicitation/create",
      params: {
        sessionId: "active-state-session",
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
    process.stdout.write("null\n");
  }
});
`;

function client(source: string): AcpClient {
  return new AcpClient({
    command: process.execPath,
    args: ["-e", source],
    env: { ...process.env },
  }, process.cwd());
}

function rawLineClient(line: string): AcpClient {
  return new AcpClient({
    command: process.execPath,
    args: ["-e", RAW_LINE_ACP, line],
    env: { ...process.env },
  }, process.cwd());
}

function promptLineClient(line: string): AcpClient {
  return new AcpClient({
    command: process.execPath,
    args: ["-e", PROMPT_LINE_ACP, line],
    env: { ...process.env },
  }, process.cwd());
}

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

describe("AcpClient input validation", () => {
  test("fails JSON null without crashing and permits a fresh client retry", async () => {
    const broken = client(NULL_ACP);
    try {
      await assert.rejects(
        within(broken.initialize()),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport protocol error");
          return true;
        },
      );
    } finally {
      broken.close();
    }

    const fresh = client(HEALTHY_ACP);
    try {
      assert.deepEqual(await within(fresh.initialize()), { authMethods: [] });
      assert.equal(await within(fresh.newSession(process.cwd())), "fresh-session");
      assert.equal(await within(fresh.prompt("retry")), "");
    } finally {
      fresh.close();
    }
  });

  test("fails malformed JSON instead of stranding initialize", async () => {
    const broken = client(MALFORMED_JSON_ACP);
    try {
      await assert.rejects(
        within(broken.initialize()),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport protocol error");
          return true;
        },
      );
    } finally {
      broken.close();
    }
  });

  test("rejects a response with the wrong JSON-RPC version", async () => {
    const broken = rawLineClient(JSON.stringify({
      jsonrpc: "1.0",
      id: 1,
      result: { authMethods: [] },
    }));
    try {
      await assert.rejects(
        within(broken.initialize()),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport protocol error");
          return true;
        },
      );
    } finally {
      broken.close();
    }
  });

  test("rejects an invalid response envelope without exposing its payload", async () => {
    const broken = rawLineClient(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { authMethods: [] },
      error: { code: -32_000, message: "PRIVATE-RAW-ACP-PAYLOAD" },
    }));
    try {
      await assert.rejects(
        within(broken.initialize()),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport protocol error");
          assert.doesNotMatch(String(error), /PRIVATE-RAW-ACP-PAYLOAD/);
          return true;
        },
      );
    } finally {
      broken.close();
    }
  });

  test("bounds an unterminated ACP input line", async () => {
    const broken = client(OVERSIZED_LINE_ACP);
    try {
      await assert.rejects(
        within(broken.initialize()),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport protocol error");
          return true;
        },
      );
    } finally {
      broken.close();
    }
  });

  test("rejects primitives, arrays, and invalid JSON-RPC ids and envelopes", async (t) => {
    const cases = [
      ["boolean", "true"],
      ["number", "42"],
      ["string", JSON.stringify("not an envelope")],
      ["array", "[]"],
      ["null response id", JSON.stringify({ jsonrpc: "2.0", id: null, result: {} })],
      ["fractional response id", JSON.stringify({ jsonrpc: "2.0", id: 1.5, result: {} })],
      ["object request id", JSON.stringify({
        jsonrpc: "2.0",
        id: {},
        method: "session/request_permission",
        params: {},
      })],
      ["response without result or error", JSON.stringify({ jsonrpc: "2.0", id: 1 })],
      ["request containing a result", JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "unexpected",
        result: null,
      })],
    ] as const;
    for (const [name, line] of cases) {
      await t.test(name, async () => {
        const broken = rawLineClient(line);
        try {
          await assert.rejects(within(broken.initialize()), /ACP transport protocol error/);
        } finally {
          broken.close();
        }
      });
    }
  });

  test("fails malformed roles for handled ACP methods instead of stranding a flushed Turn", async (t) => {
    const cases = [
      ["permission notification", {
        jsonrpc: "2.0",
        method: "session/request_permission",
        params: { title: "Approval", options: [] },
      }],
      ["elicitation notification", {
        jsonrpc: "2.0",
        method: "elicitation/create",
        params: { mode: "form" },
      }],
      ["session update request", {
        jsonrpc: "2.0",
        id: 700,
        method: "session/update",
        params: { update: { sessionUpdate: "state_update", state: "idle" } },
      }],
      ["session update without params", {
        jsonrpc: "2.0",
        method: "session/update",
      }],
      ["session update with array params", {
        jsonrpc: "2.0",
        method: "session/update",
        params: [],
      }],
      ["permission with array params", {
        jsonrpc: "2.0",
        id: 701,
        method: "session/request_permission",
        params: [],
      }],
      ["permission without session id", {
        jsonrpc: "2.0",
        id: 702,
        method: "session/request_permission",
        params: { title: "Approval", options: [] },
      }],
      ["elicitation with array params", {
        jsonrpc: "2.0",
        id: 703,
        method: "elicitation/create",
        params: [],
      }],
      ["session update without session id", {
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "state_update", state: "idle" } },
      }],
      ["session update without update", {
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "role-session" },
      }],
      ["session update with null update", {
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "role-session", update: null },
      }],
      ["session update with array update", {
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "role-session", update: [] },
      }],
    ] as const;
    for (const [name, message] of cases) {
      await t.test(name, async () => {
        const acp = promptLineClient(JSON.stringify(message));
        try {
          await within(acp.initialize());
          await within(acp.newSession(process.cwd()));
          await assert.rejects(
            within(acp.prompt("PRIVATE-PROMPT-TEXT"), 300),
            (error: unknown) => {
              assert.equal((error as Error).message, "ACP transport protocol error");
              assert.doesNotMatch(String(error), /PRIVATE-PROMPT-TEXT|Approval/);
              return true;
            },
          );
        } finally {
          acp.close();
        }
      });
    }
  });

  test("rejects wrong-session handled traffic before it reaches Turn handlers", async (t) => {
    await t.test("assistant update", async () => {
      const acp = new AcpClient({
        command: process.execPath,
        args: ["-e", WRONG_SESSION_HANDLED_METHOD_ACP, "update"],
        env: { ...process.env },
      }, process.cwd());
      const assistantText: string[] = [];
      try {
        await within(acp.initialize());
        await within(acp.newSession(process.cwd()));
        await assert.rejects(
          within(acp.prompt("reject cross-session text", {
            onAssistant(text) {
              assistantText.push(text);
            },
          })),
          (error: unknown) => {
            assert.equal((error as Error).message, "ACP transport protocol error");
            assert.doesNotMatch(String(error), /WRONG-SESSION-TEXT/);
            return true;
          },
        );
        assert.deepEqual(assistantText, []);
      } finally {
        acp.close();
      }
    });

    await t.test("permission request", async () => {
      const acp = new AcpClient({
        command: process.execPath,
        args: ["-e", WRONG_SESSION_HANDLED_METHOD_ACP, "permission"],
        env: { ...process.env },
      }, process.cwd());
      let permissions = 0;
      try {
        await within(acp.initialize());
        await within(acp.newSession(process.cwd()));
        await assert.rejects(
          within(acp.prompt("reject cross-session permission", {
            onPermission() {
              permissions += 1;
            },
          })),
          (error: unknown) => {
            assert.equal((error as Error).message, "ACP transport protocol error");
            assert.doesNotMatch(String(error), /WRONG-SESSION-PERMISSION/);
            return true;
          },
        );
        assert.equal(permissions, 0);
      } finally {
        acp.close();
      }
    });
  });

  test("owns duplicate and cross-kind active server request ids exactly once", async (t) => {
    const cases = [
      ["duplicate permission", "duplicate-permission", 1, 0],
      ["changed duplicate elicitation", "changed-duplicate-elicitation", 0, 1],
      ["permission then elicitation", "permission-then-elicitation", 1, 0],
      ["elicitation then permission", "elicitation-then-permission", 0, 1],
    ] as const;
    for (const [name, mode, expectedPermissions, expectedElicitations] of cases) {
      await t.test(name, async () => {
        let permissions = 0;
        let elicitations = 0;
        const acp = new AcpClient({
          command: process.execPath,
          args: ["-e", ACTIVE_SERVER_REQUEST_ID_ACP, mode],
          env: { ...process.env },
        }, process.cwd());
        try {
          await within(acp.initialize());
          await within(acp.newSession(process.cwd()));
          await assert.rejects(
            within(acp.prompt("reject duplicate request identity", {
              onPermission() {
                permissions += 1;
              },
              onComputerHelp() {
                elicitations += 1;
              },
            }), 500),
            (error: unknown) => {
              assert.equal((error as Error).message, "ACP transport protocol error");
              return true;
            },
          );
          assert.equal(permissions, expectedPermissions);
          assert.equal(elicitations, expectedElicitations);
        } finally {
          acp.close();
        }
      });
    }
  });

  test("suppresses one equivalent active Computer-help request without retiring it", async () => {
    let elicitations = 0;
    let resolveHelp!: (rpcId: string | number) => void;
    const help = within(new Promise<string | number>((resolve) => { resolveHelp = resolve; }));
    const acp = new AcpClient({
      command: process.execPath,
      args: ["-e", ACTIVE_SERVER_REQUEST_ID_ACP, "duplicate-elicitation"],
      env: { ...process.env },
    }, process.cwd(), {
      onComputerHelp(prompt) {
        elicitations += 1;
        resolveHelp(prompt.rpcId);
      },
    });
    try {
      await within(acp.initialize());
      await within(acp.newSession(process.cwd()));
      const running = acp.prompt("suppress exact duplicate");
      const rpcId = await help;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(elicitations, 1);
      await acp.respondComputerHelp(rpcId, "done");
      assert.equal(await within(running), "");
    } finally {
      acp.close();
    }
  });

  test("releases a server request id only after its permission response is flushed", async () => {
    const waiters: Array<(rpcId: string | number) => void> = [];
    const queued: Array<string | number> = [];
    const nextPermission = () => {
      const rpcId = queued.shift();
      return rpcId === undefined
        ? within(new Promise<string | number>((resolve) => { waiters.push(resolve); }))
        : Promise.resolve(rpcId);
    };
    const acp = new AcpClient({
      command: process.execPath,
      args: ["-e", ACTIVE_SERVER_REQUEST_ID_ACP, "permission-reuse"],
      env: { ...process.env },
    }, process.cwd(), {
      onPermission(prompt) {
        const waiter = waiters.shift();
        if (waiter) waiter(prompt.rpcId);
        else queued.push(prompt.rpcId);
      },
    });
    try {
      await within(acp.initialize());
      await within(acp.newSession(process.cwd()));

      const firstEvent = nextPermission();
      const firstTurn = acp.prompt("first permission");
      const firstId = await firstEvent;
      await acp.respondPermission(firstId, "allow-once");
      assert.equal(await within(firstTurn), "");

      const secondEvent = nextPermission();
      const secondTurn = acp.prompt("reuse permission id");
      const secondId = await secondEvent;
      assert.equal(secondId, firstId);
      await acp.respondPermission(secondId, "allow-once");
      assert.equal(await within(secondTurn), "");
    } finally {
      acp.close();
    }
  });

  test("fails a prompt terminal response while its permission request is unresolved", async () => {
    let permissionId: string | number | undefined;
    const acp = new AcpClient({
      command: process.execPath,
      args: ["-e", ACTIVE_SERVER_REQUEST_ID_ACP, "permission-then-terminal"],
      env: { ...process.env },
    }, process.cwd());
    try {
      await within(acp.initialize());
      await within(acp.newSession(process.cwd()));
      await assert.rejects(
        within(acp.prompt("terminal must not outrun permission", {
          onPermission(prompt) {
            permissionId = prompt.rpcId;
          },
        })),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport protocol error");
          return true;
        },
      );
      assert.equal(permissionId, 700);
      await assert.rejects(
        acp.respondPermission(permissionId, "allow-once"),
        /Permission request is no longer active/,
      );
    } finally {
      acp.close();
    }
  });

  test("accepts attachment lifecycle ordering while discarding session/load replay", async (t) => {
    const cases = [
      ["new response then lifecycle update", "new-response-then-update", "new", "new-session"],
      ["load replay before response", "load-update-before-response", "load", "saved-session"],
      ["load response then replay", "load-response-then-update", "load", "saved-session"],
      ["resume response then lifecycle update", "resume-response-then-update", "resume", "saved-session"],
    ] as const;
    for (const [name, mode, operation, expectedSession] of cases) {
      await t.test(name, async () => {
        const assistantText: string[] = [];
        const acp = new AcpClient({
          command: process.execPath,
          args: ["-e", SESSION_ATTACHMENT_UPDATE_ACP, mode],
          env: { ...process.env },
        }, process.cwd(), {
          onAssistant(text) {
            assistantText.push(text);
          },
        });
        try {
          await within(acp.initialize());
          const sessionId = operation === "new"
            ? await within(acp.newSession(process.cwd()))
            : operation === "load"
              ? await within(acp.loadSession("saved-session"))
              : await within(acp.resumeSession("saved-session"));
          assert.equal(sessionId, expectedSession);
          assert.deepEqual(assistantText, []);
        } finally {
          acp.close();
        }
      });
    }
  });

  test("rejects wrong-session updates during each attachment lifecycle", async (t) => {
    const cases = [
      ["new", "new-wrong-session"],
      ["load", "load-wrong-session"],
      ["resume", "resume-wrong-session"],
    ] as const;
    for (const [operation, mode] of cases) {
      await t.test(operation, async () => {
        const acp = new AcpClient({
          command: process.execPath,
          args: ["-e", SESSION_ATTACHMENT_UPDATE_ACP, mode],
          env: { ...process.env },
        }, process.cwd());
        try {
          await within(acp.initialize());
          const attaching = operation === "new"
            ? acp.newSession(process.cwd())
            : operation === "load"
              ? acp.loadSession("saved-session")
              : acp.resumeSession("saved-session");
          await assert.rejects(within(attaching), /ACP transport protocol error/);
        } finally {
          acp.close();
        }
      });
    }
  });

  test("lets a malformed line later in an attachment batch defeat apparent success", async () => {
    const assistantText: string[] = [];
    const acp = new AcpClient({
      command: process.execPath,
      args: ["-e", SESSION_ATTACHMENT_UPDATE_ACP, "load-response-update-malformed"],
      env: { ...process.env },
    }, process.cwd(), {
      onAssistant(text) {
        assistantText.push(text);
      },
    });
    try {
      await within(acp.initialize());
      await assert.rejects(
        within(acp.loadSession("saved-session")),
        /ACP transport protocol error/,
      );
      assert.deepEqual(assistantText, []);
    } finally {
      acp.close();
    }
  });

  test("rejects handled traffic after the prompt terminal response", async (t) => {
    const cases = ["update", "permission", "elicitation"] as const;
    for (const mode of cases) {
      await t.test(mode, async () => {
        const assistantText: string[] = [];
        let permissions = 0;
        let elicitations = 0;
        const acp = new AcpClient({
          command: process.execPath,
          args: ["-e", POST_TERMINAL_HANDLED_METHOD_ACP, mode],
          env: { ...process.env },
        }, process.cwd(), {
          onAssistant(text) {
            assistantText.push(text);
          },
          onPermission() {
            permissions += 1;
          },
          onComputerHelp() {
            elicitations += 1;
          },
        });
        try {
          await within(acp.initialize());
          await within(acp.newSession(process.cwd()));
          assert.equal(await within(acp.prompt("finish before late traffic")), "");
          await new Promise((resolve) => setTimeout(resolve, 50));
          assert.deepEqual(assistantText, []);
          assert.equal(permissions, 0);
          assert.equal(elicitations, 0);
          await assert.rejects(
            within(acp.initialize(), 100),
            (error: unknown) => {
              assert.equal((error as Error).message, "ACP transport protocol error");
              assert.doesNotMatch(String(error), /LATE/);
              return true;
            },
          );
        } finally {
          acp.close();
        }
      });
    }
  });

  test("keeps an update before the terminal response in the same child write", async () => {
    const assistantText: string[] = [];
    const acp = new AcpClient({
      command: process.execPath,
      args: ["-e", PRE_TERMINAL_BATCHED_UPDATE_ACP],
      env: { ...process.env },
    }, process.cwd(), {
      onAssistant(text) {
        assistantText.push(text);
      },
    });
    try {
      await within(acp.initialize());
      await within(acp.newSession(process.cwd()));
      assert.equal(await within(acp.prompt("preserve earlier update")), "BEFORE");
      assert.deepEqual(assistantText, ["BEFORE"]);
    } finally {
      acp.close();
    }
  });

  test("keeps unknown valid notifications and requests forward-compatible", async () => {
    const acp = client(FORWARD_COMPAT_ACP);
    try {
      await within(acp.initialize());
      await within(acp.newSession(process.cwd()));
      assert.equal(await within(acp.prompt("future methods")), "");
    } finally {
      acp.close();
    }
  });

  test("lets a protocol failure later in the same stdout batch beat response success", async (t) => {
    await t.test("initialize response", async () => {
      const acp = client(BATCHED_INITIALIZE_FAILURE_ACP);
      try {
        await assert.rejects(within(acp.initialize()), /ACP transport protocol error/);
        await assert.rejects(within(acp.initialize()), /ACP transport protocol error/);
      } finally {
        acp.close();
      }
    });

    await t.test("prompt response", async () => {
      const acp = client(BATCHED_PROMPT_FAILURE_ACP);
      try {
        await within(acp.initialize());
        await within(acp.newSession(process.cwd()));
        await assert.rejects(within(acp.prompt("must not succeed")), /ACP transport protocol error/);
      } finally {
        acp.close();
      }
    });
  });

  test("fails duplicate terminal responses before either conflicting result can settle", async (t) => {
    await t.test("initialize success then error", async () => {
      const acp = client(DUPLICATE_INITIALIZE_RESPONSE_ACP);
      let settlements = 0;
      try {
        const initializing = acp.initialize();
        void initializing.then(
          () => { settlements += 1; },
          () => { settlements += 1; },
        );
        await assert.rejects(
          within(initializing),
          (error: unknown) => {
            assert.equal((error as Error).message, "ACP transport protocol error");
            assert.doesNotMatch(String(error), /PRIVATE-DUPLICATE-INITIALIZE/);
            return true;
          },
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settlements, 1);
        await assert.rejects(within(acp.initialize(), 100), /ACP transport protocol error/);
      } finally {
        acp.close();
      }
    });

    await t.test("prompt error then success", async () => {
      const acp = client(DUPLICATE_PROMPT_RESPONSE_ACP);
      let settlements = 0;
      try {
        await within(acp.initialize());
        await within(acp.newSession(process.cwd()));
        const prompting = acp.prompt("must fail closed");
        void prompting.then(
          () => { settlements += 1; },
          () => { settlements += 1; },
        );
        await assert.rejects(
          within(prompting),
          (error: unknown) => {
            assert.equal((error as Error).message, "ACP transport protocol error");
            assert.doesNotMatch(String(error), /PRIVATE-DUPLICATE-PROMPT/);
            return true;
          },
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settlements, 1);
        await assert.rejects(within(acp.prompt("later retry"), 100), /ACP transport protocol error/);
      } finally {
        acp.close();
      }
    });

    await t.test("initialize response duplicated after settlement", async () => {
      const acp = client(DELAYED_DUPLICATE_INITIALIZE_RESPONSE_ACP);
      try {
        assert.deepEqual(await within(acp.initialize()), { authMethods: [] });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await assert.rejects(
          within(acp.initialize(), 100),
          (error: unknown) => {
            assert.equal((error as Error).message, "ACP transport protocol error");
            assert.doesNotMatch(String(error), /PRIVATE-DELAYED-DUPLICATE/);
            return true;
          },
        );
      } finally {
        acp.close();
      }
    });
  });

  test("fails terminal prompt results without a required nonempty stopReason", async (t) => {
    const cases: Array<[string, unknown]> = [
      ["missing stopReason", {}],
      ["null stopReason", { stopReason: null }],
      ["numeric stopReason", { stopReason: 7 }],
      ["empty stopReason", { stopReason: "" }],
      ["whitespace-only stopReason", { stopReason: " \t\n" }],
      ["non-object result", null],
    ];
    for (const [name, result] of cases) {
      await t.test(name, async () => {
        let resolveReady!: () => void;
        const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
        const acp = new AcpClient({
          command: process.execPath,
          args: ["-e", INVALID_PROMPT_RESULT_ACP, JSON.stringify(result)],
          env: { ...process.env },
        }, process.cwd(), {
          onStderr(line) {
            if (line === "ready") resolveReady();
          },
        }, { startDeadlineMs: 1_000 });
        let settlements = 0;
        try {
          await within(ready);
          await within(acp.initialize());
          await within(acp.newSession(process.cwd()));
          const prompting = acp.prompt("terminal response must be valid");
          void prompting.then(
            () => { settlements += 1; },
            () => { settlements += 1; },
          );
          await assert.rejects(
            within(prompting, 250),
            (error: unknown) => {
              assert.equal((error as Error).message, "ACP transport protocol error");
              return true;
            },
          );
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(settlements, 1);
        } finally {
          acp.close();
        }
      });
    }
  });

  test("fails deeply nested update content without crashing the parent process", async () => {
    const broken = client(DEEPLY_NESTED_UPDATE_ACP);
    let rejectionCount = 0;
    try {
      await within(broken.initialize());
      await within(broken.newSession(process.cwd()));
      const running = broken.prompt("deep input").catch((error: unknown) => {
        rejectionCount += 1;
        throw error;
      });
      await assert.rejects(
        within(running),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport protocol error");
          assert.doesNotMatch(String(error), /PRIVATE-DEEP-CONTENT/);
          return true;
        },
      );
      assert.equal(rejectionCount, 1);
    } finally {
      broken.close();
    }

    const fresh = client(HEALTHY_ACP);
    try {
      await within(fresh.initialize());
      await within(fresh.newSession(process.cwd()));
      assert.equal(await within(fresh.prompt("parent survived")), "");
    } finally {
      fresh.close();
    }
  });

  test("preserves ordinary nested object and array content", async () => {
    const acp = client(NESTED_CONTENT_ACP);
    try {
      await within(acp.initialize());
      await within(acp.newSession(process.cwd()));
      assert.equal(await within(acp.prompt("normal nesting")), "one two three");
    } finally {
      acp.close();
    }
  });

  test("sanitizes a valid JSON-RPC error while preserving its classification", async () => {
    const broken = rawLineClient(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32_000, message: "PRIVATE-CLI-AUTH-CREDENTIAL" },
    }));
    try {
      await assert.rejects(
        within(broken.initialize()),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP authentication failed");
          assert.equal((error as { code?: unknown }).code, -32_000);
          assert.doesNotMatch(String(error), /PRIVATE-CLI-AUTH-CREDENTIAL/);
          return true;
        },
      );
    } finally {
      broken.close();
    }
  });

  test("drains active Turn, permission, and elicitation state on malformed input", async () => {
    const acp = client(ACTIVE_STATE_THEN_NULL_ACP);
    let permissionId: number | string | undefined;
    let computerHelpId: number | string | undefined;
    let computerHelpCancelled = 0;
    try {
      await within(acp.initialize());
      await within(acp.newSession(process.cwd()));
      await assert.rejects(
        within(acp.prompt("PRIVATE-PROMPT-TEXT", {
          onPermission(prompt) {
            permissionId = prompt.rpcId;
          },
          onComputerHelp(prompt) {
            computerHelpId = prompt.rpcId;
          },
          onComputerHelpCancelled() {
            computerHelpCancelled += 1;
          },
        })),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport protocol error");
          assert.doesNotMatch(String(error), /PRIVATE-PROMPT-TEXT/);
          return true;
        },
      );
      assert.equal(permissionId, 700);
      assert.equal(computerHelpId, 701);
      assert.equal(computerHelpCancelled, 1);
      await assert.rejects(
        acp.respondPermission(permissionId, "allow-once"),
        /Permission request is no longer active/,
      );
      await assert.rejects(acp.respondComputerHelp(computerHelpId, "done"), /no longer active/);
    } finally {
      acp.close();
    }
  });
});
