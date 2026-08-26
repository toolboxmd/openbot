import { spawn } from "node:child_process";
import { filterAllowlistedTools, pinchTabToolAllowed } from "./pinchtab.ts";

type JsonRpc = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type Framing = "ndjson" | "lsp";

class RpcReader {
  private buf = Buffer.alloc(0);
  private mode: "unknown" | Framing = "unknown";

  push(chunk: Buffer): Array<{ obj: JsonRpc; framing: Framing }> {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: Array<{ obj: JsonRpc; framing: Framing }> = [];
    while (true) {
      const next = this.pull();
      if (!next) break;
      out.push(next);
    }
    return out;
  }

  private pull(): { obj: JsonRpc; framing: Framing } | null {
    if (this.buf.length === 0) return null;
    if (this.mode === "unknown") {
      let i = 0;
      while (i < this.buf.length && (this.buf[i] === 0x20 || this.buf[i] === 0x0d || this.buf[i] === 0x0a || this.buf[i] === 0x09)) {
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
      return { obj: JSON.parse(line) as JsonRpc, framing: "ndjson" };
    }
    const headerEnd = indexOf(this.buf, "\r\n\r\n");
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
    return { obj: JSON.parse(body) as JsonRpc, framing: "lsp" };
  }
}

function indexOf(buf: Buffer, needle: string): number {
  const n = Buffer.from(needle);
  return buf.indexOf(n);
}

function encode(obj: unknown, framing: Framing): Buffer {
  const body = Buffer.from(`${JSON.stringify(obj)}`, "utf8");
  if (framing === "lsp") {
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  }
  return Buffer.concat([body, Buffer.from("\n")]);
}

function toolNameFromCall(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

function filterListResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return result;
  return { ...(result as object), tools: filterAllowlistedTools(tools as Array<{ name?: string }>) };
}

function argvValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return undefined;
  const value = process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

export function runPinchTabAllowlistProxy(
  stdin: NodeJS.ReadableStream = process.stdin,
  stdout: NodeJS.WritableStream = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
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
  const listIds = new Set<number | string>();
  let clientFraming: Framing = "ndjson";

  const writeOut = (obj: unknown, framing: Framing) => {
    stdout.write(encode(obj, framing));
  };

  stdin.on("data", (chunk: Buffer) => {
    let messages: Array<{ obj: JsonRpc; framing: Framing }>;
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
      }
      if (obj.method === "tools/list" && obj.id !== undefined && obj.id !== null) {
        listIds.add(obj.id);
      }
      if (child.stdin) child.stdin.write(encode(obj, framing));
    }
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    let messages: Array<{ obj: JsonRpc; framing: Framing }>;
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

const isMain = process.argv.some((arg) => /pinchtab-mcp\.(ts|js)$/.test(arg));

if (isMain) {
  const code = await runPinchTabAllowlistProxy();
  process.exit(code);
}
