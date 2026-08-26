import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ComputerRuntime } from "./computer.ts";

export const PINCHTAB_MCP_NAME = "pinchtab";

/** Browse loop first, screenshot last. Match `navigate` and `pinchtab_navigate`. */
export const PINCHTAB_ALLOWLIST = [
  "navigate",
  "snapshot",
  "get_text",
  "click",
  "type",
  "fill",
  "select",
  "key",
  "scroll",
  "wait",
  "list_tabs",
  "back",
  "screenshot",
] as const;

export type PinchTabAllowName = (typeof PINCHTAB_ALLOWLIST)[number];

const BLOCKED_HINTS = [
  "cookies",
  "eval",
  "scrape",
  "pdf",
  "capture",
  "record",
  "network_route",
  "network-route",
] as const;

export type AcpMcpEnvVar = { name: string; value: string };

export type AcpMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: AcpMcpEnvVar[];
};

function normalizeToolName(name: string): string {
  return name.trim().replace(/^pinchtab_/i, "").toLowerCase().replace(/-/g, "_");
}

function isKeyTool(n: string): boolean {
  return n === "key" || n === "press" || n.startsWith("key") || n.startsWith("keyboard");
}

export function pinchTabToolAllowed(name: string): boolean {
  const n = normalizeToolName(name);
  if (!n) return false;
  if (BLOCKED_HINTS.some((hint) => n === hint.replace(/-/g, "_") || n.startsWith(`${hint.replace(/-/g, "_")}_`))) {
    return false;
  }
  for (const allowed of PINCHTAB_ALLOWLIST) {
    if (n === allowed) return true;
    if (allowed !== "screenshot" && n.startsWith(`${allowed}_`)) return true;
  }
  if (isKeyTool(n)) return true;
  return false;
}

export function filterAllowlistedTools<T extends { name?: string }>(tools: T[]): T[] {
  const allowed = tools.filter((tool) => pinchTabToolAllowed(String(tool.name ?? "")));
  const rest: T[] = [];
  const shots: T[] = [];
  for (const tool of allowed) {
    if (normalizeToolName(String(tool.name ?? "")) === "screenshot" || /screenshot/i.test(String(tool.name ?? ""))) {
      shots.push(tool);
    } else {
      rest.push(tool);
    }
  }
  return [...rest, ...shots];
}

export function stripPinchTabFromPath(pathEnv: string): string {
  return pathEnv
    .split(path.delimiter)
    .filter((dir) => {
      if (!dir) return false;
      try {
        fs.accessSync(path.join(dir, "pinchtab"), fs.constants.X_OK);
        return false;
      } catch {
        return true;
      }
    })
    .join(path.delimiter);
}

export function pathHasPinchTab(pathEnv: string): boolean {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, "pinchtab"), fs.constants.X_OK);
      return true;
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
    if (!dir) continue;
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

/** Absolute host pinchtab. Never the Harness PATH after strip. */
export function resolvePinchTabBin(pathEnv = process.env.PATH ?? ""): string | null {
  const override = process.env.OPENBOT_PINCHTAB;
  if (override) return resolveExecutable(override, pathEnv);
  return resolveExecutable("pinchtab", pathWithLocalBin(pathEnv));
}

export function pinchTabMcpScript(): string {
  return fileURLToPath(new URL("./pinchtab-mcp.ts", import.meta.url));
}

function resolveTsx(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const local = path.resolve(here, "../../node_modules/.bin/tsx");
  try {
    fs.accessSync(local, fs.constants.X_OK);
    return local;
  } catch {
    return resolveExecutable("tsx", pathWithLocalBin(process.env.PATH ?? ""));
  }
}

export function pinchTabWrapperCommand(): { command: string; args: string[] } | null {
  const tsx = resolveTsx();
  const script = pinchTabMcpScript();
  if (!tsx) return null;
  try {
    fs.accessSync(script, fs.constants.R_OK);
  } catch {
    return null;
  }
  return { command: tsx, args: [script] };
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
    instanceDefaults: { mode: "headed" },
    security: {
      allowEvaluate: false,
      allowCookies: false,
      allowedDomains: ["*"],
      attach: {
        enabled: true,
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

export async function pinchTabMcpServers(
  computer: ComputerRuntime,
  botId: string,
): Promise<AcpMcpServer[]> {
  const bridge = computer.pinchTab(botId);
  if (!bridge) return [];
  const bin = resolvePinchTabBin();
  if (!bin) return [];
  const wrapper = pinchTabWrapperCommand();
  if (!wrapper) return [];
  let ok = false;
  for (let i = 0; i < 5; i += 1) {
    ok = await pinchTabHealthy(bridge.url, bridge.token);
    if (ok) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (!ok) return [];
  return [
    {
      name: PINCHTAB_MCP_NAME,
      command: wrapper.command,
      args: pinchTabWrapperArgs(bin, bridge.url, bridge.token),
      env: [
        { name: "OPENBOT_PINCHTAB", value: bin },
        { name: "OPENBOT_PINCHTAB_SERVER", value: bridge.url },
        { name: "PINCHTAB_TOKEN", value: bridge.token },
      ],
    },
  ];
}
