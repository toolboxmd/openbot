import assert from "node:assert/strict";
import crypto from "node:crypto";
import { chmodSync, existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import type { AcpSession } from "../src/bots.ts";
import { BotStore, channelHistory, talkPrompt } from "../src/bots.ts";
import { startBox } from "../src/box.ts";
import {
  COMPUTER_CONTAINER,
  DISPLAY_BIN,
  DockerComputerRuntime,
  MemoryComputerRuntime,
} from "../src/computer.ts";
import { HUMAN_MEMBER_ID, HOME_SCHEMA_VERSION, HomeStore, defaultWorkspaceDir } from "../src/home.ts";
import type { SpawnSpec } from "../src/harness.ts";

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "openbot-home-"));
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

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("HomeStore sqlite", () => {
  test("empty Home: createBot writes bot + direct Channel members you+bot", async () => {
    const homeDir = await tempHome();
    const adaId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const home = new HomeStore(homeDir);
    const channel = home.createBot(
      {
        id: adaId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        createdAt: iso(),
      },
      channelId,
    );
    assert.equal(home.listBots().length, 1);
    assert.equal(home.listBots()[0]?.id, adaId);
    assert.equal(channel.kind, "direct");
    assert.equal(channel.members.length, 2);
    assert.deepEqual(
      channel.members.map((member) => `${member.kind}:${member.id}`).sort(),
      [`bot:${adaId}`, `user:${HUMAN_MEMBER_ID}`].sort(),
    );
    assert.equal(home.directChannelId(adaId), channelId);
    assert.equal(channel.messages.length, 0);
    home.close();
  });

  test("createBot rejects a manual ID without publishing database state", async () => {
    const homeDir = await tempHome();
    const home = new HomeStore(homeDir);
    assert.throws(
      () =>
        home.createBot(
          {
            id: "manual-bot",
            name: "Ada",
            color: "#ff3b5c",
            shape: "capsule",
            harness: null,
            createdAt: iso(),
          },
          crypto.randomUUID(),
        ),
      /invalid Bot ID.*lowercase UUID v4/i,
    );
    assert.deepEqual(home.listBots(), []);
    home.close();
  });

  test("append user+assistant, close, new HomeStore: Channel messages survive", async () => {
    const homeDir = await tempHome();
    const adaId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: adaId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        createdAt: iso(),
      },
      channelId,
    );
    home.appendMessage(channelId, {
      id: userId,
      role: "user",
      text: "hello Ada",
      createdAt: iso(1000),
      senderId: HUMAN_MEMBER_ID,
      recipientBotId: adaId,
      receipt: "sent",
    });
    home.appendMessage(channelId, {
      id: assistantId,
      role: "assistant",
      text: "hi there",
      createdAt: iso(2000),
      senderId: adaId,
    });
    home.close();

    const again = new HomeStore(homeDir);
    const messages = again.listMessages(channelId);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.id, userId);
    assert.equal(messages[0]?.text, "hello Ada");
    assert.equal(messages[1]?.id, assistantId);
    assert.equal(messages[1]?.text, "hi there");
    again.close();
  });

  test("receipts, replyTo, reactions survive restart", async () => {
    const homeDir = await tempHome();
    const adaId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const replyId = crypto.randomUUID();
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: adaId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        createdAt: iso(),
      },
      channelId,
    );
    home.appendMessage(channelId, {
      id: userId,
      role: "user",
      text: "hello Ada",
      createdAt: iso(1000),
      senderId: HUMAN_MEMBER_ID,
      recipientBotId: adaId,
      receipt: "sent",
    });
    home.setReceipt(userId, adaId, "delivered", iso(1100));
    home.setReceipt(userId, adaId, "read", iso(1200));
    home.appendMessage(channelId, {
      id: assistantId,
      role: "assistant",
      text: "hi there",
      createdAt: iso(2000),
      senderId: adaId,
    });
    assert.equal(home.toggleReaction(assistantId, "❤️", iso(2100)), true);
    home.appendMessage(channelId, {
      id: replyId,
      role: "user",
      text: "on that",
      createdAt: iso(3000),
      senderId: HUMAN_MEMBER_ID,
      recipientBotId: adaId,
      receipt: "sent",
      replyTo: assistantId,
    });
    home.close();

    const again = new HomeStore(homeDir);
    const restored = again.listChannels()[0];
    assert.ok(restored);
    assert.equal(restored.kind, "direct");
    const [user, assistant, reply] = restored.messages;
    assert.equal(user?.receipt, "read");
    assert.deepEqual(assistant?.reactions, [{ emoji: "❤️", by: "user" }]);
    assert.equal(reply?.replyTo, assistantId);
    assert.equal(reply?.receipt, "sent");
    again.close();
  });

  test("talk.sqlite is 0600 and home dir is 0700", async () => {
    const homeDir = await tempHome();
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: crypto.randomUUID(),
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        createdAt: iso(),
      },
      crypto.randomUUID(),
    );
    home.close();
    assert.equal(modeOf(homeDir), 0o700);
    assert.equal(modeOf(join(homeDir, "talk.sqlite")), 0o600);
  });

  test("refuses to write a schema newer than HOME_SCHEMA_VERSION", async () => {
    const homeDir = await tempHome();
    const databasePath = join(homeDir, "talk.sqlite");
    const seed = new DatabaseSync(databasePath);
    seed.exec(`PRAGMA user_version = ${HOME_SCHEMA_VERSION + 98}`);
    seed.close();

    assert.throws(() => new HomeStore(homeDir), /refusing to write/);

    const probe = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = probe.prepare("PRAGMA user_version").get() as { user_version?: number };
      assert.equal(row.user_version, HOME_SCHEMA_VERSION + 98);
    } finally {
      probe.close();
    }
  });

  test("workspace dir is home/workspace, distinct from talk.sqlite, and HomeStore does not create it", async () => {
    const homeDir = await tempHome();
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: crypto.randomUUID(),
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        createdAt: iso(),
      },
      crypto.randomUUID(),
    );
    assert.equal(home.databasePath, join(homeDir, "talk.sqlite"));
    assert.equal(home.workspaceDir, join(homeDir, "workspace"));
    assert.equal(defaultWorkspaceDir(homeDir), join(homeDir, "workspace"));
    assert.notEqual(home.databasePath, home.workspaceDir);
    assert.equal(existsSync(join(homeDir, "workspace")), false);
    home.close();
  });

  test("talk.sqlite lives under Home, not under workspace, and no bots.json is created", async () => {
    const homeDir = await tempHome();
    const workspace = join(homeDir, "workspace");
    await mkdir(workspace, { recursive: true });
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: crypto.randomUUID(),
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        createdAt: iso(),
      },
      crypto.randomUUID(),
    );
    home.close();
    assert.equal(existsSync(join(homeDir, "talk.sqlite")), true);
    assert.equal(existsSync(join(homeDir, "bots.json")), false);
    assert.equal(existsSync(join(workspace, "bots.json")), false);
    const workspaceFiles = await readdir(workspace);
    assert.equal(
      workspaceFiles.some((name) => name.endsWith(".sqlite") || name === "talk.sqlite"),
      false,
      `workspace must stay empty of sqlite, got ${JSON.stringify(workspaceFiles)}`,
    );
  });

  test("appendMessage, updateMessageText, and setReceipt no-op after close", async () => {
    const homeDir = await tempHome();
    const adaId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: adaId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        createdAt: iso(),
      },
      channelId,
    );
    home.appendMessage(channelId, {
      id: userId,
      role: "user",
      text: "hello",
      createdAt: iso(1000),
      senderId: HUMAN_MEMBER_ID,
      recipientBotId: adaId,
      receipt: "sent",
    });
    home.close();
    home.appendMessage(channelId, {
      id: crypto.randomUUID(),
      role: "assistant",
      text: "should not land",
      createdAt: iso(2000),
      senderId: adaId,
    });
    home.updateMessageText(userId, "mutated");
    home.setReceipt(userId, adaId, "read", iso(3000));

    const again = new HomeStore(homeDir);
    const messages = again.listMessages(channelId);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.text, "hello");
    assert.equal(messages[0]?.receipt, "sent");
    again.close();
  });

  test("setSessionId persists on bot_channel_state and setHarness NULLs it", async () => {
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
        harness: null,
        createdAt: iso(),
      },
      channelId,
    );
    assert.equal(home.getSessionId(adaId, channelId), null);
    home.setSessionId(adaId, channelId, "sess_abc");
    assert.equal(home.getSessionId(adaId, channelId), "sess_abc");
    home.setHarness(adaId, "codex");
    assert.equal(home.getSessionId(adaId, channelId), null);
    home.setSessionId(adaId, channelId, "sess_again");
    home.close();
    home.setSessionId(adaId, channelId, "sess_after_close");

    const again = new HomeStore(homeDir);
    assert.equal(again.getSessionId(adaId, channelId), "sess_again");
    again.close();
  });
});

describe("channelHistory and talkPrompt", () => {
  test("keeps the last 20 user Turns and assistant lines inside that window", () => {
    const messages = [];
    for (let i = 1; i <= 21; i++) {
      messages.push({
        id: `u${i}`,
        role: "user" as const,
        text: `user-${i}`,
        createdAt: iso(i * 1000),
      });
      messages.push({
        id: `a${i}`,
        role: "assistant" as const,
        text: `asst-${i}`,
        createdAt: iso(i * 1000 + 1),
      });
    }
    const history = channelHistory(messages, "Ada");
    assert.match(history, /^Recent Channel transcript:\nYou: user-2\nAda: asst-2\n/);
    assert.doesNotMatch(history, /You: user-1\n/);
    assert.doesNotMatch(history, /Ada: asst-1\n/);
    assert.match(history, /You: user-21\nAda: asst-21$/);
    assert.match(history, /Ada: asst-2\n/);
  });

  test("clips a 64000-character history and marks the cut", () => {
    const huge = "x".repeat(70_000);
    const history = channelHistory([{ id: "u1", role: "user", text: huge, createdAt: iso() }], "Ada");
    assert.match(history, /\[Earlier transcript clipped\]/);
    assert.equal(history.length, 64_000);
    assert.match(history, /^Recent Channel transcript:\n/);
  });

  test("talkPrompt includes Replying to even when history is empty", () => {
    const prompt = talkPrompt("hi", "old bubble");
    assert.match(prompt, /Replying to: old bubble/);
    assert.doesNotMatch(prompt, /Recent Channel transcript/);
    assert.match(prompt, /New message from You:\nhi/);
  });
});


type FakeAcpLoad = "ok" | "throw" | "missing";

function trackingFakeAcp(opts: { load?: FakeAcpLoad } = {}) {
  const methods: string[] = [];
  const prompts: string[] = [];
  const loaded: string[] = [];
  let nextId = 1;

  function spawnAcp(_spec: SpawnSpec, _cwd: string): AcpSession {
    const session: AcpSession = {
      close() {},
      async initialize() {
        methods.push("initialize");
        return {};
      },
      async newSession() {
        methods.push("session/new");
        const id = `s${nextId}`;
        nextId += 1;
        return id;
      },
      async prompt(text: string) {
        methods.push("session/prompt");
        prompts.push(text);
        return "ok";
      },
      cancel() {},
      respondPermission() {},
    };
    if (opts.load !== "missing") {
      session.loadSession = async (sessionId: string) => {
        methods.push("session/load");
        loaded.push(sessionId);
        if (opts.load === "throw") throw new Error("no such session");
        return sessionId;
      };
    }
    return session;
  }

  return { methods, prompts, loaded, spawnAcp };
}

describe("BotStore sqlite is the only Transcript", () => {
  test("create does not write bots.json", async () => {
    const homeDir = await tempHome();
    const store = new BotStore(homeDir);
    await store.create("Ada");
    assert.equal(existsSync(join(homeDir, "bots.json")), false);
    assert.equal(existsSync(join(defaultWorkspaceDir(homeDir), "bots.json")), false);
    assert.equal(existsSync(join(homeDir, "talk.sqlite")), true);
    store.close();
  });

  test("startup rejects a corrupt persisted Bot ID before workspace bootstrap touches disk", async () => {
    const homeDir = await tempHome();
    const validBotId = crypto.randomUUID();
    const seed = new HomeStore(homeDir);
    seed.createBot(
      {
        id: validBotId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        createdAt: iso(),
      },
      crypto.randomUUID(),
    );
    seed.close();
    const database = new DatabaseSync(join(homeDir, "talk.sqlite"));
    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare("UPDATE bots SET id = ? WHERE id = ?").run("../../outside", validBotId);
    database.close();

    let loadedHome: HomeStore | undefined;
    let loadError: unknown;
    try {
      loadedHome = new HomeStore(homeDir);
    } catch (error) {
      loadError = error;
    } finally {
      loadedHome?.close();
    }
    assert.match(String((loadError as Error | undefined)?.message), /corrupt Home.*invalid persisted Bot ID/i);

    let started: BotStore | undefined;
    let startupError: unknown;
    try {
      started = new BotStore(homeDir);
    } catch (error) {
      startupError = error;
    } finally {
      started?.close();
    }

    assert.match(String((startupError as Error | undefined)?.message), /corrupt Home.*invalid persisted Bot ID/i);
    assert.equal(existsSync(join(homeDir, "workspace")), false);
    assert.equal(existsSync(join(homeDir, "outside")), false);
    assert.equal(existsSync(join(homeDir, "workspace", "bots", "outside")), false);
  });

  test("Bot workspace bootstrap failure is actionable and does not publish a durable Bot", async () => {
    const homeDir = await tempHome();
    const store = new BotStore(homeDir);
    const botsDir = join(defaultWorkspaceDir(homeDir), "bots");
    chmodSync(botsDir, 0o500);
    let createError: unknown;
    try {
      await store.create("Ada");
    } catch (error) {
      createError = error;
    } finally {
      chmodSync(botsDir, 0o700);
    }

    try {
      assert.match(String((createError as Error | undefined)?.message), /Bot workspace bootstrap failed/i);
      assert.deepEqual(store.list(), []);
    } finally {
      store.close();
    }
    const persisted = new HomeStore(homeDir);
    assert.deepEqual(persisted.listBots(), []);
    persisted.close();
  });

  test("partial Bot workspace bootstrap failure removes the new generated directory", async () => {
    const homeDir = await tempHome();
    const store = new BotStore(homeDir);
    const botsDir = join(defaultWorkspaceDir(homeDir), "bots");
    let createError: unknown;
    const previousUmask = process.umask(0o777);
    try {
      await store.create("Bootstrap fail");
    } catch (error) {
      createError = error;
    } finally {
      process.umask(previousUmask);
    }

    const entries = await readdir(botsDir);
    try {
      assert.ok(createError instanceof Error, "expected Bot workspace bootstrap to fail");
      const failure = createError as Error & { code?: string; recoverable?: boolean };
      assert.equal(failure.code, "BOT_BOOTSTRAP_FAILED", failure.message);
      assert.equal(failure.recoverable, true);
      assert.deepEqual(store.list(), []);
      assert.deepEqual(entries, []);
    } finally {
      for (const entry of entries) chmodSync(join(botsDir, entry), 0o700);
      store.close();
    }
    const persisted = new HomeStore(homeDir);
    assert.deepEqual(persisted.listBots(), []);
    persisted.close();
  });

  test("display exhaustion does not leave generated Bot workspace or publish a Bot", async () => {
    const homeDir = await tempHome();
    const computer = new MemoryComputerRuntime({ cookiesDir: join(homeDir, "cookies") });
    const store = new BotStore(homeDir, { computer });
    const botsDir = join(defaultWorkspaceDir(homeDir), "bots");
    try {
      for (let index = 1; index <= 8; index += 1) await store.create(`Bot ${index}`);
      const before = (await readdir(botsDir)).sort();
      assert.equal(before.length, 8);

      const afterFailures: string[][] = [];
      for (const name of ["Overflow one", "Overflow two"]) {
        await assert.rejects(store.create(name), /Computer is out of displays/i);
        afterFailures.push((await readdir(botsDir)).sort());
      }

      assert.deepEqual(afterFailures, [before, before]);
      assert.equal(store.list().length, 8);
    } finally {
      store.close();
    }
    const persisted = new HomeStore(homeDir);
    assert.equal(persisted.listBots().length, 8);
    persisted.close();
  });

  test("concurrent Bot creation publishes only after distinct display reservations commit", async () => {
    const homeDir = await tempHome();
    let releasePreparation!: () => void;
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let bothPrepared!: () => void;
    const bothAtPreparation = new Promise<void>((resolve) => {
      bothPrepared = resolve;
    });
    const reservedIds: string[] = [];
    const requestedDisplays: Array<number | undefined> = [];
    class GatedComputer extends MemoryComputerRuntime {
      override reserve(botId: string, requestedDisplay?: number) {
        reservedIds.push(botId);
        requestedDisplays.push(requestedDisplay);
        return super.reserve(botId, requestedDisplay);
      }

      override async prepare(botId: string) {
        if (reservedIds.length === 2) bothPrepared();
        await preparationGate;
        return super.prepare(botId);
      }
    }

    const computer = new GatedComputer({ cookiesDir: join(homeDir, "cookies") });
    const store = new BotStore(homeDir, { computer });
    const adaPending = store.create("Ada");
    const benPending = store.create("Ben");
    await bothAtPreparation;
    assert.deepEqual(store.list(), [], "reserved Bots became usable before commit");
    assert.equal(reservedIds.length, 2);
    assert.deepEqual(requestedDisplays.sort(), [1, 2]);
    assert.equal(computer.display(reservedIds[0]!), undefined);
    assert.equal(computer.display(reservedIds[1]!), undefined);

    releasePreparation();
    const created = await Promise.all([adaPending, benPending]);
    try {
      assert.deepEqual(created.map((bot) => bot.display).sort(), [1, 2]);
      assert.equal(store.list().length, 2);
      const persisted = new HomeStore(homeDir);
      assert.equal(persisted.listBots().length, 2);
      assert.deepEqual(persisted.listBotProvisionings(), []);
      persisted.close();
    } finally {
      store.close();
    }
  });

  test("restart preserves exact displays when concurrent commits finish out of reservation order", async () => {
    const homeDir = await tempHome();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstReserved!: () => void;
    const firstAtPreparation = new Promise<void>((resolve) => {
      firstReserved = resolve;
    });
    class OutOfOrderComputer extends MemoryComputerRuntime {
      override async prepare(botId: string) {
        const reservation = this.reserve(botId);
        if (reservation.display === 1) {
          firstReserved();
          await firstGate;
        }
        return super.prepare(botId);
      }
    }

    const store = new BotStore(homeDir, {
      computer: new OutOfOrderComputer({ cookiesDir: join(homeDir, "cookies-a") }),
    });
    const firstPending = store.create("First");
    await firstAtPreparation;
    const second = await store.create("Second");
    assert.equal(second.display, 2);
    releaseFirst();
    const first = await firstPending;
    assert.equal(first.display, 1);
    store.close();

    const restarted = new BotStore(homeDir, {
      computer: new MemoryComputerRuntime({ cookiesDir: join(homeDir, "cookies-b") }),
    });
    await restarted.reattachDisplays();
    try {
      const byId = new Map(restarted.list().map((bot) => [bot.id, bot.display]));
      assert.equal(byId.get(first.id), 1);
      assert.equal(byId.get(second.id), 2);
    } finally {
      restarted.close();
    }
  });

  test("SQLite Bot commit failure releases the reserved display for retry", async () => {
    const homeDir = await tempHome();
    const databasePath = join(homeDir, "talk.sqlite");
    const seed = new HomeStore(homeDir);
    seed.close();
    const failingDatabase = new DatabaseSync(databasePath);
    failingDatabase.exec(`
      CREATE TRIGGER fail_bot_commit
      BEFORE INSERT ON bots
      BEGIN
        SELECT RAISE(FAIL, 'controlled Bot commit failure');
      END;
    `);
    failingDatabase.close();

    const attemptedIds: string[] = [];
    class TrackingComputer extends MemoryComputerRuntime {
      override reserve(botId: string) {
        attemptedIds.push(botId);
        return super.reserve(botId);
      }
    }

    const computer = new TrackingComputer({ cookiesDir: join(homeDir, "cookies") });
    const store = new BotStore(homeDir, { computer });
    try {
      await assert.rejects(store.create("Ada"), /controlled Bot commit failure/);
      assert.equal(attemptedIds.length, 1);
      assert.equal(computer.display(attemptedIds[0]!), undefined, "failed creation leaked display 1");
      assert.deepEqual(store.list(), []);

      const repairedDatabase = new DatabaseSync(databasePath);
      repairedDatabase.exec("DROP TRIGGER fail_bot_commit");
      repairedDatabase.close();

      const retry = await store.create("Ada retry");
      assert.equal(retry.display, 1, "retry did not reuse the compensated display slot");
    } finally {
      store.close();
    }
  });

  test("restart discards a persisted pre-prepare display reservation and retry reuses that display", async () => {
    const homeDir = await tempHome();
    const seeded = new BotStore(homeDir, {
      computer: new MemoryComputerRuntime({ cookiesDir: join(homeDir, "cookies-seed") }),
    });
    const existing = await seeded.create("Existing");
    assert.equal(existing.display, 1);
    seeded.close();

    const interruptedBotId = crypto.randomUUID();
    const interrupted = new HomeStore(homeDir);
    interrupted.beginBotProvisioning(interruptedBotId);
    interrupted.setBotProvisioningWorkspaceOwned(interruptedBotId, false);
    interrupted.setBotProvisioningDisplay(interruptedBotId, 2);
    interrupted.close();

    const dockerCalls: string[][] = [];
    const computer = new DockerComputerRuntime({
      hostPorts: [16911, 16912],
      cookiesDir: join(homeDir, "cookies-restart"),
      docker: async (args) => {
        dockerCalls.push(args);
        if (args[0] === "inspect") return { code: 0, stdout: "true\n", stderr: "" };
        if (args[3] === "stop") {
          return { code: 73, stdout: "", stderr: "cookies_out requires a published epoch\n" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const restarted = new BotStore(homeDir, { computer, screenReady: async () => true });
    try {
      await restarted.reattachDisplays();
      assert.deepEqual(restarted.list().map((bot) => [bot.id, bot.display]), [[existing.id, 1]]);
      assert.equal(
        existsSync(join(defaultWorkspaceDir(homeDir), "bots", interruptedBotId)),
        false,
        "pre-prepare recovery created or leaked an unpublished workspace",
      );

      const recoveredHome = new HomeStore(homeDir);
      assert.deepEqual(recoveredHome.listBotProvisionings(), []);
      recoveredHome.close();

      const retry = await restarted.create("Retry");
      assert.equal(retry.display, 2);
      assert.deepEqual(
        restarted.list().map((bot) => bot.display).sort(),
        [1, 2],
        "retry published a duplicate or wrong display",
      );
      assert.deepEqual(
        dockerCalls.filter((args) => args.includes(DISPLAY_BIN)),
        [
          ["exec", COMPUTER_CONTAINER, DISPLAY_BIN, "discard", "2"],
          ["exec", COMPUTER_CONTAINER, DISPLAY_BIN, "start", "2"],
        ],
      );
    } finally {
      restarted.close();
    }
  });

  test("SQLite publication failure discards its runtime slot while published release uses normal stop", async () => {
    const homeDir = await tempHome();
    const dockerCalls: string[][] = [];
    const computer = new DockerComputerRuntime({
      hostPorts: [16911, 16912],
      cookiesDir: join(homeDir, "cookies"),
      docker: async (args) => {
        dockerCalls.push(args);
        return { code: 0, stdout: args[0] === "inspect" ? "true\n" : "", stderr: "" };
      },
    });
    const store = new BotStore(homeDir, { computer, screenReady: async () => true });
    try {
      const existing = await store.create("Existing");
      assert.equal(existing.display, 1);

      const database = new DatabaseSync(join(homeDir, "talk.sqlite"));
      database.exec(`
        CREATE TRIGGER fail_runtime_slot_publication
        BEFORE INSERT ON bots
        WHEN NEW.name = 'Commit fail'
        BEGIN
          SELECT RAISE(FAIL, 'controlled runtime slot publication failure');
        END;
      `);
      database.close();

      await assert.rejects(store.create("Commit fail"), /controlled runtime slot publication failure/i);
      assert.deepEqual(store.list().map((bot) => bot.display), [1]);

      const repaired = new DatabaseSync(join(homeDir, "talk.sqlite"));
      repaired.exec("DROP TRIGGER fail_runtime_slot_publication");
      repaired.close();

      const retry = await store.create("Published retry");
      assert.equal(retry.display, 2);
      await computer.release(retry.id);
      assert.equal(computer.display(retry.id), undefined);
      assert.deepEqual(
        dockerCalls.filter((args) => args.includes(DISPLAY_BIN)),
        [
          ["exec", COMPUTER_CONTAINER, DISPLAY_BIN, "start", "2"],
          ["exec", COMPUTER_CONTAINER, DISPLAY_BIN, "discard", "2"],
          ["exec", COMPUTER_CONTAINER, DISPLAY_BIN, "start", "2"],
          ["exec", COMPUTER_CONTAINER, DISPLAY_BIN, "stop", "2"],
        ],
      );
    } finally {
      store.close();
    }
  });

  test("cleanup failure persists exact provisioning state and restart recovers display 2", async () => {
    const homeDir = await tempHome();
    let failedBotId = "";
    let failCleanup = false;
    class CleanupFailComputer extends MemoryComputerRuntime {
      override reserve(botId: string) {
        if (failCleanup) failedBotId = botId;
        return super.reserve(botId);
      }

      override async rollback(botId: string, display?: number): Promise<void> {
        if (failCleanup && botId === failedBotId) throw new Error("controlled display cleanup failure");
        await super.rollback(botId, display);
      }
    }

    const computer = new CleanupFailComputer({ cookiesDir: join(homeDir, "cookies-a") });
    const store = new BotStore(homeDir, { computer });
    const existing = await store.create("Existing");
    assert.equal(existing.display, 1);

    const failingDatabase = new DatabaseSync(join(homeDir, "talk.sqlite"));
    failingDatabase.exec(`
      CREATE TRIGGER fail_second_bot_commit
      BEFORE INSERT ON bots
      WHEN NEW.name = 'Cleanup fail'
      BEGIN
        SELECT RAISE(FAIL, 'controlled second Bot commit failure');
      END;
    `);
    failingDatabase.close();
    failCleanup = true;

    let createError: unknown;
    try {
      await store.create("Cleanup fail");
    } catch (error) {
      createError = error;
    } finally {
      store.close();
    }

    const failure = createError as Error & { code?: string; provisioningId?: string; recoverable?: boolean };
    assert.equal(failure.code, "BOT_PROVISIONING_CLEANUP_REQUIRED", failure.message);
    assert.equal(failure.provisioningId, failedBotId);
    assert.equal(failure.recoverable, true);
    assert.equal(existsSync(join(defaultWorkspaceDir(homeDir), "bots", failedBotId)), false);

    const pending = new HomeStore(homeDir);
    assert.deepEqual(pending.listBotProvisionings(), [{
      botId: failedBotId,
      display: 2,
      workspaceOwned: false,
      state: "cleanup-required",
    }]);
    pending.close();

    const recoveredComputer = new MemoryComputerRuntime({ cookiesDir: join(homeDir, "cookies-b") });
    const restarted = new BotStore(homeDir, { computer: recoveredComputer });
    await restarted.reattachDisplays();
    try {
      assert.deepEqual(restarted.list().map((bot) => [bot.name, bot.display]), [["Existing", 1]]);
      assert.deepEqual(
        recoveredComputer.commands.filter((args) => args.includes(DISPLAY_BIN)),
        [["exec", COMPUTER_CONTAINER, DISPLAY_BIN, "discard", "2"]],
      );
      const recoveredHome = new HomeStore(homeDir);
      assert.deepEqual(recoveredHome.listBotProvisionings(), []);
      recoveredHome.close();
    } finally {
      restarted.close();
    }
  });

  test("later failure preserves a modified new Bot workspace and reports cleanup", async () => {
    const homeDir = await tempHome();
    const botsDir = join(defaultWorkspaceDir(homeDir), "bots");
    let failedBotId = "";
    class UserWritingComputer extends MemoryComputerRuntime {
      override async prepare(botId: string): Promise<never> {
        failedBotId = botId;
        await writeFile(join(botsDir, botId, "user-owned.txt"), "keep\n");
        throw new Error("fixture allocation failure");
      }
    }
    const computer = new UserWritingComputer({ cookiesDir: join(homeDir, "cookies") });
    const store = new BotStore(homeDir, { computer });
    let createError: unknown;
    try {
      await store.create("Ada");
    } catch (error) {
      createError = error;
    } finally {
      store.close();
    }

    const failure = createError as Error & { code?: string; recoverable?: boolean };
    assert.equal(failure.code, "BOT_WORKSPACE_CLEANUP_REQUIRED");
    assert.equal(failure.recoverable, true);
    assert.match(failure.message, /preserved.*preserve anything you need.*remove.*only if safe/i);
    assert.deepEqual(await readdir(botsDir), [failedBotId]);
    assert.equal(existsSync(join(botsDir, failedBotId, "user-owned.txt")), true);
    const persisted = new HomeStore(homeDir);
    assert.deepEqual(persisted.listBots(), []);
    persisted.close();
  });

  test("restores Ada display 1 and Bob display 2 from HomeStore created order", async () => {
    const homeDir = await tempHome();
    const first = new BotStore(homeDir, {
      computer: new MemoryComputerRuntime({ cookiesDir: join(homeDir, "cookies-a") }),
    });
    const ada = await first.create("Ada");
    const bob = await first.create("Bob");
    first.close();

    const computer = new MemoryComputerRuntime({ cookiesDir: join(homeDir, "cookies-b") });
    const store = new BotStore(homeDir, { computer });
    await store.reattachDisplays();
    assert.equal(computer.display(ada.id)?.display, 1);
    assert.equal(computer.display(bob.id)?.display, 2);
    const listed = store.list();
    assert.equal(listed.length, 2);
    assert.equal(listed[0]?.id, ada.id);
    assert.equal(listed[1]?.id, bob.id);
    assert.equal(listed[0]?.display, 1);
    assert.equal(listed[1]?.display, 2);
    store.close();
  });

  test("persisted display attachment failure settles unavailable and uses committed release instead of discard", async () => {
    const homeDir = await tempHome();
    const seeded = new BotStore(homeDir, {
      computer: new MemoryComputerRuntime({ cookiesDir: join(homeDir, "cookies-seed") }),
    });
    await seeded.create("Ada");
    await seeded.create("Bob");
    seeded.close();

    const dockerCalls: string[][] = [];
    const computer = new DockerComputerRuntime({
      hostPorts: [16911, 16912],
      cookiesDir: join(homeDir, "cookies-restart"),
      docker: async (args) => {
        dockerCalls.push(args);
        if (args[0] === "inspect") return { code: 0, stdout: "true\n", stderr: "" };
        if (args[3] === "start") {
          return { code: 61, stdout: "", stderr: "controlled persisted prepare failure\n" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const restarted = new BotStore(homeDir, { computer });
    try {
      await restarted.reattachDisplays();
      assert.deepEqual(
        restarted.list().map((bot) => [bot.name, bot.display, bot.screenState, bot.screenError?.stage]),
        [
          ["Ada", 1, "unavailable", "readiness"],
          ["Bob", 2, "unavailable", "prepare"],
        ],
      );
      assert.deepEqual(
        dockerCalls.filter((args) => args.includes(DISPLAY_BIN)),
        [
          ["exec", COMPUTER_CONTAINER, DISPLAY_BIN, "start", "2"],
          ["exec", COMPUTER_CONTAINER, DISPLAY_BIN, "stop", "2"],
        ],
      );
      assert.equal(dockerCalls.some((args) => args.includes("discard")), false);
    } finally {
      restarted.close();
    }
  });

  test("after send, sqlite session_id is the id returned by session/new", async () => {
    const homeDir = await tempHome();
    const fake = trackingFakeAcp();
    const store = new BotStore(homeDir, {
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
    });
    const ada = await store.create("Ada");
    await store.pickHarness(ada.id, "codex");
    await store.send(ada.id, "remember LIVE-ORBIT-1");
    await waitUntil(() => fake.methods.includes("session/prompt"));
    store.close();

    const home = new HomeStore(homeDir);
    const channelId = home.directChannelId(ada.id);
    assert.ok(channelId);
    assert.equal(home.getSessionId(ada.id, channelId), "s1");
    home.close();
  });

  test("restart send uses session/load and does not inject Channel history", async () => {
    const homeDir = await tempHome();
    const fake = trackingFakeAcp();
    const first = new BotStore(homeDir, {
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
    });
    const ada = await first.create("Ada");
    await first.pickHarness(ada.id, "codex");
    assert.equal(first.hasAcpChild(ada.id), false, "pickHarness must not spawn until send");
    await first.send(ada.id, "remember LIVE-ORBIT-1");
    await waitUntil(() => fake.methods.includes("session/prompt"));
    first.close();

    fake.methods.length = 0;
    fake.prompts.length = 0;
    fake.loaded.length = 0;
    const again = new BotStore(homeDir, {
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
    });
    await again.send(ada.id, "LIVE-AGAIN-1");
    await waitUntil(() => fake.methods.includes("session/prompt") && fake.prompts.length > 0);
    assert.deepEqual(fake.loaded, ["s1"]);
    assert.ok(fake.methods.includes("session/load"));
    assert.equal(fake.methods.includes("session/new"), false);
    assert.ok(fake.prompts.some((text) => /New message from You:\nLIVE-AGAIN-1/.test(text)));
    assert.equal(
      fake.prompts.some((text) => text.includes("LIVE-ORBIT-1") || text.includes("Recent Channel transcript")),
      false,
      "successful session/load must not inject Channel history",
    );
    again.close();
  });

  test("if session/load rejects, next send is session/new plus last-20 inject", async () => {
    const homeDir = await tempHome();
    const fake = trackingFakeAcp({ load: "throw" });
    const first = new BotStore(homeDir, {
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
    });
    const ada = await first.create("Ada");
    await first.pickHarness(ada.id, "codex");
    await first.send(ada.id, "remember LIVE-ORBIT-1");
    await waitUntil(() => fake.methods.includes("session/prompt"));
    first.close();

    fake.methods.length = 0;
    fake.prompts.length = 0;
    const again = new BotStore(homeDir, {
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
    });
    await again.send(ada.id, "LIVE-AGAIN-1");
    await waitUntil(() => fake.methods.includes("session/prompt") && fake.prompts.length > 0);
    assert.ok(fake.methods.includes("session/load"));
    assert.ok(fake.methods.includes("session/new"));
    assert.ok(fake.prompts.some((text) => text.includes("LIVE-ORBIT-1")));
    assert.ok(fake.prompts.some((text) => /New message from You:\nLIVE-AGAIN-1/.test(text)));
    const home = new HomeStore(homeDir);
    const channelId = home.directChannelId(ada.id);
    assert.ok(channelId);
    assert.equal(home.getSessionId(ada.id, channelId), "s2");
    home.close();
    again.close();
  });

  test("pickHarness harness change clears session_id; next send never loads the old id", async () => {
    const homeDir = await tempHome();
    const fake = trackingFakeAcp();
    const first = new BotStore(homeDir, {
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
    });
    const ada = await first.create("Ada");
    await first.pickHarness(ada.id, "codex");
    await first.send(ada.id, "remember LIVE-ORBIT-1");
    await waitUntil(() => fake.methods.includes("session/prompt"));
    first.close();

    const home = new HomeStore(homeDir);
    const channelId = home.directChannelId(ada.id);
    assert.ok(channelId);
    assert.equal(home.getSessionId(ada.id, channelId), "s1");
    home.setHarness(ada.id, "grok");
    assert.equal(home.getSessionId(ada.id, channelId), null);
    home.setHarness(ada.id, "codex");
    assert.equal(home.getSessionId(ada.id, channelId), null);
    home.close();

    fake.methods.length = 0;
    fake.prompts.length = 0;
    fake.loaded.length = 0;
    const again = new BotStore(homeDir, {
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
    });
    await again.send(ada.id, "LIVE-AGAIN-1");
    await waitUntil(() => fake.methods.includes("session/prompt") && fake.prompts.length > 0);
    assert.equal(fake.methods.includes("session/load"), false);
    assert.deepEqual(fake.loaded, []);
    assert.ok(fake.methods.includes("session/new"));
    assert.ok(fake.prompts.some((text) => text.includes("LIVE-ORBIT-1")));
    again.close();
  });

  test("cross-Harness leftover session_id is never loaded", async () => {
    const homeDir = await tempHome();
    const fake = trackingFakeAcp();
    const first = new BotStore(homeDir, {
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
    });
    const ada = await first.create("Ada");
    await first.pickHarness(ada.id, "codex");
    await first.send(ada.id, "remember LIVE-ORBIT-1");
    await waitUntil(() => fake.methods.includes("session/prompt"));
    first.close();

    const db = new DatabaseSync(join(homeDir, "talk.sqlite"));
    db.prepare("UPDATE bot_channel_state SET harness_id = 'grok' WHERE bot_id = ?").run(ada.id);
    db.close();

    fake.methods.length = 0;
    fake.loaded.length = 0;
    const again = new BotStore(homeDir, {
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
    });
    await again.send(ada.id, "LIVE-AGAIN-1");
    await waitUntil(() => fake.methods.includes("session/prompt"));
    assert.equal(fake.methods.includes("session/load"), false);
    assert.deepEqual(fake.loaded, []);
    assert.ok(fake.methods.includes("session/new"));
    again.close();
  });

  test("fake without loadSession falls back to session/new + inject", async () => {
    const homeDir = await tempHome();
    const fake = trackingFakeAcp({ load: "missing" });
    const first = new BotStore(homeDir, {
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
    });
    const ada = await first.create("Ada");
    await first.pickHarness(ada.id, "codex");
    await first.send(ada.id, "remember LIVE-ORBIT-1");
    await waitUntil(() => fake.methods.includes("session/prompt"));
    first.close();

    fake.methods.length = 0;
    fake.prompts.length = 0;
    const again = new BotStore(homeDir, {
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
    });
    await again.send(ada.id, "LIVE-AGAIN-1");
    await waitUntil(() => fake.methods.includes("session/prompt") && fake.prompts.length > 0);
    assert.equal(fake.methods.includes("session/load"), false);
    assert.ok(fake.methods.includes("session/new"));
    assert.ok(fake.prompts.some((text) => text.includes("LIVE-ORBIT-1")));
    again.close();
  });
});

describe("Talk HTTP persist", () => {
  test("startBox with homeDir restores Ada+Bob ids; messages stay empty until sent; Screens in created order", async () => {
    const homeDir = await tempHome();
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-home-pwa-"));
    await writeFile(join(pwaDir, "index.html"), `<!doctype html><title>OpenBot</title>`);
    const computerA = new MemoryComputerRuntime({ cookiesDir: join(homeDir, "cookies-1") });
    let box = await startBox({
      password: "correct-horse",
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer: computerA,
    });
    const cookieHeader = (res: Response) =>
      res.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
    try {
      const login = await fetch(`${box.url}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "correct-horse" }),
      });
      const cookie = cookieHeader(login);
      const adaRes = await fetch(`${box.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      });
      const bobRes = await fetch(`${box.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Bob" }),
      });
      assert.equal(adaRes.status, 201);
      assert.equal(bobRes.status, 201);
      const adaId = ((await adaRes.json()) as { id: string }).id;
      const bobId = ((await bobRes.json()) as { id: string }).id;
      await box.close();

      const computerB = new MemoryComputerRuntime({ cookiesDir: join(homeDir, "cookies-2") });
      box = await startBox({
        password: "correct-horse",
        pwaDir,
        host: "127.0.0.1",
        port: 0,
        homeDir,
        computer: computerB,
      });
      const login2 = await fetch(`${box.url}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "correct-horse" }),
      });
      const cookie2 = cookieHeader(login2);
      const listed = await fetch(`${box.url}/api/bots`, { headers: { cookie: cookie2 } });
      const body = (await listed.json()) as { bots: Array<{ id: string; name: string; display?: number | null }> };
      assert.deepEqual(body.bots.map((bot) => bot.name).sort(), ["Ada", "Bob"]);
      assert.ok(body.bots.some((bot) => bot.id === adaId));
      assert.ok(body.bots.some((bot) => bot.id === bobId));
      assert.equal(computerB.display(adaId)?.display, 1);
      assert.equal(computerB.display(bobId)?.display, 2);
      const messages = await fetch(`${box.url}/api/bots/${adaId}/messages`, { headers: { cookie: cookie2 } });
      const thread = (await messages.json()) as { messages?: unknown[] };
      assert.deepEqual(thread.messages, []);
    } finally {
      await box.close();
    }
  });
});
