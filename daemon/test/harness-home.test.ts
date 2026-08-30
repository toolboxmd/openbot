import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import type { AcpHandlers, PermissionPrompt } from "../src/acp.ts";
import { BotStore, type AcpSession } from "../src/bots.ts";
import { startBox } from "../src/box.ts";
import {
  applyVendorHomeEnv,
  ensureBotWorkspace,
  ensureHarnessHome,
  extractPermissionPath,
  isInsideScreenWorkspace,
  isInsideWorkspace,
  pickAllowOption,
  pickRejectOption,
  vendorDir,
} from "../src/harness-home.ts";
import type { SpawnSpec } from "../src/harness.ts";
import { HOME_SCHEMA_VERSION, HomeStore } from "../src/home.ts";

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "openbot-hh-"));
}

function iso(offsetMs = 0): string {
  return new Date(Date.parse("2026-01-01T00:00:00.000Z") + offsetMs).toISOString();
}

async function waitUntil(ok: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (ok()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for condition");
}

function cookieHeader(res: Response): string {
  return res.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

type Spawned = { spec: SpawnSpec; cwd: string; sessionCwd: string[] };

function recordingFake() {
  const spawned: Spawned[] = [];
  const answered: string[] = [];
  let handlers: AcpHandlers | undefined;
  let nextId = 1;
  const spawnAcp = (spec: SpawnSpec, cwd: string, next?: AcpHandlers): AcpSession => {
    const row: Spawned = { spec, cwd, sessionCwd: [] };
    spawned.push(row);
    handlers = next;
    return {
      close() {},
      async initialize() {
        return {};
      },
      async newSession(sessionCwd: string) {
        row.sessionCwd.push(sessionCwd);
        const id = `s${nextId}`;
        nextId += 1;
        return id;
      },
      async prompt() {
        return "ok";
      },
      cancel() {},
      respondPermission(_rpcId, optionId) {
        answered.push(optionId);
      },
    };
  };
  return {
    spawnAcp,
    spawned,
    answered,
    fire(prompt: PermissionPrompt) {
      handlers?.onPermission?.(prompt);
    },
  };
}

const allowDenyOptions = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

test("Host permission selectors honor kinds, prefer one-time choices, and fail closed for unknown kinds", () => {
  const conflicting = [
    { optionId: "allow-once", name: "Reject", kind: "reject_once" },
    { optionId: "provider-allow", name: "Allow", kind: "allow_once" },
  ];
  assert.equal(pickAllowOption(conflicting), "provider-allow");
  assert.equal(pickRejectOption(conflicting), "allow-once");
  assert.equal(
    pickAllowOption([{ optionId: "allow-once", kind: "provider_allow" }]),
    null,
  );
  assert.equal(
    pickRejectOption([{ optionId: "reject-once", kind: "provider_reject" }]),
    null,
  );
  assert.equal(
    pickAllowOption([{ optionId: "provider-always", kind: "allow_always" }]),
    "provider-always",
  );
  assert.equal(
    pickRejectOption([{ optionId: "provider-never", kind: "reject_always" }]),
    "provider-never",
  );
  assert.equal(pickAllowOption([
    { optionId: "provider-always", kind: "allow_always" },
    { optionId: "provider-once", kind: "allow_once" },
  ]), "provider-once");
  assert.equal(pickRejectOption([
    { optionId: "provider-never", kind: "reject_always" },
    { optionId: "provider-reject-once", kind: "reject_once" },
  ]), "provider-reject-once");
  assert.equal(pickAllowOption([{ optionId: "allow-once" }]), "allow-once");
  assert.equal(pickRejectOption([{ optionId: "reject-once" }]), "reject-once");
});

describe("Isolated Harness Home layout", () => {
  test("bootstrap fails clearly when git initialization fails", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace");
    const previousPath = process.env.PATH;
    process.env.PATH = join(homeDir, "missing-bin");
    try {
      assert.throws(
        () => ensureHarnessHome(homeDir, workspace),
        /git initialization failed/i,
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    assert.equal(existsSync(join(workspace, ".git")), false);
  });

  test("bootstrap checks a real nonzero git subprocess status", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace");
    const binDir = join(homeDir, "fixture-bin");
    const gitPath = join(binDir, "git");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(gitPath, "#!/bin/sh\nprintf 'fixture git failure' >&2\nexit 23\n");
    chmodSync(gitPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      assert.throws(
        () => ensureHarnessHome(homeDir, workspace),
        /Git initialization failed.*fixture git failure/i,
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    assert.equal(existsSync(join(workspace, ".git")), false);
  });

  test("bootstrap rejects stale Git metadata without overwriting it", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace");
    const gitPath = join(workspace, ".git");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(gitPath, "stale\n");

    assert.throws(
      () => ensureHarnessHome(homeDir, workspace),
      /Git repository validation failed.*invalid gitfile format/i,
    );
    assert.equal(readFileSync(gitPath, "utf8"), "stale\n");
  });

  test("bootstrap rejects Git metadata rooted outside the Workspace", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace");
    const otherWorktree = join(homeDir, "other-worktree");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(otherWorktree, { recursive: true });
    const initialized = spawnSync("git", ["init"], { cwd: workspace, encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);
    const configured = spawnSync("git", ["config", "core.worktree", otherWorktree], {
      cwd: workspace,
      encoding: "utf8",
    });
    assert.equal(configured.status, 0, configured.stderr);
    const configPath = join(workspace, ".git", "config");
    const original = readFileSync(configPath, "utf8");

    assert.throws(
      () => ensureHarnessHome(homeDir, workspace),
      /Git repository validation failed.*repository root.*does not match/i,
    );
    assert.equal(readFileSync(configPath, "utf8"), original);
  });

  test("bootstrap accepts a Workspace Git root ending in a space", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace ");

    assert.doesNotThrow(() => ensureHarnessHome(homeDir, workspace));
    assert.equal(existsSync(join(workspace, ".git")), true);
  });

  test("bootstrap accepts a Workspace Git root ending in a newline", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace\n");

    assert.doesNotThrow(() => ensureHarnessHome(homeDir, workspace));
    assert.equal(existsSync(join(workspace, ".git")), true);
  });

  test("shared OPENBOT.md, vendor dirs, auth symlink, Grok has AGENTS.md only", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace");
    mkdirSync(join(homedir(), ".codex"), { recursive: true });
    ensureHarnessHome(homeDir, workspace);

    assert.equal(existsSync(join(homeDir, "harness", "shared", "OPENBOT.md")), true);
    assert.equal(existsSync(join(homeDir, "harness", "shared", "skills")), true);
    assert.equal(existsSync(join(homeDir, "harness", "shared", "plugins")), true);
    assert.equal(existsSync(join(homeDir, "harness", "shared", "hooks")), true);
    assert.equal(existsSync(join(workspace, "AGENTS.md")), true);
    assert.equal(lstatSync(join(workspace, "CLAUDE.md")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(workspace, "CLAUDE.md")), "AGENTS.md");

    const codex = vendorDir(homeDir, "codex");
    assert.equal(existsSync(join(codex, "config.toml")), true);
    assert.equal(lstatSync(join(codex, "AGENTS.md")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(codex, "AGENTS.md")), join("..", "shared", "OPENBOT.md"));
    assert.equal(existsSync(join(codex, "CLAUDE.md")), false);
    assert.equal(lstatSync(join(codex, "skills")).isSymbolicLink(), true);
    assert.equal(existsSync(join(codex, "sessions")), false);
    assert.equal(existsSync(join(codex, "log")), false);
    const auth = join(codex, "auth.json");
    if (existsSync(join(homedir(), ".codex", "auth.json"))) {
      assert.equal(lstatSync(auth).isSymbolicLink(), true);
      assert.equal(readlinkSync(auth), join(homedir(), ".codex", "auth.json"));
    }

    const grok = vendorDir(homeDir, "grok");
    assert.equal(existsSync(join(grok, "AGENTS.md")), true);
    assert.equal(existsSync(join(grok, "CLAUDE.md")), false);

    const claude = vendorDir(homeDir, "claude");
    assert.equal(existsSync(join(claude, "CLAUDE.md")), true);
    assert.equal(existsSync(join(claude, "settings.json")), true);
    assert.equal(existsSync(join(claude, "AGENTS.md")), false);

    const openbot = readFileSync(join(homeDir, "harness", "shared", "OPENBOT.md"), "utf8");
    assert.match(openbot, /This Session is Isolated/);
    assert.match(openbot, /docker exec/);
    assert.match(openbot, /Screen/);
    assert.match(openbot, /OPENBOT_SCREEN_CONTAINER/);
    assert.match(openbot, /PinchTab/);
    assert.match(openbot, /search MCP tools/i);
    assert.match(openbot, /get_text/);
    assert.match(openbot, /snapshot/);
    assert.match(openbot, /screenshot/);
    assert.match(openbot, /untrusted/);
    assert.match(openbot, /Open computer/);
    assert.match(openbot, /fail closed/);
    assert.match(openbot, /Playwright/);
    assert.doesNotMatch(openbot, /optional hint/i);

    const isolatedConfig = readFileSync(join(codex, "config.toml"), "utf8");
    assert.match(isolatedConfig, /sandbox_mode = "danger-full-access"/);
    assert.match(isolatedConfig, /allow_login_shell = false/);
    assert.doesNotMatch(isolatedConfig, /sandbox_mode = "workspace-write"/);
    assert.match(isolatedConfig, /\[projects\./);
    assert.match(isolatedConfig, /trust_level = "trusted"/);
    assert.doesNotMatch(isolatedConfig, /\[mcp_servers/);
  });

  test("ensureHarnessHome pins Isolated OPENBOT.md and Isolated Seatbelt off on existing homes", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace");
    const sharedOpenbot = join(homeDir, "harness", "shared", "OPENBOT.md");
    const codexConfig = join(homeDir, "harness", "codex", "config.toml");
    mkdirSync(join(homeDir, "harness", "shared"), { recursive: true });
    mkdirSync(join(homeDir, "harness", "codex"), { recursive: true });
    writeFileSync(sharedOpenbot, "# stale Isolated instructions\n");
    writeFileSync(
      codexConfig,
      `approval_policy = "on-request"
sandbox_mode = "workspace-write"
allow_login_shell = true
`,
    );
    ensureHarnessHome(homeDir, workspace);
    const openbot = readFileSync(sharedOpenbot, "utf8");
    assert.match(openbot, /This Session is Isolated/);
    assert.match(openbot, /docker exec/);
    assert.match(openbot, /PinchTab/);
    assert.match(openbot, /get_text/);
    assert.match(openbot, /Open computer/);
    const isolatedConfig = readFileSync(codexConfig, "utf8");
    assert.match(isolatedConfig, /sandbox_mode = "danger-full-access"/);
    assert.match(isolatedConfig, /allow_login_shell = false/);
    assert.match(isolatedConfig, /trust_level = "trusted"/);
  });

  test("existing config updates only owned top-level TOML keys through an atomic replacement", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace");
    const codexDir = join(homeDir, "harness", "codex");
    const configPath = join(codexDir, "config.toml");
    const workspaceTable = `[projects.${JSON.stringify(workspace)}]`;
    mkdirSync(codexDir, { recursive: true });
    const original = `# user-owned config
"sandbox_mode" = "workspace-write" # keep sandbox note
allow_login_shell = true # keep shell note
sandbox_mode_backup = "workspace-write"
note = """
sandbox_mode = "inside multiline"
allow_login_shell = true \\
continued
"""

[profile]
sandbox_mode = "nested"
allow_login_shell = true
# ${workspaceTable}
[projects."/elsewhere"]
trust_level = "trusted"
    `;
    writeFileSync(configPath, original);
    chmodSync(configPath, 0o600);
    const originalInode = statSync(configPath).ino;

    ensureHarnessHome(homeDir, workspace);

    const updated = readFileSync(configPath, "utf8");
    assert.match(updated, /^"sandbox_mode" = "danger-full-access" # keep sandbox note$/m);
    assert.match(updated, /^allow_login_shell = false # keep shell note$/m);
    assert.match(updated, /^sandbox_mode_backup = "workspace-write"$/m);
    assert.match(
      updated,
      /note = """\nsandbox_mode = "inside multiline"\nallow_login_shell = true \\\ncontinued\n"""/,
    );
    assert.match(updated, /\[profile\]\nsandbox_mode = "nested"\nallow_login_shell = true/);
    assert.equal(updated.split("\n").filter((line) => line === workspaceTable).length, 1);
    assert.notEqual(statSync(configPath).ino, originalInode);
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.deepEqual(
      readdirSync(codexDir).filter((name) => name.includes("config.toml") && name.endsWith(".tmp")),
      [],
    );
  });

  test("already compliant Isolated config is a byte and metadata no-op", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace");
    const configPath = join(homeDir, "harness", "codex", "config.toml");
    ensureHarnessHome(homeDir, workspace);
    const original = readFileSync(configPath);
    const before = statSync(configPath, { bigint: true });

    ensureHarnessHome(homeDir, workspace);

    const after = statSync(configPath, { bigint: true });
    assert.deepEqual(readFileSync(configPath), original);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
  });

  test("duplicate semantic top-level keys fail without replacing user config", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace");
    const codexDir = join(homeDir, "harness", "codex");
    const configPath = join(codexDir, "config.toml");
    mkdirSync(codexDir, { recursive: true });
    const original = `sandbox_mode = "workspace-write"
"sandbox\\u005fmode" = "read-only"
allow_login_shell = true
`;
    writeFileSync(configPath, original);
    const originalInode = statSync(configPath).ino;

    assert.throws(
      () => ensureHarnessHome(homeDir, workspace),
      /duplicate top-level TOML key "sandbox_mode"/i,
    );
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(statSync(configPath).ino, originalInode);
  });

  test("conflicting exact and dotted owned keys fail without replacing user config", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace");
    const codexDir = join(homeDir, "harness", "codex");
    const configPath = join(codexDir, "config.toml");
    mkdirSync(codexDir, { recursive: true });
    const original = `sandbox_mode = "workspace-write"
sandbox_mode.profile = "nested"
allow_login_shell = true
`;
    writeFileSync(configPath, original);
    const originalInode = statSync(configPath).ino;

    assert.throws(
      () => ensureHarnessHome(homeDir, workspace),
      /top-level TOML key "sandbox_mode" has an incompatible dotted shape/i,
    );
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(statSync(configPath).ino, originalInode);
  });

  test("owned scalar normal-table namespaces fail without replacing user config", async () => {
    const fixtures = [
      `[sandbox_mode]\nchild = "keep"\n`,
      `[sandbox_mode.child]\nvalue = "keep"\n`,
      `["sandbox\\u005fmode".child]\nvalue = "keep"\n`,
      `[allow_login_shell]\nchild = "keep"\n`,
      `[allow_login_shell.child]\nvalue = "keep"\n`,
    ];

    for (const original of fixtures) {
      const homeDir = await tempHome();
      const workspace = join(homeDir, "workspace");
      const codexDir = join(homeDir, "harness", "codex");
      const configPath = join(codexDir, "config.toml");
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(configPath, original);
      const originalInode = statSync(configPath).ino;

      assert.throws(
        () => ensureHarnessHome(homeDir, workspace),
        /TOML table namespace.*owned scalar key/i,
      );
      assert.equal(readFileSync(configPath, "utf8"), original);
      assert.equal(statSync(configPath).ino, originalInode);
    }
  });

  test("owned scalar array-table namespaces fail without replacing user config", async () => {
    const fixtures = [
      `[[sandbox_mode]]\nchild = "keep"\n`,
      `[[sandbox_mode.child]]\nvalue = "keep"\n`,
      `[["allow_login\\u005fshell".child]]\nvalue = "keep"\n`,
    ];

    for (const original of fixtures) {
      const homeDir = await tempHome();
      const workspace = join(homeDir, "workspace");
      const codexDir = join(homeDir, "harness", "codex");
      const configPath = join(codexDir, "config.toml");
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(configPath, original);
      const originalInode = statSync(configPath).ino;

      assert.throws(
        () => ensureHarnessHome(homeDir, workspace),
        /TOML table namespace.*owned scalar key/i,
      );
      assert.equal(readFileSync(configPath, "utf8"), original);
      assert.equal(statSync(configPath).ino, originalInode);
    }
  });

  test("missing owned keys are inserted at the root without changing CRLF newlines", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace");
    const codexDir = join(homeDir, "harness", "codex");
    const configPath = join(codexDir, "config.toml");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      configPath,
      [
        "custom = 'keep'",
        "sandbox_mode_extra = 'similar'",
        "",
        "[profile]",
        "sandbox_mode = 'nested'",
        "allow_login_shell = true",
        "",
      ].join("\r\n"),
    );

    ensureHarnessHome(homeDir, workspace);

    const updated = readFileSync(configPath, "utf8");
    assert.ok(updated.indexOf('sandbox_mode = "danger-full-access"') < updated.indexOf("[profile]"));
    assert.ok(updated.indexOf("allow_login_shell = false") < updated.indexOf("[profile]"));
    assert.match(updated, /sandbox_mode_extra = 'similar'/);
    assert.match(updated, /\[profile\]\r\nsandbox_mode = 'nested'\r\nallow_login_shell = true/);
    assert.doesNotMatch(updated, /(?<!\r)\n/);
  });

  test("an existing workspace project table is made trusted without changing other tables", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace");
    const codexDir = join(homeDir, "harness", "codex");
    const configPath = join(codexDir, "config.toml");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      configPath,
      `sandbox_mode = "workspace-write"
allow_login_shell = true

[projects.${JSON.stringify(workspace)}]
trust_level = "untrusted" # preserve workspace note

[projects."/elsewhere"]
trust_level = "untrusted"
`,
    );

    ensureHarnessHome(homeDir, workspace);

    const updated = readFileSync(configPath, "utf8");
    assert.match(
      updated,
      new RegExp(`\\[projects\\.${escapeRegExp(JSON.stringify(workspace))}\\]\\ntrust_level = "trusted" # preserve workspace note`),
    );
    assert.match(updated, /\[projects\."\/elsewhere"\]\ntrust_level = "untrusted"/);
  });

  test("an array-table workspace lookalike fails closed without replacing config", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace");
    const codexDir = join(homeDir, "harness", "codex");
    const configPath = join(codexDir, "config.toml");
    mkdirSync(codexDir, { recursive: true });
    const original = `sandbox_mode = "workspace-write"
allow_login_shell = true

[[projects.${JSON.stringify(workspace)}]]
trust_level = "trusted"
`;
    writeFileSync(configPath, original);
    const originalInode = statSync(configPath).ino;

    assert.throws(
      () => ensureHarnessHome(homeDir, workspace),
      /workspace project entry.*normal TOML table/i,
    );
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(statSync(configPath).ino, originalInode);
  });

  test("a trusted dotted workspace project stays compatible without a duplicate table", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace");
    const codexDir = join(homeDir, "harness", "codex");
    const configPath = join(codexDir, "config.toml");
    mkdirSync(codexDir, { recursive: true });
    const dottedTrust = `projects.${JSON.stringify(workspace)}.trust_level = "trusted" # keep dotted note`;
    writeFileSync(
      configPath,
      `sandbox_mode = "workspace-write"
allow_login_shell = true
${dottedTrust}
`,
    );

    ensureHarnessHome(homeDir, workspace);

    const updated = readFileSync(configPath, "utf8");
    assert.match(updated, new RegExp(`^${escapeRegExp(dottedTrust)}$`, "m"));
    assert.doesNotMatch(
      updated,
      new RegExp(`^\\[projects\\.${escapeRegExp(JSON.stringify(workspace))}\\]$`, "m"),
    );
  });

  test("an untrusted dotted workspace project updates only its trust value", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace");
    const codexDir = join(homeDir, "harness", "codex");
    const configPath = join(codexDir, "config.toml");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      configPath,
      `sandbox_mode = "workspace-write"
allow_login_shell = true
projects.${JSON.stringify(workspace)}.trust_level = "untrusted" # keep dotted note
projects."/elsewhere".trust_level = "untrusted"
`,
    );

    ensureHarnessHome(homeDir, workspace);

    const updated = readFileSync(configPath, "utf8");
    assert.match(
      updated,
      new RegExp(`^projects\\.${escapeRegExp(JSON.stringify(workspace))}\\.trust_level = "trusted" # keep dotted note$`, "m"),
    );
    assert.match(updated, /^projects\."\/elsewhere"\.trust_level = "untrusted"$/m);
  });

  test("mixed dotted and table workspace shapes fail closed without replacing config", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace");
    const codexDir = join(homeDir, "harness", "codex");
    const configPath = join(codexDir, "config.toml");
    mkdirSync(codexDir, { recursive: true });
    const original = `sandbox_mode = "workspace-write"
allow_login_shell = true
projects.${JSON.stringify(workspace)}.trust_level = "trusted"

[projects.${JSON.stringify(workspace)}]
trust_level = "trusted"
`;
    writeFileSync(configPath, original);
    const originalInode = statSync(configPath).ino;

    assert.throws(() => ensureHarnessHome(homeDir, workspace), /conflicting workspace project entries/i);
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(statSync(configPath).ino, originalInode);
  });

  test("valid four- and five-quote multiline strings survive config bootstrap byte-for-byte", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace");
    const codexDir = join(homeDir, "harness", "codex");
    const configPath = join(codexDir, "config.toml");
    mkdirSync(codexDir, { recursive: true });
    const fourQuotes = `note = """"Honey, I am home!""""`;
    const fiveQuotes = `quotation = """Honey says: """""`;
    writeFileSync(
      configPath,
      `${fourQuotes}\n${fiveQuotes}\nsandbox_mode = "workspace-write"\nallow_login_shell = true\n`,
    );

    ensureHarnessHome(homeDir, workspace);

    const updated = readFileSync(configPath, "utf8");
    assert.match(updated, new RegExp(`^${escapeRegExp(fourQuotes)}$`, "m"));
    assert.match(updated, new RegExp(`^${escapeRegExp(fiveQuotes)}$`, "m"));
  });

  test("a TOML parse error fails closed without replacing config", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace");
    const codexDir = join(homeDir, "harness", "codex");
    const configPath = join(codexDir, "config.toml");
    mkdirSync(codexDir, { recursive: true });
    const original = `note = "invalid\\qescape"
sandbox_mode = "workspace-write"
allow_login_shell = true
`;
    writeFileSync(configPath, original);
    const originalInode = statSync(configPath).ino;

    assert.throws(() => ensureHarnessHome(homeDir, workspace), /invalid TOML escape/i);
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(statSync(configPath).ino, originalInode);
  });

  test("Bot workspace bootstrap rejects every non-generated ID before touching disk", async () => {
    const fixtureRoot = await tempHome();
    const otherBot = crypto.randomUUID();
    const invalidIds = [
      "../../outside",
      "/tmp/absolute-bot",
      "C:\\absolute-bot",
      "\\\\server\\share",
      "nested/bot",
      "nested\\bot",
      ".",
      "..",
      `../${otherBot}`,
      `${crypto.randomUUID()}/../${otherBot}`,
      "%2e%2e%2foutside",
      "%2Ftmp%2Foutside",
      crypto.randomUUID().toUpperCase(),
      "00000000-0000-0000-0000-000000000000",
      "123e4567-e89b-12d3-a456-426614174000",
      `{${crypto.randomUUID()}}`,
      ` ${crypto.randomUUID()}`,
    ];

    invalidIds.forEach((botId, index) => {
      const caseRoot = join(fixtureRoot, String(index));
      const workspace = join(caseRoot, "workspace");
      const botsDir = join(workspace, "bots");
      mkdirSync(botsDir, { recursive: true });
      assert.throws(
        () => ensureBotWorkspace(workspace, botId),
        /invalid Bot ID.*lowercase UUID v4/i,
      );
      assert.deepEqual(readdirSync(caseRoot), ["workspace"]);
      assert.deepEqual(readdirSync(botsDir), []);
    });
  });

  test("Isolated env sets vendor homes; Host unsets them", async () => {
    const homeDir = "/tmp/openbot-home-x";
    const isolated = applyVendorHomeEnv({ CODEX_HOME: "/old", PATH: "/bin" }, "isolated", homeDir);
    assert.equal(isolated.CODEX_HOME, join(homeDir, "harness", "codex"));
    assert.equal(isolated.CLAUDE_CONFIG_DIR, join(homeDir, "harness", "claude"));
    assert.equal(isolated.GROK_HOME, join(homeDir, "harness", "grok"));
    assert.equal(isolated.KIMI_CODE_HOME, join(homeDir, "harness", "kimi"));
    assert.equal(isolated.OPENBOT_CONFIG_MODE, "isolated");
    assert.equal(isolated.OPENBOT_SCREEN_CONTAINER, "openbot-screen");
    assert.equal(isolated.OPENBOT_SCREEN_WORKSPACE, "/workspace");
    const host = applyVendorHomeEnv({ CODEX_HOME: "/old", GROK_HOME: "/g" }, "host", homeDir);
    assert.equal(host.CODEX_HOME, undefined);
    assert.equal(host.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(host.GROK_HOME, undefined);
    assert.equal(host.KIMI_CODE_HOME, undefined);
    assert.equal(host.OPENBOT_CONFIG_MODE, "host");
    assert.equal(host.OPENBOT_SCREEN_CONTAINER, undefined);
  });

  test("Isolated applyVendorHomeEnv with botHome sets HOME; Host leaves HOME", () => {
    const homeDir = "/tmp/openbot-home-x";
    const botId = crypto.randomUUID();
    const botHome = `/tmp/openbot-ws/bots/${botId}`;
    const isolated = applyVendorHomeEnv(
      { HOME: "/Users/mac", PATH: "/bin" },
      "isolated",
      homeDir,
      botHome,
    );
    assert.equal(isolated.HOME, botHome);
    assert.equal(isolated.CODEX_HOME, join(homeDir, "harness", "codex"));
    assert.equal(isolated.OPENBOT_CONFIG_MODE, "isolated");
    assert.equal(isolated.OPENBOT_BOT_ID, botId);
    const host = applyVendorHomeEnv(
      { HOME: "/Users/mac", CODEX_HOME: "/old" },
      "host",
      homeDir,
      botHome,
    );
    assert.equal(host.HOME, "/Users/mac");
    assert.equal(host.CODEX_HOME, undefined);
    assert.equal(host.OPENBOT_CONFIG_MODE, "host");
    assert.equal(host.OPENBOT_BOT_ID, undefined);
  });

  test("Isolated env rejects a cross-Bot ID before publishing session paths", () => {
    const adaId = crypto.randomUUID();
    const benId = crypto.randomUUID();
    const botHome = `/tmp/openbot-ws/bots/${adaId}`;
    assert.throws(
      () =>
        applyVendorHomeEnv(
          { HOME: "/Users/mac", PATH: "/bin" },
          "isolated",
          "/tmp/openbot-home-x",
          botHome,
          { botId: benId },
        ),
      /Bot ID does not match Bot workspace/i,
    );
  });

  test("workspace jail and permission path extraction", () => {
    const workspace = "/tmp/openbot-ws";
    assert.equal(isInsideWorkspace("/tmp/openbot-ws/bots/ada/file.txt", workspace), true);
    assert.equal(isInsideWorkspace("/tmp/openbot-ws", workspace), true);
    assert.equal(isInsideWorkspace("/tmp/secret.txt", workspace), false);
    const path = extractPermissionPath(
      {
        locations: [{ path: "/tmp/secret.txt" }],
        rawInput: { filepath: "/tmp/other.txt" },
      },
      "/tmp/openbot-ws/bots/ada",
    );
    assert.equal(path, "/tmp/secret.txt");
    const fromExec = extractPermissionPath(
      {
        rawInput: {
          command: "printf %s GRANTED > /home/box/.openbot-hh-live/outside/grant.txt",
        },
        meta: {
          codex: {
            params: {
              command: "/bin/bash -lc \"printf %s GRANTED > /home/box/.openbot-hh-live/outside/grant.txt\"",
            },
          },
        },
      },
      "/tmp/openbot-ws/bots/ada",
    );
    assert.equal(fromExec, "/home/box/.openbot-hh-live/outside/grant.txt");
    assert.equal(isInsideScreenWorkspace("/workspace"), true);
    assert.equal(isInsideScreenWorkspace("/workspace/bots/ada"), true);
    assert.equal(isInsideScreenWorkspace("/workspace/bots/$OPENBOT_BOT_ID"), true);
    assert.equal(isInsideScreenWorkspace("/tmp/secret.txt"), false);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("HomeStore Isolated/Host and grants", () => {
  test("additive migrate from schema 1 adds config_mode", async () => {
    const homeDir = await tempHome();
    const databasePath = join(homeDir, "talk.sqlite");
    const seed = new DatabaseSync(databasePath);
    seed.exec(`
      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        shape TEXT NOT NULL,
        harness TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE channel_members (
        channel_id TEXT NOT NULL,
        member_kind TEXT NOT NULL,
        member_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (channel_id, member_kind, member_id)
      );
      CREATE TABLE messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        channel_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'text',
        sender_kind TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reply_to TEXT
      );
      CREATE TABLE reactions (
        message_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, emoji, actor_kind, actor_id)
      );
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        media_type TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE deliveries (
        message_id TEXT NOT NULL,
        recipient_kind TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (message_id, recipient_kind, recipient_id)
      );
      CREATE TABLE bot_channel_state (
        bot_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        harness_id TEXT,
        session_id TEXT,
        PRIMARY KEY (bot_id, channel_id)
      );
      PRAGMA user_version = 1;
    `);
    const adaId = crypto.randomUUID();
    seed
      .prepare("INSERT INTO bots (id, name, color, shape, harness, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(adaId, "Ada", "#ff3b5c", "capsule", null, iso());
    seed.close();

    const home = new HomeStore(homeDir);
    const bots = home.listBots();
    assert.equal(bots[0]?.configMode, "isolated");
    const probe = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = probe.prepare("PRAGMA user_version").get() as { user_version?: number };
      assert.equal(row.user_version, HOME_SCHEMA_VERSION);
    } finally {
      probe.close();
    }
    home.close();
  });

  test("setConfigMode persists Isolated vs Host and clears session id", async () => {
    const homeDir = await tempHome();
    const adaId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: adaId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: "codex",
        createdAt: iso(),
      },
      channelId,
    );
    assert.equal(home.listBots()[0]?.configMode, "isolated");
    home.setSessionId(adaId, channelId, "sess_1");
    home.setConfigMode(adaId, "host");
    assert.equal(home.listBots()[0]?.configMode, "host");
    assert.equal(home.getSessionId(adaId, channelId), null);
    home.close();
    const again = new HomeStore(homeDir);
    assert.equal(again.listBots()[0]?.configMode, "host");
    again.close();
  });

  test("Host grant store is Computer-wide; session grants die with this Talk", async () => {
    const homeDir = await tempHome();
    const home = new HomeStore(homeDir);
    home.addHostGrant({ path: "/tmp/shared-grant.txt", access: "read-write", duration: "session" });
    home.addHostGrant({ path: "/tmp/forever.txt", access: "read", duration: "until-revoked" });
    assert.ok(home.matchHostGrant("/tmp/shared-grant.txt", "read-write"));
    assert.ok(home.matchHostGrant("/tmp/forever.txt", "read"));
    home.close();
    const again = new HomeStore(homeDir);
    assert.equal(again.matchHostGrant("/tmp/shared-grant.txt", "read-write"), null);
    assert.ok(again.matchHostGrant("/tmp/forever.txt", "read"));
    again.close();
  });
});

describe("BotStore Isolated cwd and env", () => {
  test("create Ada Isolated: spawn and session/new cwd is Ada's directory; CODEX_HOME is Isolated", async () => {
    const homeDir = await tempHome();
    const fake = recordingFake();
    const store = new BotStore(homeDir, {
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
    });
    const ada = await store.create("Ada");
    assert.equal(ada.configMode, "isolated");
    await store.pickHarness(ada.id, "codex");
    await store.send(ada.id, "hi");
    await waitUntil(() => fake.spawned.length > 0);
    const botDir = join(homeDir, "workspace", "bots", ada.id);
    assert.equal(fake.spawned[0]?.cwd, botDir);
    assert.deepEqual(fake.spawned[0]?.sessionCwd, [botDir]);
    assert.equal(fake.spawned[0]?.spec.env.CODEX_HOME, join(homeDir, "harness", "codex"));
    assert.equal(fake.spawned[0]?.spec.env.HOME, botDir);
    assert.equal(fake.spawned[0]?.spec.env.OPENBOT_CONFIG_MODE, "isolated");
    assert.equal(fake.spawned[0]?.spec.env.OPENBOT_BOT_ID, ada.id);
    assert.equal(fake.spawned[0]?.spec.env.OPENBOT_SCREEN_CONTAINER, "openbot-screen");
    assert.equal(fake.spawned[0]?.spec.env.OPENBOT_SCREEN_WORKSPACE, "/workspace");
    assert.equal(existsSync(join(botDir, "AGENTS.md")), true);
    assert.equal(lstatSync(join(botDir, "CLAUDE.md")).isSymbolicLink(), true);
    store.close();
  });

  test("Host unsets CODEX_HOME on the next Session", async () => {
    const homeDir = await tempHome();
    const fake = recordingFake();
    const store = new BotStore(homeDir, {
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
    });
    const ada = await store.create("Ada");
    await store.pickHarness(ada.id, "codex");
    await store.setConfigMode(ada.id, "host");
    await store.send(ada.id, "hi");
    await waitUntil(() => fake.spawned.length > 0);
    assert.equal(fake.spawned[0]?.spec.env.CODEX_HOME, undefined);
    assert.equal(fake.spawned[0]?.spec.env.HOME, process.env.HOME);
    assert.equal(fake.spawned[0]?.spec.env.OPENBOT_CONFIG_MODE, "host");
    assert.equal(fake.spawned[0]?.spec.env.OPENBOT_BOT_ID, undefined);
    store.close();
  });

  test("normal v1 permissions ignore path heuristics in Isolated and Host modes", async () => {
    const homeDir = await tempHome();
    const preexistingPath = "/tmp/preexisting-openbot-grant.txt";
    const seeded = new HomeStore(homeDir);
    seeded.addHostGrant({
      path: preexistingPath,
      access: "read-write",
      duration: "until-revoked",
    });
    seeded.close();
    const fake = recordingFake();
    const store = new BotStore(homeDir, {
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
    });
    const ada = await store.create("Ada");
    await store.pickHarness(ada.id, "codex");
    const botDir = join(homeDir, "workspace", "bots", ada.id);
    let rpcId = 10;
    const assertGeneric = async (prompt: Omit<PermissionPrompt, "rpcId" | "options">) => {
      rpcId += 1;
      fake.fire({ ...prompt, rpcId, options: allowDenyOptions });
      await waitUntil(() => store.get(ada.id)?.permission !== null);
      const permission = store.get(ada.id)?.permission;
      assert.equal(permission?.hostGrant, undefined);
      assert.deepEqual(permission?.options.map((option) => option.optionId), ["allow-once", "reject-once"]);
      await store.answerPermission(ada.id, "reject-once", permission?.cardId ?? "");
    };

    for (const mode of ["isolated", "host"] as const) {
      if (mode === "host") await store.setConfigMode(ada.id, "host");
      await store.send(ada.id, `${mode} permission matrix`);
      await waitUntil(() => fake.spawned.length >= (mode === "isolated" ? 1 : 2));
      await assertGeneric({
        title: "Path-bearing",
        locations: [{ path: mode === "isolated" ? join(botDir, "note.txt") : "/workspace/secret.txt" }],
        toolKind: "edit",
      });
      await assertGeneric({
        title: "Pathless command",
        rawInput: { command: "printf pathless" },
        toolKind: "execute",
      });
      await assertGeneric({
        title: "Preexisting grant",
        locations: [{ path: preexistingPath }],
        toolKind: "edit",
      });
    }
    assert.equal(fake.answered.filter((id) => id === "reject-once").length, 6);
    assert.deepEqual(store.listHostGrants().map((grant) => grant.path), [preexistingPath]);
    store.close();
  });
});

describe("Talk HTTP Isolated/Host persist", () => {
  test("PATCH configMode persists; agents editors persist; cwd is Bot dir", async () => {
    const homeDir = await tempHome();
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-hh-pwa-"));
    await writeFile(join(pwaDir, "index.html"), `<!doctype html><title>OpenBot</title>`);
    const fake = recordingFake();
    const box = await startBox({
      password: "correct-horse",
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
    });
    try {
      const login = await fetch(`${box.url}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "correct-horse" }),
      });
      const cookie = cookieHeader(login);
      const created = await fetch(`${box.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      });
      const ada = (await created.json()) as { id: string; configMode?: string };
      assert.equal(ada.configMode, "isolated");
      await fetch(`${box.url}/api/bots/${ada.id}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ harness: "codex" }),
      });
      const host = await fetch(`${box.url}/api/bots/${ada.id}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ configMode: "host" }),
      });
      assert.equal(((await host.json()) as { configMode: string }).configMode, "host");

      const allBots = await fetch(`${box.url}/api/agents`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "# All Bots\nmarker\n" }),
      });
      assert.ok(allBots.ok);
      const thisBot = await fetch(`${box.url}/api/bots/${ada.id}/agents`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "# This Bot\nada-only\n" }),
      });
      assert.ok(thisBot.ok);
      assert.equal(readFileSync(join(homeDir, "workspace", "AGENTS.md"), "utf8"), "# All Bots\nmarker\n");
      assert.equal(
        readFileSync(join(homeDir, "workspace", "bots", ada.id, "AGENTS.md"), "utf8"),
        "# This Bot\nada-only\n",
      );

      await fetch(`${box.url}/api/bots/${ada.id}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      await waitUntil(() => fake.spawned.length > 0);
      assert.equal(fake.spawned[0]?.cwd, join(homeDir, "workspace", "bots", ada.id));
      assert.equal(fake.spawned[0]?.spec.env.CODEX_HOME, undefined);
    } finally {
      await box.close();
    }
  });
});
