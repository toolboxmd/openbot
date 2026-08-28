import fs from "node:fs";
import path from "node:path";
import { applyVendorHomeEnv } from "./harness-home.ts";
import { stripPinchTabFromPath, type AcpMcpServer } from "./pinchtab.ts";

export const HARNESS_IDS = ["codex", "claude", "grok", "kimi"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export type HarnessInfo = {
  id: HarnessId;
  name: string;
  bin: string;
  talk: boolean;
};

export type SpawnSpec = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  mcpServers?: AcpMcpServer[];
};

const CATALOG: HarnessInfo[] = [
  { id: "codex", name: "Codex", bin: "codex", talk: true },
  { id: "claude", name: "Claude Code", bin: "claude", talk: false },
  { id: "grok", name: "Grok Build", bin: "grok", talk: false },
  { id: "kimi", name: "Kimi Code", bin: "kimi", talk: false },
];

function pathWithLocalBin(pathEnv = process.env.PATH ?? ""): string {
  const home = process.env.HOME;
  if (!home) return pathEnv;
  const extra = path.join(home, ".local", "bin");
  const parts = pathEnv.split(path.delimiter);
  if (parts.includes(extra)) return pathEnv;
  return extra + path.delimiter + pathEnv;
}

export function resolveBin(bin: string, pathEnv = process.env.PATH ?? ""): string | null {
  pathEnv = pathWithLocalBin(pathEnv);
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

export function onPath(bin: string): boolean {
  return resolveBin(bin) !== null;
}

export function listHarnessesOnPath(): HarnessInfo[] {
  return CATALOG.filter((item) => onPath(item.bin));
}

export function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value);
}

/**
 * Official Codex ACP adapter over stdio.
 * `codex` itself has no `acp` subcommand (help lists app-server / mcp-server).
 * The adapter is https://github.com/agentclientprotocol/codex-acp and wraps
 * the host `codex` via CODEX_PATH. Do not use Grok websocket agent serve.
 */
export type SpawnMode = "isolated" | "host";

export type SpawnSpecOptions = {
  mode?: SpawnMode;
  homeDir?: string;
  cwd?: string;
  botId?: string;
  screenContainer?: string;
};

export function spawnSpec(id: HarnessId, opts: SpawnSpecOptions = {}): SpawnSpec {
  if (id !== "codex") {
    throw new Error("Talk spawn is Codex-only in this slice");
  }
  let env: NodeJS.ProcessEnv = { ...process.env };
  env.PATH = stripPinchTabFromPath(pathWithLocalBin(env.PATH ?? ""));
  delete env.DISPLAY;
  delete env.PINCHTAB_TOKEN;
  delete env.OPENBOT_PINCHTAB;
  delete env.OPENBOT_PINCHTAB_SERVER;
  if (opts.homeDir) {
    const mode = opts.mode ?? "isolated";
    env = applyVendorHomeEnv(env, mode, opts.homeDir, opts.cwd, {
      botId: opts.botId,
      screenContainer: opts.screenContainer,
    });
  }
  const codex = resolveBin("codex");
  if (!codex) {
    throw new Error("codex is not on PATH");
  }
  env.CODEX_PATH = codex;
  env.NO_BROWSER = "1";
  const adapter = resolveBin("codex-acp");
  if (adapter) return { command: adapter, args: [], env };
  return { command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"], env };
}

export function loginHint(id: HarnessId): string {
  if (id === "codex") {
    return "Codex is not signed in on this host. Run `codex login` in a terminal (device code). Takeover is not for CLI login.";
  }
  return `${id} is detected on PATH, but Talk spawn in this slice is Codex only.`;
}
