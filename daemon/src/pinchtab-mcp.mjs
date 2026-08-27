import { spawn } from "node:child_process";
import { filterAllowlistedTools, normalizePinchTabToolName, pinchTabToolAllowed } from "./pinchtab-allowlist.mjs";

const BRING_FRONT = new Set([
  "navigate",
  "click",
  "type",
  "fill",
  "select",
  "key",
  "press",
  "scroll",
  "back",
  "screenshot",
  "wait",
  "wait_for_selector",
  "wait_for_text",
  "wait_for_url",
  "wait_for_load",
]);

const CHILD_EOF_GRACE_MS = 250;
const CHILD_FORCE_KILL_GRACE_MS = 1_000;
const RPC_HEADER_MAX_BYTES = 64 * 1024;
const RPC_BODY_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_RPC_ID_LEDGER_MAX = 4_096;

export function shouldBringTabFront(name) {
  return BRING_FRONT.has(normalizePinchTabToolName(name));
}

export function tabIdFromToolResult(result) {
  if (!result || typeof result !== "object") return "";
  if (typeof result.tabId === "string" && result.tabId) return result.tabId;
  if (typeof result.tab_id === "string" && result.tab_id) return result.tab_id;
  const content = result.content;
  if (!Array.isArray(content)) return "";
  for (const part of content) {
    if (!part || typeof part.text !== "string") continue;
    try {
      const parsed = JSON.parse(part.text);
      if (parsed && typeof parsed.tabId === "string" && parsed.tabId) return parsed.tabId;
      if (parsed && typeof parsed.tab_id === "string" && parsed.tab_id) return parsed.tab_id;
    } catch {
      const match = /"tabId"\s*:\s*"([^"]+)"/.exec(part.text);
      if (match) return match[1];
    }
  }
  return "";
}

function toolArguments(params) {
  if (!params || typeof params !== "object") return {};
  const args = params.arguments;
  return args && typeof args === "object" ? args : {};
}

export async function reuseExistingTabId(server, token) {
  if (!server) return "";
  try {
    const res = await fetch(`${server.replace(/\/$/, "")}/tabs`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return "";
    const data = await res.json();
    const tabs = Array.isArray(data?.tabs) ? data.tabs : Array.isArray(data) ? data : [];
    const page = tabs.find((tab) => tab && (tab.type === "page" || tab.url)) ?? tabs[0];
    if (!page || typeof page !== "object") return "";
    if (typeof page.id === "string" && page.id) return page.id;
    if (typeof page.tabId === "string" && page.tabId) return page.tabId;
    return "";
  } catch {
    return "";
  }
}

export async function focusPinchTab(server, token, tabId) {
  if (!server || !tabId) return;
  const response = await fetch(`${server.replace(/\/$/, "")}/tab`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action: "focus", tabId }),
    signal: AbortSignal.timeout(5000),
  });
  const ok = response.ok;
  const status = response.status;
  try {
    await response.body?.cancel();
  } catch {
    /* response status is still authoritative */
  }
  if (!ok) {
    throw new Error(`PinchTab focus failed with HTTP ${status}`);
  }
}

export async function prepareBrowseCall(name, args, server, token) {
  const next = { ...(args && typeof args === "object" ? args : {}) };
  const existing =
    typeof next.tabId === "string" && next.tabId
      ? next.tabId
      : typeof next.tab_id === "string" && next.tab_id
        ? next.tab_id
        : "";
  let tabId = existing;
  if (!tabId) tabId = await reuseExistingTabId(server, token);
  if (tabId) {
    await focusPinchTab(server, token, tabId);
    if (!next.tabId && !next.tab_id) next.tabId = tabId;
  }
  return next;
}

function parseRpcObject(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Malformed JSON-RPC JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON-RPC message must be an object");
  }
  return parsed;
}

function rpcMessageKind(obj) {
  if (obj.jsonrpc !== "2.0") return "invalid";
  const hasMethod = Object.prototype.hasOwnProperty.call(obj, "method");
  const hasResult = Object.prototype.hasOwnProperty.call(obj, "result");
  const hasError = Object.prototype.hasOwnProperty.call(obj, "error");
  const hasId = Object.prototype.hasOwnProperty.call(obj, "id");
  if (
    hasId &&
    (obj.id === null ||
      (typeof obj.id !== "string" &&
        !(typeof obj.id === "number" && Number.isFinite(obj.id))))
  ) {
    return "invalid";
  }
  if (hasMethod) {
    if (typeof obj.method !== "string" || hasResult || hasError) return "invalid";
    return hasId ? "request" : "notification";
  }
  if (hasId && hasResult !== hasError) return "response";
  return "invalid";
}

class RpcReader {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.mode = "unknown";
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const messages = [];
    let error = null;
    while (true) {
      let next;
      try {
        next = this.pull();
      } catch (cause) {
        error = cause instanceof Error ? cause : new Error(String(cause));
        break;
      }
      if (!next) break;
      messages.push(next);
    }
    return { messages, error };
  }

  hasBufferedData() {
    return this.buf.length > 0;
  }

  pull() {
    if (this.buf.length === 0) return null;
    if (this.mode === "unknown") {
      let i = 0;
      while (
        i < this.buf.length &&
        (this.buf[i] === 0x20 || this.buf[i] === 0x0d || this.buf[i] === 0x0a || this.buf[i] === 0x09)
      ) {
        i += 1;
      }
      if (i >= this.buf.length) return null;
      if (this.buf[i] === 0x7b) {
        this.mode = "ndjson";
      } else {
        const headerEnd = this.buf.indexOf(Buffer.from("\r\n\r\n"), i);
        const newline = this.buf.indexOf(0x0a, i);
        if (headerEnd !== -1) {
          this.mode = "lsp";
        } else if (newline !== -1) {
          const firstLine = this.buf.subarray(i, newline).toString("utf8").replace(/\r$/, "");
          this.mode = /^(?:Content-Length|Content-Type)\s*:/i.test(firstLine)
            ? "lsp"
            : "ndjson";
        } else {
          if (this.buf.length > RPC_HEADER_MAX_BYTES) {
            throw new Error("Malformed JSON-RPC framing prefix exceeds the header limit");
          }
          return null;
        }
      }
    }
    if (this.mode === "ndjson") {
      const nl = this.buf.indexOf(0x0a);
      if (nl === -1) {
        if (this.buf.length > RPC_BODY_MAX_BYTES) {
          throw new Error("Malformed JSON-RPC NDJSON frame exceeds the body limit");
        }
        return null;
      }
      if (nl > RPC_BODY_MAX_BYTES) {
        throw new Error("Malformed JSON-RPC NDJSON frame exceeds the body limit");
      }
      const line = this.buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
      this.buf = this.buf.subarray(nl + 1);
      if (!line.trim()) return this.pull();
      return { obj: parseRpcObject(line), framing: "ndjson" };
    }
    const headerEnd = this.buf.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) {
      const lfOnly = this.buf.findIndex(
        (byte, index) => byte === 0x0a && (index === 0 || this.buf[index - 1] !== 0x0d),
      );
      if (lfOnly !== -1) {
        throw new Error("Malformed JSON-RPC LSP header requires CRLF line endings");
      }
      if (this.buf.length > RPC_HEADER_MAX_BYTES) {
        throw new Error("Malformed JSON-RPC LSP header exceeds the header limit");
      }
      return null;
    }
    if (headerEnd > RPC_HEADER_MAX_BYTES) {
      throw new Error("Malformed JSON-RPC LSP header exceeds the header limit");
    }
    const header = this.buf.subarray(0, headerEnd).toString("utf8");
    const match = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(header);
    if (!match) throw new Error("Malformed JSON-RPC LSP header: missing Content-Length");
    const len = Number(match[1]);
    if (!Number.isSafeInteger(len) || len < 1 || len > RPC_BODY_MAX_BYTES) {
      throw new Error("Malformed JSON-RPC LSP header: invalid Content-Length");
    }
    const start = headerEnd + 4;
    if (this.buf.length < start + len) return null;
    const body = this.buf.subarray(start, start + len).toString("utf8");
    this.buf = this.buf.subarray(start + len);
    return { obj: parseRpcObject(body), framing: "lsp" };
  }
}

function encode(obj, framing) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  if (framing === "lsp") {
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  }
  return Buffer.concat([body, Buffer.from("\n")]);
}

function toolNameFromCall(params) {
  if (!params || typeof params !== "object") return "";
  return typeof params.name === "string" ? params.name : "";
}

function filterListResult(result) {
  if (!result || typeof result !== "object") return result;
  if (!Array.isArray(result.tools)) return result;
  return { ...result, tools: filterAllowlistedTools(result.tools) };
}

function argvValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return undefined;
  const value = process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

/**
 * @param {import("node:stream").Readable} [stdin]
 * @param {import("node:stream").Writable} [stdout]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function runPinchTabAllowlistProxy(
  stdin = process.stdin,
  stdout = process.stdout,
  env = process.env,
) {
  const bin = env.OPENBOT_PINCHTAB || argvValue("--bin");
  const server = env.OPENBOT_PINCHTAB_SERVER || argvValue("--server");
  const token = env.PINCHTAB_TOKEN || argvValue("--token");
  if (!bin || !server) {
    console.error("OPENBOT_PINCHTAB and OPENBOT_PINCHTAB_SERVER are required");
    return Promise.resolve(1);
  }
  const configuredRequestTimeout = Number(env.OPENBOT_PINCHTAB_MCP_REQUEST_TIMEOUT_MS);
  const requestTimeoutMs =
    Number.isFinite(configuredRequestTimeout) && configuredRequestTimeout > 0
      ? Math.ceil(configuredRequestTimeout)
      : 60_000;
  const configuredChildRequestTimeout = Number(
    env.OPENBOT_PINCHTAB_MCP_CHILD_REQUEST_TIMEOUT_MS,
  );
  const childRequestTimeoutMs =
    Number.isFinite(configuredChildRequestTimeout) && configuredChildRequestTimeout > 0
      ? Math.ceil(configuredChildRequestTimeout)
      : requestTimeoutMs;
  const configuredIdLedgerMax = Number(env.OPENBOT_PINCHTAB_MCP_ID_LEDGER_MAX);
  const idLedgerMax =
    Number.isSafeInteger(configuredIdLedgerMax) && configuredIdLedgerMax > 0
      ? configuredIdLedgerMax
      : DEFAULT_RPC_ID_LEDGER_MAX;

  const child = spawn(bin, ["--server", server, "mcp"], {
    env: { ...env, PINCHTAB_TOKEN: token ?? "" },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const fromClient = new RpcReader();
  const fromChild = new RpcReader();
  const listIds = new Set();
  const toolResponseWaiters = new Map();
  const pending = new Map();
  const requestTimers = new Map();
  const terminalIds = new Set();
  const receivedResponseIds = new Set();
  const usedClientIds = new Set();
  const childRequests = new Map();
  const usedChildRequestIds = new Set();
  let clientFraming = "ndjson";
  let sendChain = Promise.resolve();
  let childExited = false;
  let transportClosing = false;
  let forceKillTimer;
  let eofShutdownTimer;
  let clientFrameTimer;
  let childFrameTimer;
  let outputBackpressureTimer;
  let outputBackpressured = false;
  let clientOutputFailed = false;

  function disarmOutputBackpressure() {
    if (outputBackpressureTimer) clearTimeout(outputBackpressureTimer);
    outputBackpressureTimer = undefined;
    stdout.off("drain", onClientOutputDrain);
  }

  function onClientOutputDrain() {
    if (!outputBackpressured) return;
    disarmOutputBackpressure();
    outputBackpressured = false;
    if (transportClosing || childExited) return;
    child.stdout?.resume?.();
    stdin.resume?.();
  }

  function beginOutputBackpressure() {
    if (outputBackpressured) return;
    outputBackpressured = true;
    stdin.pause?.();
    child.stdout?.pause?.();
    if (transportClosing || childExited) return;
    stdout.once("drain", onClientOutputDrain);
    outputBackpressureTimer = setTimeout(() => {
      terminateTransport(
        new Error(
          `PinchTab MCP client output did not drain after ${requestTimeoutMs}ms; transport terminated`,
        ),
      );
    }, requestTimeoutMs);
    outputBackpressureTimer.unref?.();
  }

  function onClientOutputError(error) {
    if (clientOutputFailed) return;
    clientOutputFailed = true;
    const detail = error instanceof Error ? error.message : String(error);
    terminateTransport(new Error(`PinchTab MCP client output failed: ${detail}`));
  }

  const writeOut = (obj, framing) => {
    if (clientOutputFailed) return false;
    if (outputBackpressured) {
      if (!transportClosing && !childExited) {
        terminateTransport(
          new Error("PinchTab MCP client output queue remained backpressured"),
        );
      }
      return false;
    }
    if (stdout.destroyed || stdout.writableEnded) {
      onClientOutputError(new Error("PinchTab MCP client output is closed"));
      return false;
    }
    try {
      const accepted = stdout.write(encode(obj, framing), (error) => {
        if (error) onClientOutputError(error);
      });
      if (!accepted && !clientOutputFailed) beginOutputBackpressure();
      return accepted;
    } catch (error) {
      onClientOutputError(error);
      return false;
    }
  };

  const rememberRequest = (obj, framing) => {
    if (obj.id !== undefined && obj.id !== null) {
      if (usedClientIds.has(obj.id)) {
        if (pending.has(obj.id)) {
          terminateTransport(
            new Error(
              `PinchTab MCP request ID ${String(obj.id)} is already pending; transport terminated`,
            ),
          );
          return false;
        }
        writeOut(
          {
            jsonrpc: "2.0",
            id: obj.id,
            error: {
              code: -32600,
              message: `PinchTab MCP request ID ${String(obj.id)} was already used`,
            },
          },
          framing,
        );
        return false;
      }
      if (usedClientIds.size >= idLedgerMax) {
        const error = new Error(
          `PinchTab MCP client request ID ledger reached ${idLedgerMax}; transport reset required`,
        );
        writeOut(
          {
            jsonrpc: "2.0",
            id: obj.id,
            error: { code: -32000, message: error.message },
          },
          framing,
        );
        terminateTransport(error);
        return false;
      }
      usedClientIds.add(obj.id);
      pending.set(obj.id, { framing });
    }
    return true;
  };

  const clearRequestTimer = (id) => {
    const timer = requestTimers.get(id);
    if (timer) clearTimeout(timer);
    requestTimers.delete(id);
  };

  const completeRequest = (id) => {
    clearRequestTimer(id);
    listIds.delete(id);
    receivedResponseIds.delete(id);
    pending.delete(id);
  };

  const rejectPending = (id, fallbackFraming, error, terminal = false) => {
    if (id === undefined || id === null) {
      console.error(error instanceof Error ? error.message : String(error));
      return;
    }
    const tracked = pending.get(id);
    if (!tracked) return;
    completeRequest(id);
    if (terminal) terminalIds.add(id);
    const waiter = toolResponseWaiters.get(id);
    toolResponseWaiters.delete(id);
    waiter?.reject(error instanceof Error ? error : new Error(String(error)));
    const detail = error instanceof Error ? error.message : String(error);
    writeOut(
      {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: `PinchTab MCP request failed: ${detail}` },
      },
      tracked.framing ?? fallbackFraming,
    );
  };

  const rejectAllPending = (error, terminal = false) => {
    for (const [id, tracked] of [...pending.entries()]) {
      rejectPending(id, tracked.framing, error, terminal);
    }
  };

  const clearChildRequest = (id) => {
    const tracked = childRequests.get(id);
    if (tracked?.timer) clearTimeout(tracked.timer);
    childRequests.delete(id);
  };

  const clearAllChildRequests = () => {
    for (const id of [...childRequests.keys()]) clearChildRequest(id);
  };

  const clearFrameDeadlines = () => {
    if (clientFrameTimer) clearTimeout(clientFrameTimer);
    if (childFrameTimer) clearTimeout(childFrameTimer);
    clientFrameTimer = undefined;
    childFrameTimer = undefined;
  };

  const terminateTransport = (error) => {
    if (transportClosing || childExited) return;
    transportClosing = true;
    if (eofShutdownTimer) clearTimeout(eofShutdownTimer);
    disarmOutputBackpressure();
    clearFrameDeadlines();
    clearAllChildRequests();
    rejectAllPending(error, true);
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => {
      if (!childExited) child.kill("SIGKILL");
    }, CHILD_FORCE_KILL_GRACE_MS);
    forceKillTimer.unref?.();
  };

  const failClientFraming = (error) => {
    if (transportClosing || childExited) return;
    const detail = error instanceof Error ? error.message : String(error);
    writeOut(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: `PinchTab MCP client parse failed: ${detail}` },
      },
      clientFraming,
    );
    terminateTransport(new Error(`PinchTab MCP client emitted malformed JSON-RPC: ${detail}`));
  };

  const syncFrameDeadline = (reader, direction, completedFrames) => {
    const isClient = direction === "client";
    const current = isClient ? clientFrameTimer : childFrameTimer;
    if (!reader.hasBufferedData()) {
      if (current) clearTimeout(current);
      if (isClient) clientFrameTimer = undefined;
      else childFrameTimer = undefined;
      return;
    }
    if (current && completedFrames === 0) return;
    if (current) clearTimeout(current);
    const timer = setTimeout(() => {
      const error = new Error(
        `PinchTab MCP ${direction} frame assembly timed out after ${requestTimeoutMs}ms`,
      );
      if (isClient) failClientFraming(error);
      else terminateTransport(error);
    }, requestTimeoutMs);
    if (isClient) clientFrameTimer = timer;
    else childFrameTimer = timer;
  };

  const armRequestTimeout = (id) => {
    if (id === undefined || id === null || requestTimers.has(id)) return;
    const timer = setTimeout(() => {
      terminateTransport(
        new Error(
          `PinchTab MCP request ${String(id)} timed out after ${requestTimeoutMs}ms; transport terminated`,
        ),
      );
    }, requestTimeoutMs);
    requestTimers.set(id, timer);
  };

  const rememberChildRequest = (obj, framing) => {
    if (usedChildRequestIds.has(obj.id)) {
      terminateTransport(
        new Error(`PinchTab MCP child reused request ID ${String(obj.id)}`),
      );
      return false;
    }
    if (usedChildRequestIds.size >= idLedgerMax) {
      terminateTransport(
        new Error(
          `PinchTab MCP child request ID ledger reached ${idLedgerMax}; transport reset required`,
        ),
      );
      return false;
    }
    usedChildRequestIds.add(obj.id);
    const timer = setTimeout(() => {
      terminateTransport(
        new Error(
          `PinchTab MCP child request ${String(obj.id)} timed out after ${childRequestTimeoutMs}ms`,
        ),
      );
    }, childRequestTimeoutMs);
    childRequests.set(obj.id, { framing, timer });
    return true;
  };

  const writeChild = (obj, framing) =>
    new Promise((resolve, reject) => {
      if (!child.stdin || child.stdin.destroyed || childExited || transportClosing) {
        const error = new Error("PinchTab MCP child stdin is closed");
        terminateTransport(error);
        reject(error);
        return;
      }
      try {
        child.stdin.write(encode(obj, framing), (error) => {
          if (error) {
            terminateTransport(error);
            reject(error);
          } else {
            resolve();
          }
        });
      } catch (error) {
        terminateTransport(error);
        reject(error);
      }
    });

  const enqueueSend = (id, framing, fn) => {
    const next = sendChain.then(fn);
    sendChain = next.catch(() => undefined);
    void next.catch((error) => rejectPending(id, framing, error));
  };

  const waitForToolResponse = (id) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        terminateTransport(
          new Error(
            `PinchTab MCP request ${String(id)} timed out after ${requestTimeoutMs}ms; transport terminated to preserve ordering`,
          ),
        );
      }, requestTimeoutMs);
      toolResponseWaiters.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
    });

  const onClientData = (chunk) => {
    if (transportClosing) return;
    const parsed = fromClient.push(chunk);
    const { messages } = parsed;
    for (const { obj, framing } of messages) {
      if (transportClosing) return;
      clientFraming = framing;
      const kind = rpcMessageKind(obj);
      if (kind === "response") {
        const childRequest = childRequests.get(obj.id);
        if (!childRequest) {
          terminateTransport(
            new Error(`PinchTab MCP client emitted an unsolicited response ID ${String(obj.id)}`),
          );
          return;
        }
        clearChildRequest(obj.id);
        void writeChild(obj, childRequest.framing).catch(() => undefined);
        continue;
      }
      if (kind === "invalid") {
        const responseId =
          typeof obj.id === "string" ||
          (typeof obj.id === "number" && Number.isFinite(obj.id))
            ? obj.id
            : null;
        writeOut(
          {
            jsonrpc: "2.0",
            id: responseId,
            error: { code: -32600, message: "PinchTab MCP client message is not a JSON-RPC request" },
          },
          framing,
        );
        terminateTransport(new Error("PinchTab MCP client emitted an invalid JSON-RPC message"));
        return;
      }
      if (kind === "notification" && !obj.method.startsWith("notifications/")) {
        writeOut(
          {
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32600,
              message: `PinchTab MCP method ${obj.method} requires a request ID`,
            },
          },
          framing,
        );
        terminateTransport(
          new Error(`PinchTab MCP client sent request-only method ${obj.method} as a notification`),
        );
        return;
      }
      if (obj.method === "tools/call") {
        const name = toolNameFromCall(obj.params);
        if (!pinchTabToolAllowed(name)) {
          if (obj.id !== undefined && obj.id !== null) {
            writeOut(
              {
                jsonrpc: "2.0",
                id: obj.id,
                error: { code: -32601, message: `OpenBot does not allow PinchTab tool ${name}` },
              },
              framing,
            );
          }
          continue;
        }
        if (!rememberRequest(obj, framing)) continue;
        enqueueSend(obj.id, framing, async () => {
          if (transportClosing || !pending.has(obj.id)) return;
          const args = shouldBringTabFront(name)
            ? await prepareBrowseCall(name, toolArguments(obj.params), server, token)
            : toolArguments(obj.params);
          const next = { ...obj, params: { ...obj.params, arguments: args } };
          if (obj.id === undefined || obj.id === null) {
            await writeChild(next, framing);
            return;
          }
          const responsePromise = waitForToolResponse(obj.id);
          try {
            await writeChild(next, framing);
            const { obj: response } = await responsePromise;
            if (transportClosing || !pending.has(obj.id)) return;
            if (normalizePinchTabToolName(name) === "navigate" && response.result !== undefined) {
              const tabId = tabIdFromToolResult(response.result);
              if (tabId) await focusPinchTab(server, token, tabId);
            }
            if (transportClosing || !pending.has(obj.id)) return;
            const responseFraming = pending.get(obj.id)?.framing ?? framing;
            completeRequest(obj.id);
            writeOut(response, responseFraming);
          } finally {
            toolResponseWaiters.delete(obj.id);
          }
        });
        continue;
      }
      if (!rememberRequest(obj, framing)) continue;
      if (obj.method === "tools/list" && obj.id !== undefined && obj.id !== null) listIds.add(obj.id);
      armRequestTimeout(obj.id);
      void writeChild(obj, framing).catch((error) => rejectPending(obj.id, framing, error));
    }
    if (parsed.error) failClientFraming(parsed.error);
    else syncFrameDeadline(fromClient, "client", messages.length);
  };
  stdin.on("data", onClientData);

  child.stdout?.on("data", (chunk) => {
    if (transportClosing) return;
    const parsed = fromChild.push(chunk);
    const { messages } = parsed;
    for (const { obj, framing } of messages) {
      const kind = rpcMessageKind(obj);
      if (kind === "request" || kind === "notification") {
        if (obj.id !== undefined && obj.id !== null) {
          if (!rememberChildRequest(obj, framing)) return;
        }
        writeOut(obj, clientFraming);
        continue;
      }
      if (kind !== "response") {
        terminateTransport(new Error("PinchTab MCP child emitted an invalid JSON-RPC message"));
        return;
      }
      if (terminalIds.has(obj.id)) {
        continue;
      }
      if (!pending.has(obj.id) || receivedResponseIds.has(obj.id)) {
        terminateTransport(
          new Error(`PinchTab MCP child emitted a duplicate or unsolicited response ID ${String(obj.id)}`),
        );
        return;
      }
      receivedResponseIds.add(obj.id);
      const toolWaiter = toolResponseWaiters.get(obj.id);
      if (toolWaiter) {
        toolResponseWaiters.delete(obj.id);
        toolWaiter.resolve({ obj, framing });
        continue;
      }
      const responseFraming = pending.get(obj.id)?.framing ?? clientFraming ?? framing;
      if (obj.id !== undefined && obj.id !== null && listIds.has(obj.id) && obj.result !== undefined) {
        listIds.delete(obj.id);
        completeRequest(obj.id);
        writeOut({ ...obj, result: filterListResult(obj.result) }, responseFraming);
        continue;
      }
      if (obj.id !== undefined && obj.id !== null) completeRequest(obj.id);
      writeOut(obj, responseFraming);
    }
    if (parsed.error) {
      terminateTransport(
        new Error(`PinchTab MCP child emitted malformed JSON-RPC framing: ${parsed.error.message}`),
      );
    } else {
      syncFrameDeadline(fromChild, "child", messages.length);
    }
  });

  child.stdin?.on("error", (error) => {
    terminateTransport(error);
  });
  child.stdout?.on("error", (error) => terminateTransport(error));

  const onClientInputError = (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    terminateTransport(new Error(`PinchTab MCP client input failed: ${detail}`));
  };
  stdin.on("error", onClientInputError);
  stdout.on("error", onClientOutputError);

  const onClientEnd = () => {
    try {
      child.stdin?.end();
    } catch (error) {
      terminateTransport(error);
      return;
    }
    if (childExited || transportClosing) return;
    eofShutdownTimer = setTimeout(() => {
      terminateTransport(
        new Error("PinchTab MCP child did not exit after client EOF; transport terminated"),
      );
    }, CHILD_EOF_GRACE_MS);
    eofShutdownTimer.unref?.();
  };
  stdin.on("end", onClientEnd);

  const detachClient = () => {
    stdin.off("data", onClientData);
    stdin.off("end", onClientEnd);
    stdin.off("error", onClientInputError);
    stdout.off("error", onClientOutputError);
    stdin.pause?.();
  };

  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      childExited = true;
      transportClosing = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (eofShutdownTimer) clearTimeout(eofShutdownTimer);
      disarmOutputBackpressure();
      clearFrameDeadlines();
      clearAllChildRequests();
      detachClient();
      rejectAllPending(
        new Error(
          code === null
            ? `PinchTab MCP transport exited from signal ${signal ?? "unknown"}`
            : `PinchTab MCP transport exited with code ${code}`,
        ),
      );
      resolve(code ?? 1);
    });
    child.on("error", (err) => {
      childExited = true;
      transportClosing = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (eofShutdownTimer) clearTimeout(eofShutdownTimer);
      disarmOutputBackpressure();
      clearFrameDeadlines();
      clearAllChildRequests();
      detachClient();
      console.error(err.message);
      if (pending.size > 0) rejectAllPending(err, true);
      else {
        writeOut(
          { jsonrpc: "2.0", id: null, error: { code: -32000, message: "PinchTab MCP failed to start" } },
          clientFraming,
        );
      }
      resolve(1);
    });
  });
}

const isMain = process.argv.some((arg) => /pinchtab-mcp\.(mjs|js|ts)$/.test(arg));
if (isMain) {
  process.exitCode = await runPinchTabAllowlistProxy();
}
