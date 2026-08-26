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
  try {
    await fetch(`${server.replace(/\/$/, "")}/tab`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ action: "focus", tabId }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* Screen Chrome stays as-is */
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

class RpcReader {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.mode = "unknown";
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    while (true) {
      const next = this.pull();
      if (!next) break;
      out.push(next);
    }
    return out;
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
      this.mode = this.buf[i] === 0x7b ? "ndjson" : "lsp";
    }
    if (this.mode === "ndjson") {
      const nl = this.buf.indexOf(0x0a);
      if (nl === -1) return null;
      const line = this.buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
      this.buf = this.buf.subarray(nl + 1);
      if (!line.trim()) return this.pull();
      return { obj: JSON.parse(line), framing: "ndjson" };
    }
    const headerEnd = this.buf.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) return null;
    const header = this.buf.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      this.buf = this.buf.subarray(headerEnd + 4);
      return null;
    }
    const len = Number(match[1]);
    const start = headerEnd + 4;
    if (this.buf.length < start + len) return null;
    const body = this.buf.subarray(start, start + len).toString("utf8");
    this.buf = this.buf.subarray(start + len);
    return { obj: JSON.parse(body), framing: "lsp" };
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

  const child = spawn(bin, ["--server", server, "mcp"], {
    env: { ...env, PINCHTAB_TOKEN: token ?? "" },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const fromClient = new RpcReader();
  const fromChild = new RpcReader();
  const listIds = new Set();
  const navigateIds = new Set();
  let clientFraming = "ndjson";
  let sendChain = Promise.resolve();

  const enqueueSend = (fn) => {
    sendChain = sendChain.then(fn).catch(() => undefined);
  };

  const writeOut = (obj, framing) => {
    stdout.write(encode(obj, framing));
  };

  stdin.on("data", (chunk) => {
    let messages;
    try {
      messages = fromClient.push(chunk);
    } catch {
      return;
    }
    for (const { obj, framing } of messages) {
      clientFraming = framing;
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
        if (shouldBringTabFront(name)) {
          if (obj.id !== undefined && obj.id !== null && normalizePinchTabToolName(name) === "navigate") {
            navigateIds.add(obj.id);
          }
          enqueueSend(async () => {
            const args = await prepareBrowseCall(name, toolArguments(obj.params), server, token);
            const next = { ...obj, params: { ...obj.params, arguments: args } };
            if (child.stdin) child.stdin.write(encode(next, framing));
          });
          continue;
        }
      }
      if (obj.method === "tools/list" && obj.id !== undefined && obj.id !== null) {
        listIds.add(obj.id);
      }
      if (child.stdin) child.stdin.write(encode(obj, framing));
    }
  });

  child.stdout?.on("data", (chunk) => {
    let messages;
    try {
      messages = fromChild.push(chunk);
    } catch {
      stdout.write(chunk);
      return;
    }
    for (const { obj, framing } of messages) {
      if (obj.id !== undefined && obj.id !== null && listIds.has(obj.id) && obj.result !== undefined) {
        listIds.delete(obj.id);
        writeOut({ ...obj, result: filterListResult(obj.result) }, framing);
        continue;
      }
      if (obj.id !== undefined && obj.id !== null && navigateIds.has(obj.id) && obj.result !== undefined) {
        navigateIds.delete(obj.id);
        enqueueSend(async () => {
          const tabId = tabIdFromToolResult(obj.result);
          if (tabId) await focusPinchTab(server, token, tabId);
          writeOut(obj, framing);
        });
        continue;
      }
      writeOut(obj, framing);
    }
  });

  stdin.on("end", () => {
    child.stdin?.end();
  });

  return new Promise((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (err) => {
      console.error(err.message);
      writeOut(
        { jsonrpc: "2.0", id: null, error: { code: -32000, message: "PinchTab MCP failed to start" } },
        clientFraming,
      );
      resolve(1);
    });
  });
}

const isMain = process.argv.some((arg) => /pinchtab-mcp\.(mjs|js|ts)$/.test(arg));
if (isMain) {
  process.exit(await runPinchTabAllowlistProxy());
}
