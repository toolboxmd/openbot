import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
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
  ensureHarnessHome,
  extractPermissionPath,
  isInsideScreenWorkspace,
  isInsideWorkspace,
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

describe("Isolated Harness Home layout", () => {
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
    const botHome = "/tmp/openbot-ws/bots/ada";
    const isolated = applyVendorHomeEnv(
      { HOME: "/Users/mac", PATH: "/bin" },
      "isolated",
      homeDir,
      botHome,
    );
    assert.equal(isolated.HOME, botHome);
    assert.equal(isolated.CODEX_HOME, join(homeDir, "harness", "codex"));
    assert.equal(isolated.OPENBOT_CONFIG_MODE, "isolated");
    assert.equal(isolated.OPENBOT_BOT_ID, "ada");
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
    seed
      .prepare("INSERT INTO bots (id, name, color, shape, harness, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("ada", "Ada", "#ff3b5c", "capsule", null, iso());
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

  test("in-jail path auto-allows; out-of-jail becomes a Host grant Card", async () => {
    const homeDir = await tempHome();
    const fake = recordingFake();
    const store = new BotStore(homeDir, {
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
    });
    const ada = await store.create("Ada");
    await store.pickHarness(ada.id, "codex");
    await store.send(ada.id, "hi");
    await waitUntil(() => fake.spawned.length > 0);
    const botDir = join(homeDir, "workspace", "bots", ada.id);
    fake.fire({
      rpcId: 11,
      title: "Write file",
      options: allowDenyOptions,
      locations: [{ path: join(botDir, "note.txt") }],
      toolKind: "edit",
    });
    assert.deepEqual(fake.answered, ["allow-once"]);
    assert.equal(store.get(ada.id)?.permission, null);

    fake.fire({
      rpcId: 12,
      title: "Write file",
      options: allowDenyOptions,
      locations: [{ path: "/tmp/outside-ada.txt" }],
      toolKind: "edit",
    });
    const pending = store.get(ada.id)?.permission;
    assert.ok(pending?.hostGrant);
    assert.equal(pending?.hostGrant?.path, "/tmp/outside-ada.txt");
    store.answerHostGrant(ada.id, "read-write", "session");
    assert.deepEqual(fake.answered, ["allow-once", "allow-once"]);
    const grants = store.listHostGrants();
    assert.equal(grants.some((grant) => grant.path === "/tmp/outside-ada.txt"), true);

    const ben = await store.create("Ben");
    await store.pickHarness(ben.id, "codex");
    await store.send(ben.id, "hi");
    await waitUntil(() => fake.spawned.length > 1);
    fake.fire({
      rpcId: 13,
      title: "Write file",
      options: allowDenyOptions,
      locations: [{ path: "/tmp/outside-ada.txt" }],
      toolKind: "edit",
    });
    assert.equal(store.get(ben.id)?.permission, null);
    assert.ok(fake.answered.includes("allow-once"));
    store.close();
  });

  test("Isolated docker exec Screen /workspace path auto-allows; Host does not", async () => {
    const homeDir = await tempHome();
    const fake = recordingFake();
    const store = new BotStore(homeDir, {
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
    });
    const ada = await store.create("Ada");
    await store.pickHarness(ada.id, "codex");
    await store.send(ada.id, "hi");
    await waitUntil(() => fake.spawned.length > 0);
    fake.fire({
      rpcId: 30,
      title: "Exec",
      options: allowDenyOptions,
      locations: [{ path: "/workspace/bots/$OPENBOT_BOT_ID" }],
      toolKind: "execute",
    });
    assert.deepEqual(fake.answered, ["allow-once"]);
    assert.equal(store.get(ada.id)?.permission, null);

    await store.setConfigMode(ada.id, "host");
    await store.send(ada.id, "hi");
    await waitUntil(() => fake.spawned.length > 1);
    fake.fire({
      rpcId: 31,
      title: "Exec",
      options: allowDenyOptions,
      locations: [{ path: "/workspace/secret.txt" }],
      toolKind: "execute",
    });
    const pending = store.get(ada.id)?.permission;
    assert.ok(pending?.hostGrant);
    assert.equal(pending?.hostGrant?.path, "/workspace/secret.txt");
    store.close();
  });

  test("Deny keeps the jail", async () => {
    const homeDir = await tempHome();
    const fake = recordingFake();
    const store = new BotStore(homeDir, {
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
    });
    const ada = await store.create("Ada");
    await store.pickHarness(ada.id, "codex");
    await store.send(ada.id, "hi");
    await waitUntil(() => fake.spawned.length > 0);
    fake.fire({
      rpcId: 20,
      title: "Write file",
      options: allowDenyOptions,
      locations: [{ path: "/tmp/denied.txt" }],
      toolKind: "edit",
    });
    store.answerHostGrant(ada.id, "deny", "session");
    assert.ok(fake.answered.includes("reject-once"));
    fake.fire({
      rpcId: 21,
      title: "Write file",
      options: allowDenyOptions,
      locations: [{ path: "/tmp/denied.txt" }],
      toolKind: "edit",
    });
    assert.equal(store.get(ada.id)?.permission, null);
    assert.equal(fake.answered.filter((id) => id === "reject-once").length, 2);
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
