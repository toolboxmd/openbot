import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HARNESS_IDS, type HarnessId } from "./harness.ts";

export const CONFIG_MODES = ["isolated", "host"] as const;
export type ConfigMode = (typeof CONFIG_MODES)[number];

export const HOST_GRANT_ACCESS = ["read", "read-write", "deny"] as const;
export type HostGrantAccess = (typeof HOST_GRANT_ACCESS)[number];

export const HOST_GRANT_DURATIONS = ["once", "session", "until-revoked"] as const;
export type HostGrantDuration = (typeof HOST_GRANT_DURATIONS)[number];

export const VENDOR_HOME_ENV: Record<HarnessId, string> = {
  codex: "CODEX_HOME",
  claude: "CLAUDE_CONFIG_DIR",
  grok: "GROK_HOME",
  kimi: "KIMI_CODE_HOME",
};

const HOST_AUTH_FILES: Record<HarnessId, string[]> = {
  codex: [path.join(os.homedir(), ".codex", "auth.json")],
  claude: [
    path.join(os.homedir(), ".claude", ".credentials.json"),
    path.join(os.homedir(), ".claude.json"),
  ],
  grok: [
    path.join(os.homedir(), ".grok", "auth.json"),
    path.join(os.homedir(), ".config", "grok", "auth.json"),
  ],
  kimi: [
    path.join(os.homedir(), ".kimi", "auth.json"),
    path.join(os.homedir(), ".kimi-code", "auth.json"),
  ],
};

export const OPENBOT_MD = `# OpenBot

You are a named Bot on this Computer. Chat like a person in iMessage: several short bubbles, one or two sentences each. No markdown essays. No headings. No numbered dumps. No tool JSON or transcripts in chat.

Workspace is the jail. You may read and write the shared drop and every Bot directory without asking. Paths on the host PC outside Workspace need a Host grant.

This file is product-locked Isolated user-level instructions. Users do not edit it. They edit All Bots (\`AGENTS.md\` at the Workspace root) and This Bot (\`AGENTS.md\` in your cwd).
`;

export const ALL_BOTS_AGENTS_MD = `# All Bots

Rules for every Bot on this Computer.
`;

export const THIS_BOT_AGENTS_MD = `# This Bot

Rules for this Bot only.
`;

export function isConfigMode(value: unknown): value is ConfigMode {
  return value === "isolated" || value === "host";
}

export function isHostGrantAccess(value: unknown): value is HostGrantAccess {
  return value === "read" || value === "read-write" || value === "deny";
}

export function isHostGrantDuration(value: unknown): value is HostGrantDuration {
  return value === "once" || value === "session" || value === "until-revoked";
}

export function harnessRoot(homeDir: string): string {
  return path.join(path.resolve(homeDir), "harness");
}

export function sharedDir(homeDir: string): string {
  return path.join(harnessRoot(homeDir), "shared");
}

export function vendorDir(homeDir: string, id: HarnessId): string {
  return path.join(harnessRoot(homeDir), id);
}

export function botWorkspaceDir(workspaceDir: string, botId: string): string {
  return path.join(path.resolve(workspaceDir), "bots", botId);
}

export function allBotsAgentsPath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), "AGENTS.md");
}

export function thisBotAgentsPath(workspaceDir: string, botId: string): string {
  return path.join(botWorkspaceDir(workspaceDir, botId), "AGENTS.md");
}

export function applyVendorHomeEnv(
  env: NodeJS.ProcessEnv,
  mode: ConfigMode,
  homeDir: string,
  botHome?: string,
): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const id of HARNESS_IDS) {
    const key = VENDOR_HOME_ENV[id];
    if (mode === "isolated") next[key] = vendorDir(homeDir, id);
    else delete next[key];
  }
  if (mode === "isolated" && botHome) next.HOME = path.resolve(botHome);
  return next;
}

export function isInsideWorkspace(target: string, workspaceDir: string): boolean {
  const resolved = path.resolve(target);
  const root = path.resolve(workspaceDir);
  return resolved === root || resolved.startsWith(root + path.sep);
}

export function pathCoveredByGrant(requestPath: string, grantPath: string): boolean {
  const request = path.resolve(requestPath);
  const grant = path.resolve(grantPath);
  return request === grant || request.startsWith(grant + path.sep) || grant.startsWith(request + path.sep);
}

export function requestedAccessFromKind(kind: string | undefined): HostGrantAccess {
  const value = (kind ?? "").toLowerCase();
  if (value === "read" || value === "search" || value === "lookup") return "read";
  return "read-write";
}

export function extractPermissionPath(
  input: {
    title?: string;
    description?: string;
    locations?: Array<{ path?: string }>;
    rawInput?: Record<string, unknown> | null;
    meta?: unknown;
  },
  cwd: string,
): string | null {
  for (const loc of input.locations ?? []) {
    if (typeof loc.path === "string" && loc.path.trim()) {
      return resolveMaybeRelative(loc.path.trim(), cwd);
    }
  }
  const raw = input.rawInput;
  if (raw && typeof raw === "object") {
    for (const key of ["filepath", "filePath", "path", "target", "destination", "dir", "parentDir"]) {
      const value = raw[key];
      if (typeof value === "string" && value.trim()) {
        return resolveMaybeRelative(value.trim(), cwd);
      }
    }
    const command = raw.command;
    if (typeof command === "string") {
      const fromCommand = firstAbsolutePath(command);
      if (fromCommand) return fromCommand;
    }
  }
  const blob = `${input.title ?? ""}\n${input.description ?? ""}\n${safeJson(input.meta)}`;
  const fromText = firstAbsolutePath(blob);
  if (fromText) return fromText;
  return null;
}

function resolveMaybeRelative(value: string, cwd: string): string {
  if (value.startsWith("/")) return path.resolve(value);
  return path.resolve(cwd, value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return "";
  }
}

const SYSTEM_PATH_PREFIXES = ["/bin/", "/usr/", "/sbin/", "/lib/", "/lib64/", "/dev/", "/proc/", "/etc/"];

function firstAbsolutePath(text: string): string | null {
  const found: string[] = [];
  const pattern = /(?:^|[\s"'`=<>])(\/(?:[^\s"'`;|&<>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) found.push(match[1]);
  const preferred = found.find(
    (candidate) => !SYSTEM_PATH_PREFIXES.some((prefix) => candidate === prefix.slice(0, -1) || candidate.startsWith(prefix)),
  );
  return preferred ?? found[0] ?? null;
}

export function pickAllowOption(
  options: Array<{ optionId: string; kind?: string }>,
): string | null {
  const allowOnce = options.find(
    (option) => option.kind === "allow_once" || option.optionId === "allow-once" || option.optionId === "once",
  );
  if (allowOnce) return allowOnce.optionId;
  const allow = options.find(
    (option) =>
      (option.kind && option.kind.startsWith("allow")) ||
      option.optionId.startsWith("allow") ||
      option.optionId === "always",
  );
  return allow?.optionId ?? null;
}

export function pickRejectOption(
  options: Array<{ optionId: string; kind?: string }>,
): string | null {
  const reject = options.find(
    (option) =>
      option.kind === "reject_once" ||
      option.kind === "reject" ||
      option.optionId === "reject-once" ||
      option.optionId === "reject" ||
      option.optionId === "deny",
  );
  return reject?.optionId ?? options.find((option) => /reject|deny|cancel/i.test(option.optionId))?.optionId ?? null;
}

export function ensureWorkspaceLayout(workspaceDir: string): void {
  const root = path.resolve(workspaceDir);
  fs.mkdirSync(path.join(root, "bots"), { recursive: true });
  writeIfMissing(allBotsAgentsPath(root), ALL_BOTS_AGENTS_MD);
  ensureFileSymlink(path.join(root, "CLAUDE.md"), "AGENTS.md");
  ensureGitRoot(root);
}

export function ensureBotWorkspace(workspaceDir: string, botId: string): string {
  const dir = botWorkspaceDir(workspaceDir, botId);
  fs.mkdirSync(dir, { recursive: true });
  writeIfMissing(thisBotAgentsPath(workspaceDir, botId), THIS_BOT_AGENTS_MD);
  ensureFileSymlink(path.join(dir, "CLAUDE.md"), "AGENTS.md");
  return dir;
}

export function ensureHarnessHome(homeDir: string, workspaceDir: string): void {
  const home = path.resolve(homeDir);
  const workspace = path.resolve(workspaceDir);
  const shared = sharedDir(home);
  fs.mkdirSync(path.join(shared, "skills"), { recursive: true });
  fs.mkdirSync(path.join(shared, "plugins"), { recursive: true });
  fs.mkdirSync(path.join(shared, "hooks"), { recursive: true });
  writeIfMissing(path.join(shared, "OPENBOT.md"), OPENBOT_MD);
  ensureWorkspaceLayout(workspace);

  for (const id of HARNESS_IDS) {
    const dir = vendorDir(home, id);
    fs.mkdirSync(dir, { recursive: true });
    ensureRelativeSymlink(path.join(dir, "skills"), path.join("..", "shared", "skills"));
    ensureRelativeSymlink(path.join(dir, "plugins"), path.join("..", "shared", "plugins"));
    ensureRelativeSymlink(path.join(dir, "hooks"), path.join("..", "shared", "hooks"));
    const instructionName = id === "claude" ? "CLAUDE.md" : "AGENTS.md";
    ensureRelativeSymlink(path.join(dir, instructionName), path.join("..", "shared", "OPENBOT.md"));
    if (id === "claude") {
      writeIfMissing(path.join(dir, "settings.json"), "{}\n");
    } else {
      writeIsolatedConfig(path.join(dir, "config.toml"), workspace);
    }
    linkHostAuth(dir, id);
  }
}

export function readAgentsFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export function writeAgentsFile(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, { encoding: "utf8", mode: 0o644 });
}

function writeIsolatedConfig(configPath: string, workspaceDir: string): void {
  if (fs.existsSync(configPath)) return;
  const body = `# OpenBot Isolated Harness Home. Native Isolated config for this Computer.
# Do not put OPENBOT_HOME under /tmp: Codex refuses helper binaries there and the jail will not hold.
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
writable_roots = [${tomlString(workspaceDir)}]
exclude_slash_tmp = true
exclude_tmpdir_env_var = true
network_access = false
`;
  fs.writeFileSync(configPath, body, { encoding: "utf8", mode: 0o644 });
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function writeIfMissing(filePath: string, body: string): void {
  if (fs.existsSync(filePath)) return;
  fs.writeFileSync(filePath, body, { encoding: "utf8", mode: 0o644 });
}

function ensureGitRoot(workspaceDir: string): void {
  if (fs.existsSync(path.join(workspaceDir, ".git"))) return;
  spawnSync("git", ["init"], { cwd: workspaceDir, stdio: "ignore" });
}

function ensureFileSymlink(linkPath: string, target: string): void {
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      if (fs.readlinkSync(linkPath) === target) return;
      fs.unlinkSync(linkPath);
    } else {
      return;
    }
  } catch {
    // missing
  }
  fs.symlinkSync(target, linkPath);
}

function ensureRelativeSymlink(linkPath: string, target: string): void {
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      if (fs.readlinkSync(linkPath) === target) return;
      fs.unlinkSync(linkPath);
    } else {
      return;
    }
  } catch {
    // missing
  }
  fs.symlinkSync(target, linkPath);
}

function linkHostAuth(vendorHome: string, id: HarnessId): void {
  const hostFile = HOST_AUTH_FILES[id].find((candidate) => fs.existsSync(candidate));
  if (!hostFile) return;
  const linkName = path.basename(hostFile);
  const linkPath = path.join(vendorHome, linkName);
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      if (fs.readlinkSync(linkPath) === hostFile) return;
      fs.unlinkSync(linkPath);
    } else {
      return;
    }
  } catch {
    // missing
  }
  fs.symlinkSync(hostFile, linkPath);
}
