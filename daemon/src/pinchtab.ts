import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ComputerRuntime } from "./computer.ts";
import {
  PINCHTAB_ALLOWLIST as ALLOWLIST_JS,
  filterAllowlistedTools as filterJs,
  pinchTabToolAllowed as allowedJs,
} from "./pinchtab-allowlist.mjs";

export const PINCHTAB_MCP_NAME = "pinchtab";
export const PINCHTAB_ALLOWLIST = ALLOWLIST_JS as readonly string[];
export type PinchTabAllowName = (typeof PINCHTAB_ALLOWLIST)[number];

export function pinchTabToolAllowed(name: string): boolean {
  return allowedJs(name);
}

export function filterAllowlistedTools<T extends { name?: string }>(tools: T[]): T[] {
  return filterJs(tools) as T[];
}

export type AcpMcpEnvVar = { name: string; value: string };

export type AcpMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: AcpMcpEnvVar[];
  _meta?: Record<string, unknown>;
};

/** Codex stdio MCP inherits these from the ACP child. Repeat them so the wrapper can spawn host pinchtab. */
const MCP_INHERIT_ENV = [
  "HOME",
  "LOGNAME",
  "PATH",
  "SHELL",
  "USER",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "TZ",
] as const;

function mcpInheritEnv(from: NodeJS.ProcessEnv): AcpMcpEnvVar[] {
  const out: AcpMcpEnvVar[] = [];
  for (const name of MCP_INHERIT_ENV) {
    const value = from[name];
    if (value) out.push({ name, value });
  }
  return out;
}

const SHIM_MARKER = "openbot-pinchtab-deny";

export function pinchTabDenyShimDir(): string {
  const dir = path.join(os.tmpdir(), SHIM_MARKER);
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, "pinchtab");
  const body = `#!/bin/sh\necho "OpenBot: pinchtab is not available on Isolated PATH. Use PinchTab MCP." >&2\nexit 127\n`;
  try {
    if (!fs.existsSync(shim) || fs.readFileSync(shim, "utf8") !== body) {
      fs.writeFileSync(shim, body, { encoding: "utf8", mode: 0o755 });
    }
    fs.chmodSync(shim, 0o755);
  } catch {
    /* best effort */
  }
  return dir;
}

/** Prepend a fail-closed pinchtab shim. Do not drop PATH dirs (docker/git/gh stay). */
export function stripPinchTabFromPath(pathEnv: string): string {
  const shim = pinchTabDenyShimDir();
  const parts = pathEnv.split(path.delimiter).filter((dir) => dir && dir !== shim);
  return [shim, ...parts].join(path.delimiter);
}

export function pathHasPinchTab(pathEnv: string): boolean {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, "pinchtab"), fs.constants.X_OK);
      return !dir.includes(SHIM_MARKER);
    } catch {
      continue;
    }
  }
  return false;
}

function pathWithLocalBin(pathEnv: string): string {
  const home = process.env.HOME;
  if (!home) return pathEnv;
  const extra = path.join(home, ".local", "bin");
  const parts = pathEnv.split(path.delimiter);
  if (parts.includes(extra)) return pathEnv;
  return extra + path.delimiter + pathEnv;
}

function resolveExecutable(bin: string, pathEnv: string): string | null {
  if (!bin) return null;
  if (bin.includes("/") || bin.includes("\\")) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch {
      return null;
    }
  }
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir || dir.includes(SHIM_MARKER)) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** Absolute host pinchtab. Never the Harness PATH shim. */
export function resolvePinchTabBin(pathEnv = process.env.PATH ?? ""): string | null {
  const override = process.env.OPENBOT_PINCHTAB;
  if (override) return resolveExecutable(override, pathEnv);
  return resolveExecutable("pinchtab", pathWithLocalBin(pathEnv));
}

export function pinchTabMcpScript(): string {
  return fileURLToPath(new URL("./pinchtab-mcp.mjs", import.meta.url));
}

export function pinchTabWrapperCommand(): { command: string; args: string[] } | null {
  const script = pinchTabMcpScript();
  try {
    fs.accessSync(process.execPath, fs.constants.X_OK);
    fs.accessSync(script, fs.constants.R_OK);
  } catch {
    return null;
  }
  return { command: process.execPath, args: [script] };
}

export function pinchTabWrapperArgs(bin: string, server: string, token: string): string[] {
  const wrapper = pinchTabWrapperCommand();
  return [...(wrapper?.args ?? [pinchTabMcpScript()]), "--bin", bin, "--server", server, "--token", token];
}

export function pinchTabBridgeConfig(token: string, port: number): Record<string, unknown> {
  return {
    server: {
      port: String(port),
      bind: "0.0.0.0",
      token,
    },
    browsers: { default: "chrome" },
    instanceDefaults: { mode: "headed", captureAllowActivation: true },
    security: {
      allowEvaluate: false,
      allowCookies: false,
      allowedDomains: ["*"],
      attach: {
        enabled: false,
        allowHosts: ["127.0.0.1", "localhost", "::1"],
        allowSchemes: ["ws", "wss", "http", "https"],
      },
      idpi: {
        enabled: true,
        scanContent: true,
        wrapContent: true,
      },
    },
    autoSolver: { enabled: false },
  };
}

function probe(url: string, pathname: string, token: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let dest: URL;
    try {
      dest = new URL(pathname, url.endsWith("/") ? url : `${url}/`);
    } catch {
      resolve(null);
      return;
    }
    const req = http.request(
      dest,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          connection: "close",
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? null);
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

export async function pinchTabHealthy(url: string, token: string, timeoutMs = 1500): Promise<boolean> {
  if (!url || !token) return false;
  const health = await probe(url, "/health", token, timeoutMs);
  if (health !== null && health >= 200 && health < 300) return true;
  const tabs = await probe(url, "/tabs", token, timeoutMs);
  return tabs !== null && tabs >= 200 && tabs < 300;
}

export async function waitForPinchTabBridge(
  url: string,
  token: string,
  timeoutMs = 60_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pinchTabHealthy(url, token, 800)) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return pinchTabHealthy(url, token, 800);
}

export async function pinchTabMcpServers(
  computer: ComputerRuntime,
  botId: string,
  inheritEnv: NodeJS.ProcessEnv = process.env,
): Promise<AcpMcpServer[]> {
  const bridge = computer.pinchTab(botId);
  if (!bridge) return [];
  const bin = resolvePinchTabBin();
  if (!bin) return [];
  const wrapper = pinchTabWrapperCommand();
  if (!wrapper) return [];
  const display = computer.display(botId)?.display ?? 1;
  const waitMs = display > 1 ? 60_000 : 3_000;
  const ok = await waitForPinchTabBridge(bridge.url, bridge.token, waitMs);
  if (!ok) return [];
  return [
    {
      name: PINCHTAB_MCP_NAME,
      command: wrapper.command,
      args: pinchTabWrapperArgs(bin, bridge.url, bridge.token),
      env: [
        ...mcpInheritEnv(inheritEnv),
        { name: "OPENBOT_PINCHTAB", value: bin },
        { name: "OPENBOT_PINCHTAB_SERVER", value: bridge.url },
        { name: "PINCHTAB_TOKEN", value: bridge.token },
      ],
      // ACP stdio MCP is name/command/args/env. Extra keys can drop the server.
      _meta: { startup_timeout_sec: 30, required: true },
    },
  ];
}
