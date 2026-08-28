import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AcpClient, type AcpHandlers } from "../src/acp.ts";

const POST_TERMINAL_STDERR_FLOOD_ACP = String.raw`
const { spawn } = require("node:child_process");
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
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId: "post-terminal-stderr-session" }
    });
    return;
  }
  if (message.method !== "session/prompt") return;
  send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  setTimeout(() => {
    const descendant = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);"
    ], { stdio: "ignore" });
    const lines = ["grandchild:" + descendant.pid + "\n"];
    for (let index = 0; index < 4_999; index += 1) {
      lines.push("PRIVATE-IDLE-STDERR-" + index + "\n");
    }
    process.stderr.write(lines.join(""));
  }, 100);
});
setInterval(() => {}, 1_000);
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
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "healthy-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`;

const PHASE_ITEM_FLOOD_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const phase = process.argv[1];
const itemCount = Number(process.argv[2]);
const attachmentMethod = process.argv[3] || "session/new";
const responseFor = (message) => JSON.stringify({
  jsonrpc: "2.0",
  id: message.id,
  result: message.method === "session/new" ? { sessionId: "phase-item-session" } : {}
}) + "\n";
const floodFor = (message) => {
  const frames = [];
  for (let index = 0; index < itemCount; index += 1) {
    frames.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "future/progress",
      params: { phase, index }
    }) + "\n");
  }
  frames.push(responseFor(message));
  process.stdout.write(frames.join(""));
};
process.on("SIGTERM", () => {});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (phase === "startup") floodFor(message);
    else process.stdout.write(responseFor(message));
    return;
  }
  if (message.method === attachmentMethod) {
    if (phase === "attachment") floodFor(message);
    else process.stdout.write(responseFor(message));
  }
});
setInterval(() => {}, 1_000);
`;

const IDLE_ITEM_FLOOD_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const stream = process.argv[1];
const itemCount = Number(process.argv[2]);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let promptCount = 0;
process.on("SIGTERM", () => {});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "idle-item-session" } });
    return;
  }
  if (message.method !== "session/prompt") return;
  promptCount += 1;
  send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  if (promptCount !== 1) return;
  setTimeout(() => {
    if (stream === "stderr") {
      const lines = [];
      for (let index = 0; index < itemCount; index += 1) {
        lines.push((index === itemCount - 1 ? "IDLE-READY" : "idle-stderr-" + index) + "\n");
      }
      process.stderr.write(lines.join(""));
      return;
    }
    const frames = [];
    for (let index = 0; index < itemCount; index += 1) {
      frames.push(JSON.stringify({
        jsonrpc: "2.0",
        method: "future/idle_progress",
        params: { index }
      }) + "\n");
    }
    process.stdout.write(frames.join(""));
  }, 100);
});
setInterval(() => {}, 1_000);
`;

const PHASE_WIRE_FLOOD_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const phase = process.argv[1];
const extraBytes = Number(process.argv[2]);
const responseFor = (message) => JSON.stringify({
  jsonrpc: "2.0",
  id: message.id,
  result: message.method === "session/new" ? { sessionId: "phase-wire-session" } : { authMethods: [] }
}) + "\n";
const writeBudget = (message) => {
  const response = responseFor(message);
  const remaining = 16 * 1024 * 1024 + extraBytes - Buffer.byteLength(response);
  const count = 64;
  const lines = Array.from({ length: count }, (_value, index) => {
    const targetBytes = Math.floor(remaining / count) + (index < remaining % count ? 1 : 0);
    const empty = JSON.stringify({
      jsonrpc: "2.0",
      method: "future/phase_wire",
      params: { index, padding: "" }
    }) + "\n";
    return JSON.stringify({
      jsonrpc: "2.0",
      method: "future/phase_wire",
      params: { index, padding: "w".repeat(targetBytes - Buffer.byteLength(empty)) }
    }) + "\n";
  });
  lines.push(response);
  process.stdout.write(lines.join(""));
};
process.on("SIGTERM", () => {});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (phase === "startup") writeBudget(message);
    else process.stdout.write(responseFor(message));
    return;
  }
  if (message.method === "session/new") {
    if (phase === "attachment") writeBudget(message);
    else process.stdout.write(responseFor(message));
  }
});
setInterval(() => {}, 1_000);
`;

const IDLE_WIRE_FLOOD_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const extraBytes = Number(process.argv[1]);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let promptCount = 0;
process.on("SIGTERM", () => {});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "idle-wire-session" } });
    return;
  }
  if (message.method !== "session/prompt") return;
  promptCount += 1;
  send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  if (promptCount !== 1) return;
  setTimeout(() => {
    const finalLine = "IDLE-WIRE-READY\n";
    let remaining = 16 * 1024 * 1024 + extraBytes - Buffer.byteLength(finalLine);
    const lines = [];
    while (remaining > 0) {
      const lineBytes = Math.min(remaining, 1024 * 1024);
      lines.push("i".repeat(lineBytes - 1) + "\n");
      remaining -= lineBytes;
    }
    lines.push(finalLine);
    process.stderr.write(lines.join(""));
  }, 100);
});
setInterval(() => {}, 1_000);
`;

const MIXED_IDLE_ITEM_FLOOD_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const extraStderrItems = Number(process.argv[1]);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let promptCount = 0;
process.on("SIGTERM", () => {});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "mixed-idle-item-session" } });
    return;
  }
  if (message.method !== "session/prompt") return;
  promptCount += 1;
  send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  if (promptCount !== 1) return;
  setTimeout(() => {
    const stdoutFrames = [];
    for (let index = 0; index < 2048; index += 1) {
      stdoutFrames.push(JSON.stringify({
        jsonrpc: "2.0",
        method: "future/mixed_idle_progress",
        params: { index }
      }) + "\n");
    }
    process.stdout.write(stdoutFrames.join(""), () => {
      setTimeout(() => {
        const stderrCount = 2048 + extraStderrItems;
        const stderrLines = [];
        for (let index = 0; index < stderrCount; index += 1) {
          stderrLines.push((index === stderrCount - 1
            ? "MIXED-IDLE-ITEM-READY"
            : "mixed-idle-stderr-" + index) + "\n");
        }
        process.stderr.write(stderrLines.join(""));
      }, 100);
    });
  }, 100);
});
setInterval(() => {}, 1_000);
`;

const MIXED_IDLE_WIRE_FLOOD_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const extraStderrBytes = Number(process.argv[1]);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const exactJsonLines = (totalBytes, count) => {
  const targets = Array.from({ length: count }, (_value, index) => (
    Math.floor(totalBytes / count) + (index < totalBytes % count ? 1 : 0)
  ));
  return targets.map((targetBytes, index) => {
    const empty = JSON.stringify({
      jsonrpc: "2.0",
      method: "future/mixed_idle_wire",
      params: { index, padding: "" }
    }) + "\n";
    return JSON.stringify({
      jsonrpc: "2.0",
      method: "future/mixed_idle_wire",
      params: { index, padding: "w".repeat(targetBytes - Buffer.byteLength(empty)) }
    }) + "\n";
  });
};
const exactStderrLines = (totalBytes) => {
  const finalLine = "MIXED-IDLE-WIRE-READY\n";
  const regularBytes = totalBytes - Buffer.byteLength(finalLine);
  const count = 16;
  const lines = Array.from({ length: count }, (_value, index) => {
    const lineBytes = Math.floor(regularBytes / count) + (index < regularBytes % count ? 1 : 0);
    return "e".repeat(lineBytes - 1) + "\n";
  });
  lines.push(finalLine);
  return lines;
};
let promptCount = 0;
process.on("SIGTERM", () => {});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "mixed-idle-wire-session" } });
    return;
  }
  if (message.method !== "session/prompt") return;
  promptCount += 1;
  send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  if (promptCount !== 1) return;
  setTimeout(() => {
    process.stdout.write(exactJsonLines(8 * 1024 * 1024, 32).join(""), () => {
      setTimeout(() => {
        process.stderr.write(exactStderrLines(8 * 1024 * 1024 + extraStderrBytes).join(""));
      }, 100);
    });
  }, 100);
});
setInterval(() => {}, 1_000);
`;

const PHASE_BOUNDARY_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const mode = process.argv[1];
const phaseFrames = (phase, message, trailing) => {
  if (trailing) {
    const entries = [];
    for (let index = 0; index < 4094; index += 1) {
      entries.push({
        jsonrpc: "2.0",
        method: "future/boundary_progress",
        params: { phase, index }
      });
    }
    entries.push({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId: "phase-boundary-session" }
    });
    entries.push({
      jsonrpc: "2.0",
      method: "future/boundary_after_response",
      params: { phase }
    });
    process.stdout.write(JSON.stringify(entries) + "\n");
    return;
  }
  const frames = [];
  for (let index = 0; index < 4095; index += 1) {
    frames.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "future/boundary_progress",
      params: { phase, index }
    }) + "\n");
  }
  frames.push(JSON.stringify({
    jsonrpc: "2.0",
    id: message.id,
    result: message.method === "session/new"
      ? { sessionId: "phase-boundary-session" }
      : { authMethods: [] }
  }) + "\n");
  process.stdout.write(frames.join(""));
};
process.on("SIGTERM", () => {});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    phaseFrames("startup", message, false);
    return;
  }
  if (message.method === "session/new") {
    phaseFrames("attachment", message, mode === "same-chunk-overflow");
    if (mode === "separate-phases") {
      setTimeout(() => {
        const lines = [];
        for (let index = 0; index < 4096; index += 1) {
          lines.push((index === 4095 ? "BOUNDARY-IDLE-READY" : "boundary-idle-" + index) + "\n");
        }
        process.stderr.write(lines.join(""));
      }, 100);
    }
    return;
  }
  if (message.method === "session/prompt") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn" }
    }) + "\n");
  }
});
setInterval(() => {}, 1_000);
`;

const SPLIT_STDOUT_PHASE_BOUNDARY_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const phase = process.argv[1];
const responseFor = (message) => JSON.stringify({
  jsonrpc: "2.0",
  id: message.id,
  result: message.method === "session/new"
    ? { sessionId: "split-stdout-boundary-session" }
    : { authMethods: [] }
}) + "\n";
const emitBoundary = (message) => {
  const frames = [];
  for (let index = 0; index < 4095; index += 1) {
    frames.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "future/split_stdout_boundary",
      params: { phase, index }
    }) + "\n");
  }
  frames.push(responseFor(message));
  const splitFrame = JSON.stringify({
    jsonrpc: "2.0",
    method: "future/split_stdout_after_response",
    params: { phase }
  });
  process.stdout.write(frames.join("") + splitFrame, () => {
    setTimeout(() => process.stdout.write("\n"), 150);
  });
};
process.on("SIGTERM", () => {});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (phase === "startup") emitBoundary(message);
    else process.stdout.write(responseFor(message));
    return;
  }
  if (message.method === "session/new") {
    if (phase === "attachment") emitBoundary(message);
    else process.stdout.write(responseFor(message));
  }
});
setInterval(() => {}, 1_000);
`;

const SPLIT_STDOUT_WIRE_PHASE_BOUNDARY_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const exactJsonLines = (totalBytes, count) => {
  const targets = Array.from({ length: count }, (_value, index) => (
    Math.floor(totalBytes / count) + (index < totalBytes % count ? 1 : 0)
  ));
  return targets.map((targetBytes, index) => {
    const empty = JSON.stringify({
      jsonrpc: "2.0",
      method: "future/split_stdout_wire_boundary",
      params: { index, padding: "" }
    }) + "\n";
    return JSON.stringify({
      jsonrpc: "2.0",
      method: "future/split_stdout_wire_boundary",
      params: { index, padding: "w".repeat(targetBytes - Buffer.byteLength(empty)) }
    }) + "\n";
  });
};
const responseFor = (message) => JSON.stringify({
  jsonrpc: "2.0",
  id: message.id,
  result: message.method === "session/new"
    ? { sessionId: "split-stdout-wire-boundary-session" }
    : message.method === "session/prompt"
      ? { stopReason: "end_turn" }
      : { authMethods: [] }
}) + "\n";
process.on("SIGTERM", () => {});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(responseFor(message));
    return;
  }
  if (message.method === "session/new") {
    const response = responseFor(message);
    const partialFrame = JSON.stringify({
      jsonrpc: "2.0",
      method: "future/split_stdout_wire_after_response",
      params: {}
    });
    const tail = response + partialFrame;
    const filler = exactJsonLines(
      16 * 1024 * 1024 - Buffer.byteLength(tail),
      32
    ).join("");
    process.stdout.write(filler, () => {
      process.stdout.write(tail, () => {
        setTimeout(() => process.stdout.write("\n"), 150);
      });
    });
    return;
  }
  if (message.method === "session/prompt") {
    process.stdout.write(responseFor(message));
  }
});
setInterval(() => {}, 1_000);
`;

const DELAYED_STDERR_PHASE_BOUNDARY_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const delimiter = process.argv[1];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
process.on("SIGTERM", () => {});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method !== "session/new") return;
  process.stderr.write("PRIVATE-DELAYED-BOUNDARY", () => {
    setTimeout(() => {
      const frames = [];
      for (let index = 0; index < 4095; index += 1) {
        frames.push(JSON.stringify({
          jsonrpc: "2.0",
          method: "future/delayed_stderr_boundary",
          params: { index }
        }) + "\n");
      }
      frames.push(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { sessionId: "delayed-stderr-boundary-session" }
      }) + "\n");
      process.stdout.write(frames.join(""), () => {
        setTimeout(() => {
          process.stderr.write("\r", () => {
            if (delimiter === "crlf") setTimeout(() => process.stderr.write("\n"), 20);
          });
        }, 150);
      });
    }, 150);
  });
});
setInterval(() => {}, 1_000);
`;

const DELAYED_STDERR_WIRE_PHASE_BOUNDARY_ACP = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const delimiter = process.argv[1];
const exactJsonLines = (totalBytes, count) => {
  const targets = Array.from({ length: count }, (_value, index) => (
    Math.floor(totalBytes / count) + (index < totalBytes % count ? 1 : 0)
  ));
  return targets.map((targetBytes, index) => {
    const empty = JSON.stringify({
      jsonrpc: "2.0",
      method: "future/delayed_stderr_wire_boundary",
      params: { index, padding: "" }
    }) + "\n";
    return JSON.stringify({
      jsonrpc: "2.0",
      method: "future/delayed_stderr_wire_boundary",
      params: { index, padding: "w".repeat(targetBytes - Buffer.byteLength(empty)) }
    }) + "\n";
  });
};
const responseFor = (message) => JSON.stringify({
  jsonrpc: "2.0",
  id: message.id,
  result: message.method === "session/new"
    ? { sessionId: "delayed-stderr-wire-boundary-session" }
    : message.method === "session/prompt"
      ? { stopReason: "end_turn" }
      : { authMethods: [] }
}) + "\n";
process.on("SIGTERM", () => {});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(responseFor(message));
    return;
  }
  if (message.method === "session/new") {
    const partialLine = "PRIVATE-DELAYED-WIRE-BOUNDARY";
    const response = responseFor(message);
    const bytesBeforeCr = 16 * 1024 * 1024 - (delimiter === "crlf" ? 1 : 0);
    const fillerBytes = bytesBeforeCr
      - Buffer.byteLength(partialLine)
      - Buffer.byteLength(response);
    process.stderr.write(partialLine, () => {
      setTimeout(() => {
        const frames = exactJsonLines(fillerBytes, 32);
        process.stdout.write(frames.join("") + response, () => {
          setTimeout(() => {
            process.stderr.write("\r", () => {
              if (delimiter === "crlf") {
                setTimeout(() => process.stderr.write("\n"), 20);
              }
            });
          }, 150);
        });
      }, 150);
    });
    return;
  }
  if (message.method === "session/prompt") {
    process.stdout.write(responseFor(message));
  }
});
setInterval(() => {}, 1_000);
`;

async function within<T>(promise: Promise<T>, milliseconds = 1_500): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("ACP lifecycle regression stayed pending")), milliseconds);
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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
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

async function waitForIdleFloodVerdict(
  groupId: number,
  callbackCount: () => number,
  milliseconds = 1_000,
): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (processGroupExists(groupId) && callbackCount() < 5_000 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function client(source: string, handlers: AcpHandlers = {}): AcpClient {
  return clientWithArgs(source, [], handlers);
}

function clientWithArgs(source: string, args: string[], handlers: AcpHandlers = {}): AcpClient {
  return new AcpClient({
    command: process.execPath,
    args: ["-e", source, ...args],
    env: { ...process.env },
  }, process.cwd(), handlers, { startDeadlineMs: 500, terminateGraceMs: 25 });
}

describe("AcpClient lifecycle output bounds", () => {
  test("allows exactly 4,096 startup items and rejects startup item 4,097", {
    skip: process.platform === "win32",
  }, async () => {
    const allowed = clientWithArgs(PHASE_ITEM_FLOOD_ACP, ["startup", "4095"]);
    try {
      assert.deepEqual(await within(allowed.initialize()), { authMethods: [] });
    } finally {
      const groupId = allowed.pid;
      allowed.close();
      if (groupId) await waitForProcessGroupGone(groupId);
    }

    const broken = clientWithArgs(PHASE_ITEM_FLOOD_ACP, ["startup", "4096"]);
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      await assert.rejects(
        within(broken.initialize()),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport protocol error");
          return true;
        },
      );
      await waitForProcessGroupGone(groupId);
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("bounds exact session new, load, and resume attachment item phases", {
    skip: process.platform === "win32",
  }, async (t) => {
    const cases = [
      ["session/new", (acp: AcpClient) => acp.newSession(process.cwd()), "phase-item-session"],
      ["session/load", (acp: AcpClient) => acp.loadSession("saved-session"), "saved-session"],
      ["session/resume", (acp: AcpClient) => acp.resumeSession("saved-session"), "saved-session"],
    ] as const;
    for (const [method, attach, expectedSessionId] of cases) {
      await t.test(method, async () => {
        const allowed = clientWithArgs(PHASE_ITEM_FLOOD_ACP, ["attachment", "4095", method]);
        try {
          assert.deepEqual(await within(allowed.initialize()), { authMethods: [] });
          assert.equal(await within(attach(allowed)), expectedSessionId);
        } finally {
          const groupId = allowed.pid;
          allowed.close();
          if (groupId) await waitForProcessGroupGone(groupId);
        }

        const broken = clientWithArgs(PHASE_ITEM_FLOOD_ACP, ["attachment", "4096", method]);
        const groupId = broken.pid;
        assert.ok(groupId);
        try {
          assert.deepEqual(await within(broken.initialize()), { authMethods: [] });
          await assert.rejects(
            within(attach(broken)),
            (error: unknown) => {
              assert.equal((error as Error).message, "ACP transport protocol error");
              return true;
            },
          );
          await waitForProcessGroupGone(groupId);
        } finally {
          broken.close();
          await waitForProcessGroupGone(groupId);
        }
      });
    }
  });

  test("enforces the exact 16 MiB wire ceiling for startup and attachment", {
    skip: process.platform === "win32",
  }, async (t) => {
    const cases = [
      ["startup", async (acp: AcpClient) => {
        assert.deepEqual(await within(acp.initialize(), 4_000), { authMethods: [] });
      }],
      ["attachment", async (acp: AcpClient) => {
        assert.deepEqual(await within(acp.initialize(), 4_000), { authMethods: [] });
        assert.equal(await within(acp.newSession(process.cwd()), 4_000), "phase-wire-session");
      }],
    ] as const;
    for (const [phase, exercise] of cases) {
      await t.test(phase, async () => {
        const allowed = clientWithArgs(PHASE_WIRE_FLOOD_ACP, [phase, "0"]);
        try {
          await exercise(allowed);
        } finally {
          const groupId = allowed.pid;
          allowed.close();
          if (groupId) await waitForProcessGroupGone(groupId);
        }

        const broken = clientWithArgs(PHASE_WIRE_FLOOD_ACP, [phase, "1"]);
        const groupId = broken.pid;
        assert.ok(groupId);
        try {
          await assert.rejects(
            exercise(broken),
            (error: unknown) => {
              assert.equal((error as Error).message, "ACP transport protocol error");
              return true;
            },
          );
          await waitForProcessGroupGone(groupId);
        } finally {
          broken.close();
          await waitForProcessGroupGone(groupId);
        }
      });
    }
  });

  test("allows exactly 4,096 idle items and rejects idle stdout item 4,097", {
    skip: process.platform === "win32",
  }, async () => {
    let idleStderrCallbacks = 0;
    let resolveIdleReady!: () => void;
    const idleReady = new Promise<void>((resolve) => { resolveIdleReady = resolve; });
    const allowed = clientWithArgs(IDLE_ITEM_FLOOD_ACP, ["stderr", "4096"], {
      onStderr(line) {
        idleStderrCallbacks += 1;
        if (line === "IDLE-READY") resolveIdleReady();
      },
    });
    try {
      assert.deepEqual(await within(allowed.initialize()), { authMethods: [] });
      assert.equal(await within(allowed.newSession(process.cwd())), "idle-item-session");
      assert.equal(await within(allowed.prompt("enter the exact idle item phase")), "");
      await within(idleReady);
      assert.equal(idleStderrCallbacks, 4_096);
      assert.equal(await within(allowed.prompt("reuse after the exact idle ceiling")), "");
    } finally {
      const groupId = allowed.pid;
      allowed.close();
      if (groupId) await waitForProcessGroupGone(groupId);
    }

    const broken = clientWithArgs(IDLE_ITEM_FLOOD_ACP, ["stdout", "4097"]);
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      assert.deepEqual(await within(broken.initialize()), { authMethods: [] });
      assert.equal(await within(broken.newSession(process.cwd())), "idle-item-session");
      assert.equal(await within(broken.prompt("finish before idle stdout overflow")), "");
      await waitForProcessGroupGone(groupId);
      await assert.rejects(
        within(broken.prompt("do not reuse idle stdout overflow"), 100),
        /ACP transport protocol error/,
      );
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("allows exactly 16 MiB of idle wire data and rejects the next byte", {
    skip: process.platform === "win32",
  }, async () => {
    let resolveIdleReady!: () => void;
    const idleReady = new Promise<void>((resolve) => { resolveIdleReady = resolve; });
    const allowed = clientWithArgs(IDLE_WIRE_FLOOD_ACP, ["0"], {
      onStderr(line) {
        if (line === "IDLE-WIRE-READY") resolveIdleReady();
      },
    });
    try {
      assert.deepEqual(await within(allowed.initialize()), { authMethods: [] });
      assert.equal(await within(allowed.newSession(process.cwd())), "idle-wire-session");
      assert.equal(await within(allowed.prompt("enter the exact idle wire phase")), "");
      await within(idleReady, 4_000);
      assert.equal(await within(allowed.prompt("reuse after the exact idle wire ceiling")), "");
    } finally {
      const groupId = allowed.pid;
      allowed.close();
      if (groupId) await waitForProcessGroupGone(groupId);
    }

    const broken = clientWithArgs(IDLE_WIRE_FLOOD_ACP, ["1"]);
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      assert.deepEqual(await within(broken.initialize()), { authMethods: [] });
      assert.equal(await within(broken.newSession(process.cwd())), "idle-wire-session");
      assert.equal(await within(broken.prompt("finish before idle wire overflow")), "");
      await waitForProcessGroupGone(groupId, 4_000);
      await assert.rejects(
        within(broken.prompt("do not reuse idle wire overflow"), 100),
        /ACP transport protocol error/,
      );
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("shares one exact 4,096-item idle budget across stdout and stderr", {
    skip: process.platform === "win32",
  }, async () => {
    let exactCallbacks = 0;
    let resolveExactReady!: () => void;
    const exactReady = new Promise<void>((resolve) => { resolveExactReady = resolve; });
    const exact = clientWithArgs(MIXED_IDLE_ITEM_FLOOD_ACP, ["0"], {
      onStderr(line) {
        exactCallbacks += 1;
        if (line === "MIXED-IDLE-ITEM-READY") resolveExactReady();
      },
    });
    try {
      assert.deepEqual(await within(exact.initialize()), { authMethods: [] });
      assert.equal(await within(exact.newSession(process.cwd())), "mixed-idle-item-session");
      assert.equal(await within(exact.prompt("settle before exact mixed idle items")), "");
      await within(exactReady, 4_000);
      assert.equal(exactCallbacks, 2_048);
      assert.equal(await within(exact.prompt("reuse after exact mixed idle items")), "");
    } finally {
      const groupId = exact.pid;
      exact.close();
      if (groupId) await waitForProcessGroupGone(groupId);
    }

    let overflowCallbacks = 0;
    const broken = clientWithArgs(MIXED_IDLE_ITEM_FLOOD_ACP, ["1"], {
      onStderr() {
        overflowCallbacks += 1;
      },
    });
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      assert.deepEqual(await within(broken.initialize()), { authMethods: [] });
      assert.equal(await within(broken.newSession(process.cwd())), "mixed-idle-item-session");
      assert.equal(await within(broken.prompt("settle before mixed idle item overflow")), "");
      await waitForProcessGroupGone(groupId, 4_000);
      assert.equal(overflowCallbacks, 2_048);
      await assert.rejects(
        within(broken.prompt("do not reuse mixed item overflow"), 100),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport protocol error");
          assert.doesNotMatch(String(error), /mixed idle|MIXED-IDLE/);
          return true;
        },
      );
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("shares one exact 16 MiB idle wire budget across stdout and stderr", {
    skip: process.platform === "win32",
  }, async () => {
    let resolveExactReady!: () => void;
    const exactReady = new Promise<void>((resolve) => { resolveExactReady = resolve; });
    const exact = clientWithArgs(MIXED_IDLE_WIRE_FLOOD_ACP, ["0"], {
      onStderr(line) {
        if (line === "MIXED-IDLE-WIRE-READY") resolveExactReady();
      },
    });
    try {
      assert.deepEqual(await within(exact.initialize()), { authMethods: [] });
      assert.equal(await within(exact.newSession(process.cwd())), "mixed-idle-wire-session");
      assert.equal(await within(exact.prompt("settle before exact mixed idle wire")), "");
      await within(exactReady, 4_000);
      assert.equal(await within(exact.prompt("reuse after exact mixed idle wire")), "");
    } finally {
      const groupId = exact.pid;
      exact.close();
      if (groupId) await waitForProcessGroupGone(groupId);
    }

    const broken = clientWithArgs(MIXED_IDLE_WIRE_FLOOD_ACP, ["1"]);
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      assert.deepEqual(await within(broken.initialize()), { authMethods: [] });
      assert.equal(await within(broken.newSession(process.cwd())), "mixed-idle-wire-session");
      assert.equal(await within(broken.prompt("settle before mixed idle wire overflow")), "");
      await waitForProcessGroupGone(groupId, 4_000);
      await assert.rejects(
        within(broken.prompt("do not reuse mixed wire overflow"), 100),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport protocol error");
          assert.doesNotMatch(String(error), /mixed idle|MIXED-IDLE/);
          return true;
        },
      );
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("resets only after settled phase boundaries and charges same-chunk boundary data once", {
    skip: process.platform === "win32",
  }, async () => {
    let idleCallbacks = 0;
    let resolveIdleReady!: () => void;
    const idleReady = new Promise<void>((resolve) => { resolveIdleReady = resolve; });
    const separated = clientWithArgs(PHASE_BOUNDARY_ACP, ["separate-phases"], {
      onStderr(line) {
        idleCallbacks += 1;
        if (line === "BOUNDARY-IDLE-READY") resolveIdleReady();
      },
    });
    try {
      assert.deepEqual(await within(separated.initialize()), { authMethods: [] });
      assert.equal(await within(separated.newSession(process.cwd())), "phase-boundary-session");
      await within(idleReady);
      assert.equal(idleCallbacks, 4_096);
      assert.equal(await within(separated.prompt("each settled phase receives a fresh budget")), "");
    } finally {
      const groupId = separated.pid;
      separated.close();
      if (groupId) await waitForProcessGroupGone(groupId);
    }

    const boundary = clientWithArgs(PHASE_BOUNDARY_ACP, ["same-chunk-overflow"]);
    const groupId = boundary.pid;
    assert.ok(groupId);
    try {
      assert.deepEqual(await within(boundary.initialize()), { authMethods: [] });
      await assert.rejects(
        within(boundary.newSession(process.cwd())),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport protocol error");
          return true;
        },
      );
      await waitForProcessGroupGone(groupId);
    } finally {
      boundary.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("keeps a split stdout item owned by its settled startup or attachment phase", {
    skip: process.platform === "win32",
  }, async (t) => {
    const cases = [
      ["startup", async (acp: AcpClient) => {
        assert.deepEqual(await within(acp.initialize()), { authMethods: [] });
      }],
      ["attachment", async (acp: AcpClient) => {
        assert.deepEqual(await within(acp.initialize()), { authMethods: [] });
        assert.equal(
          await within(acp.newSession(process.cwd())),
          "split-stdout-boundary-session",
        );
      }],
    ] as const;
    for (const [phase, exercise] of cases) {
      await t.test(phase, async () => {
        const broken = clientWithArgs(SPLIT_STDOUT_PHASE_BOUNDARY_ACP, [phase]);
        const groupId = broken.pid;
        assert.ok(groupId);
        try {
          await exercise(broken);
          await waitForProcessGroupGone(groupId, 4_000);
          await assert.rejects(
            within(broken.initialize(), 100),
            (error: unknown) => {
              assert.equal((error as Error).message, "ACP transport protocol error");
              return true;
            },
          );
        } finally {
          broken.close();
          await waitForProcessGroupGone(groupId);
        }
      });
    }
  });

  test("charges a split stdout delimiter to its settled attachment wire phase", {
    skip: process.platform === "win32",
  }, async () => {
    const broken = client(SPLIT_STDOUT_WIRE_PHASE_BOUNDARY_ACP);
    const groupId = broken.pid;
    assert.ok(groupId);
    try {
      assert.deepEqual(await within(broken.initialize()), { authMethods: [] });
      assert.equal(
        await within(broken.newSession(process.cwd()), 4_000),
        "split-stdout-wire-boundary-session",
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await assert.rejects(
        within(broken.prompt("do not borrow idle wire for the split delimiter"), 500),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport protocol error");
          return true;
        },
      );
      await waitForProcessGroupGone(groupId);
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
    }
  });

  test("keeps delayed CR and optional LF stderr items owned by the settled attachment phase", {
    skip: process.platform === "win32",
  }, async (t) => {
    for (const delimiter of ["cr", "crlf"] as const) {
      await t.test(delimiter, async () => {
        let stderrCallbacks = 0;
        const broken = clientWithArgs(DELAYED_STDERR_PHASE_BOUNDARY_ACP, [delimiter], {
          onStderr() {
            stderrCallbacks += 1;
          },
        });
        const groupId = broken.pid;
        assert.ok(groupId);
        try {
          assert.deepEqual(await within(broken.initialize()), { authMethods: [] });
          assert.equal(
            await within(broken.newSession(process.cwd())),
            "delayed-stderr-boundary-session",
          );
          await waitForProcessGroupGone(groupId, 4_000);
          assert.equal(stderrCallbacks, 0);
          await assert.rejects(
            within(broken.newSession(process.cwd()), 100),
            (error: unknown) => {
              assert.equal((error as Error).message, "ACP transport protocol error");
              assert.doesNotMatch(String(error), /PRIVATE-DELAYED-BOUNDARY/);
              return true;
            },
          );
        } finally {
          broken.close();
          await waitForProcessGroupGone(groupId);
        }
      });
    }
  });

  test("charges delayed CR and optional LF to their settled attachment wire phase", {
    skip: process.platform === "win32",
  }, async (t) => {
    for (const delimiter of ["cr", "crlf"] as const) {
      await t.test(delimiter, async () => {
        const broken = clientWithArgs(
          DELAYED_STDERR_WIRE_PHASE_BOUNDARY_ACP,
          [delimiter],
        );
        const groupId = broken.pid;
        assert.ok(groupId);
        try {
          assert.deepEqual(await within(broken.initialize()), { authMethods: [] });
          assert.equal(
            await within(broken.newSession(process.cwd()), 4_000),
            "delayed-stderr-wire-boundary-session",
          );
          await new Promise((resolve) => setTimeout(resolve, 300));
          await assert.rejects(
            within(broken.prompt("do not borrow idle wire for delayed stderr"), 500),
            (error: unknown) => {
              assert.equal((error as Error).message, "ACP transport protocol error");
              assert.doesNotMatch(String(error), /PRIVATE-DELAYED-WIRE-BOUNDARY/);
              return true;
            },
          );
          await waitForProcessGroupGone(groupId);
        } finally {
          broken.close();
          await waitForProcessGroupGone(groupId);
        }
      });
    }
  });

  test("contains the issue 121 5,000-line post-terminal stderr flood", {
    skip: process.platform === "win32",
  }, async () => {
    let stderrCallbacks = 0;
    let resolveDescendantPid!: (pid: number) => void;
    const descendantPid = new Promise<number>((resolve) => { resolveDescendantPid = resolve; });
    const broken = client(POST_TERMINAL_STDERR_FLOOD_ACP, {
      onStderr(line) {
        stderrCallbacks += 1;
        if (line.startsWith("grandchild:")) {
          resolveDescendantPid(Number(line.slice("grandchild:".length)));
        }
      },
    });
    const groupId = broken.pid;
    assert.ok(groupId);
    let descendant: number | undefined;
    try {
      assert.deepEqual(await within(broken.initialize()), { authMethods: [] });
      assert.equal(await within(broken.newSession(process.cwd())), "post-terminal-stderr-session");
      assert.equal(await within(broken.prompt("finish before the idle flood")), "");
      await waitForIdleFloodVerdict(groupId, () => stderrCallbacks);
      descendant = await within(descendantPid);
      assert.ok(Number.isSafeInteger(descendant) && descendant > 0);
      assert.equal(stderrCallbacks, 4_096);
      await waitForProcessGroupGone(groupId);
      assert.equal(processExists(descendant), false, "idle overflow descendant survived");
      await assert.rejects(
        within(broken.prompt("do not reuse the overflowed client"), 100),
        (error: unknown) => {
          assert.equal((error as Error).message, "ACP transport protocol error");
          assert.doesNotMatch(String(error), /PRIVATE-IDLE-STDERR|finish before|do not reuse/);
          return true;
        },
      );
    } finally {
      broken.close();
      await waitForProcessGroupGone(groupId);
      if (descendant !== undefined && processExists(descendant)) process.kill(descendant, "SIGKILL");
    }

    const fresh = client(HEALTHY_ACP);
    try {
      assert.deepEqual(await within(fresh.initialize()), { authMethods: [] });
      assert.equal(await within(fresh.newSession(process.cwd())), "healthy-session");
      assert.equal(await within(fresh.prompt("recover on a fresh client")), "");
    } finally {
      const freshGroupId = fresh.pid;
      fresh.close();
      if (freshGroupId) await waitForProcessGroupGone(freshGroupId);
    }
  });
});
