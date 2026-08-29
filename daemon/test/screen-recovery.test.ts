import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startBox, type RunningBox } from "../src/box.ts";
import { MemoryComputerRuntime, type DisplayHandle } from "../src/computer.ts";
import { HOME_SCHEMA_VERSION, HUMAN_MEMBER_ID, HomeStore, defaultWorkspaceDir } from "../src/home.ts";

const PASSWORD = "correct-horse";

class PrepareFailingComputer extends MemoryComputerRuntime {
  constructor(
    cookiesDir: string,
    private readonly failedBotId: string,
    upstreams?: string[],
  ) {
    super({ cookiesDir, upstreams });
  }

  override async prepare(botId: string): Promise<DisplayHandle> {
    if (botId === this.failedBotId) throw new Error("controlled display attach failure");
    return super.prepare(botId);
  }
}

class DeferredPrepareComputer extends MemoryComputerRuntime {
  readonly prepareStarted: Promise<void>;
  readonly commitCalls: string[] = [];
  readonly releaseCalls: string[] = [];
  private markPrepareStarted!: () => void;
  private finishPrepare!: () => void;
  private readonly prepareGate: Promise<void>;

  constructor(cookiesDir: string, upstreams?: string[]) {
    super({ cookiesDir, upstreams });
    this.prepareStarted = new Promise((resolve) => (this.markPrepareStarted = resolve));
    this.prepareGate = new Promise((resolve) => (this.finishPrepare = resolve));
  }

  completePrepare(): void {
    this.finishPrepare();
  }

  override async prepare(botId: string): Promise<DisplayHandle> {
    this.markPrepareStarted();
    await this.prepareGate;
    return super.prepare(botId);
  }

  override commit(botId: string): DisplayHandle {
    this.commitCalls.push(botId);
    return super.commit(botId);
  }

  override async release(botId: string): Promise<void> {
    this.releaseCalls.push(botId);
    await super.release(botId);
  }
}

class RetryWhileSiblingPendingComputer extends MemoryComputerRuntime {
  readonly siblingPrepareStarted: Promise<void>;
  readonly reserveCalls: Array<{ botId: string; requestedDisplay?: number }> = [];
  readonly releaseCalls: string[] = [];
  private failFirstBotReserve = true;
  private markSiblingPrepareStarted!: () => void;
  private finishSiblingPrepare!: () => void;
  private readonly siblingPrepareGate: Promise<void>;

  constructor(
    options: ConstructorParameters<typeof MemoryComputerRuntime>[0],
    private readonly failedBotId: string,
    private readonly pendingBotId: string,
  ) {
    super(options);
    this.siblingPrepareStarted = new Promise((resolve) => (this.markSiblingPrepareStarted = resolve));
    this.siblingPrepareGate = new Promise((resolve) => (this.finishSiblingPrepare = resolve));
  }

  completeSiblingPrepare(): void {
    this.finishSiblingPrepare();
  }

  override reserve(botId: string, requestedDisplay?: number): DisplayHandle {
    this.reserveCalls.push({ botId, requestedDisplay });
    if (botId === this.failedBotId && this.failFirstBotReserve) {
      this.failFirstBotReserve = false;
      throw new Error("controlled first Bot reserve failure");
    }
    return super.reserve(botId, requestedDisplay);
  }

  override async prepare(botId: string): Promise<DisplayHandle> {
    if (botId === this.pendingBotId) {
      this.markSiblingPrepareStarted();
      await this.siblingPrepareGate;
    }
    return super.prepare(botId);
  }

  override async release(botId: string): Promise<void> {
    this.releaseCalls.push(botId);
    await super.release(botId);
  }
}

class CleanupFailingComputer extends MemoryComputerRuntime {
  readonly releaseCalls: string[] = [];

  constructor(
    cookiesDir: string,
    private readonly failedBotId: string,
  ) {
    super({ cookiesDir, upstreams: ["http://127.0.0.1:16901", "http://127.0.0.1:16902"] });
  }

  override async prepare(botId: string): Promise<DisplayHandle> {
    const handle = await super.prepare(botId);
    if (botId === this.failedBotId) throw new Error("controlled persisted attach failure");
    return handle;
  }

  override async release(botId: string): Promise<void> {
    this.releaseCalls.push(botId);
    if (botId === this.failedBotId) throw new Error("controlled persisted cleanup failure");
    await super.release(botId);
  }
}

class ProvisioningConflictComputer extends MemoryComputerRuntime {
  readonly rollbackCalls: Array<{ botId: string; display?: number }> = [];

  override async rollback(botId: string, display?: number): Promise<void> {
    this.rollbackCalls.push({ botId, display });
    await super.rollback(botId, display);
  }
}

class TrackingComputer extends MemoryComputerRuntime {
  readonly reserveCalls: Array<{ botId: string; requestedDisplay?: number }> = [];

  override reserve(botId: string, requestedDisplay?: number): DisplayHandle {
    this.reserveCalls.push({ botId, requestedDisplay });
    return super.reserve(botId, requestedDisplay);
  }
}

class DurableDisplayCreateComputer extends MemoryComputerRuntime {
  readonly reserveCalls: Array<{ botId: string; requestedDisplay?: number }> = [];
  readonly prepareCalls: Array<{ botId: string; display: number }> = [];
  readonly releaseCalls: Array<{ botId: string; display: number | null }> = [];
  readonly rollbackCalls: Array<{ botId: string; display?: number }> = [];
  private readonly preparedDisplayByBot = new Map<string, number>();
  private failedPersistedPrepare = false;

  constructor(
    options: ConstructorParameters<typeof MemoryComputerRuntime>[0],
    private readonly persistedBotId: string,
  ) {
    super(options);
  }

  override reserve(botId: string, requestedDisplay?: number): DisplayHandle {
    this.reserveCalls.push({ botId, requestedDisplay });
    return super.reserve(botId, requestedDisplay);
  }

  override async prepare(botId: string): Promise<DisplayHandle> {
    const prepared = await super.prepare(botId);
    this.preparedDisplayByBot.set(botId, prepared.display);
    this.prepareCalls.push({ botId, display: prepared.display });
    if (botId === this.persistedBotId && !this.failedPersistedPrepare) {
      this.failedPersistedPrepare = true;
      throw new Error("controlled persisted display preparation failure");
    }
    return prepared;
  }

  override async release(botId: string): Promise<void> {
    this.releaseCalls.push({
      botId,
      display: this.preparedDisplayByBot.get(botId) ?? this.display(botId)?.display ?? null,
    });
    await super.release(botId);
  }

  override async rollback(botId: string, display?: number): Promise<void> {
    this.rollbackCalls.push({ botId, display });
    await super.rollback(botId, display);
  }
}

type ControlledAttachmentStage = "reserve" | "readiness" | "commit";

class RetryableStageFailureComputer extends MemoryComputerRuntime {
  override readonly requiresReadiness: boolean;
  readonly reserveCalls: Array<{ botId: string; requestedDisplay?: number }> = [];
  readonly releaseCalls: string[] = [];
  private failed = false;

  constructor(
    options: ConstructorParameters<typeof MemoryComputerRuntime>[0],
    private readonly failedBotId: string,
    private readonly failedStage: ControlledAttachmentStage,
  ) {
    super(options);
    this.requiresReadiness = failedStage === "readiness";
  }

  override reserve(botId: string, requestedDisplay?: number): DisplayHandle {
    this.reserveCalls.push({ botId, requestedDisplay });
    if (botId === this.failedBotId && this.failedStage === "reserve" && !this.failed) {
      this.failed = true;
      throw new Error("controlled persisted reserve failure");
    }
    return super.reserve(botId, requestedDisplay);
  }

  override commit(botId: string): DisplayHandle {
    if (botId === this.failedBotId && this.failedStage === "commit" && !this.failed) {
      this.failed = true;
      throw new Error("controlled persisted commit failure");
    }
    return super.commit(botId);
  }

  markReadinessFailureObserved(): void {
    if (this.failedStage === "readiness") this.failed = true;
  }

  override async release(botId: string): Promise<void> {
    this.releaseCalls.push(botId);
    await super.release(botId);
  }
}

class ScreenStateMatrixComputer extends MemoryComputerRuntime {
  readonly attachingStarted: Promise<void>;
  private markAttachingStarted!: () => void;
  private finishAttaching!: () => void;
  private readonly attachingGate: Promise<void>;

  constructor(
    options: ConstructorParameters<typeof MemoryComputerRuntime>[0],
    private readonly attachingBotId: string,
    private readonly unavailableBotId: string,
    private readonly cleanupBotId: string,
  ) {
    super(options);
    this.attachingStarted = new Promise((resolve) => (this.markAttachingStarted = resolve));
    this.attachingGate = new Promise((resolve) => (this.finishAttaching = resolve));
  }

  completeAttaching(): void {
    this.finishAttaching();
  }

  override async prepare(botId: string): Promise<DisplayHandle> {
    if (botId === this.attachingBotId) {
      this.markAttachingStarted();
      await this.attachingGate;
      return super.prepare(botId);
    }
    if (botId === this.unavailableBotId || botId === this.cleanupBotId) {
      throw new Error("controlled state-matrix attachment failure");
    }
    return super.prepare(botId);
  }

  override async release(botId: string): Promise<void> {
    if (botId === this.cleanupBotId) throw new Error("controlled state-matrix cleanup failure");
    await super.release(botId);
  }
}

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

async function login(url: string): Promise<string> {
  const response = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  const cookie = cookieHeader(response);
  assert.ok(cookie);
  return cookie;
}

async function rawUpgrade(url: string, pathname: string, cookie: string): Promise<string> {
  const destination = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(Number(destination.port), destination.hostname);
    let received = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out waiting for Upgrade response"));
    }, 1_000);
    socket.on("connect", () => {
      socket.write(
        `GET ${pathname} HTTP/1.1\r\nHost: ${destination.host}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => (received += chunk.toString("utf8")));
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timeout);
      resolve(received);
    });
  });
}

async function waitForScreenState(
  url: string,
  cookie: string,
  botId: string,
  expected: string,
): Promise<void> {
  // Test-only contention margin for the full runner. Production Screen deadlines stay unchanged.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/bots`, { headers: { cookie } });
    const body = (await response.json()) as { bots?: Array<{ id?: string; screenState?: string }> };
    if (body.bots?.find((bot) => bot.id === botId)?.screenState === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for Screen state ${expected}`);
}

async function cleanupScreenFixture(options: {
  boxClose?: () => Promise<void>;
  servers?: http.Server[];
  paths: string[];
}): Promise<void> {
  // Test-only bound so one failed teardown cannot strand a focused/full runner.
  const cleanupTimeoutMs = 5_000;
  const failures: unknown[] = [];
  const attempt = async (label: string, action: () => Promise<void>): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(action),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out cleaning ${label}`)),
            cleanupTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      failures.push(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  if (options.boxClose) await attempt("Box", options.boxClose);
  for (const [index, server] of (options.servers ?? []).entries()) {
    await attempt(`Screen fixture server ${index + 1}`, async () => {
      server.closeAllConnections();
      server.closeIdleConnections();
      if (!server.listening) return;
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      } finally {
        server.closeAllConnections();
        server.closeIdleConnections();
      }
    });
  }
  for (const path of options.paths) {
    await attempt(`Screen fixture path ${path}`, () => rm(path, { recursive: true, force: true }));
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Screen fixture cleanup failed");
}

test("Screen fixture cleanup closes listeners and removes temp roots after Box shutdown rejects", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "openbot-screen-cleanup-regression-"));
  const server = http.createServer((_req, res) => res.end("fixture"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    await assert.rejects(
      cleanupScreenFixture({
        boxClose: async () => {
          throw new Error("controlled Box shutdown rejection");
        },
        servers: [server],
        paths: [fixtureRoot],
      }),
      /controlled Box shutdown rejection/u,
    );
    assert.equal(server.listening, false, "fixture listener survived rejected Box shutdown");
    await assert.rejects(access(fixtureRoot), { code: "ENOENT" });
  } finally {
    try {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }
});

function seedSchemaOneHome(homeDir: string): {
  bots: Array<{ id: string; channelId: string; messageId: string; sessionId: string }>;
  groupChannelId: string;
} {
  const database = new DatabaseSync(join(homeDir, "talk.sqlite"));
  database.exec(`
    PRAGMA foreign_keys = ON;
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
      kind TEXT NOT NULL CHECK (kind IN ('direct', 'group', 'bot-to-bot')),
      title TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE channel_members (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      member_kind TEXT NOT NULL CHECK (member_kind IN ('user', 'bot')),
      member_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (channel_id, member_kind, member_id)
    );
    CREATE TABLE messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'text',
      sender_kind TEXT NOT NULL CHECK (sender_kind IN ('user', 'bot')),
      sender_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reply_to TEXT REFERENCES messages(id)
    );
    CREATE INDEX messages_channel_sequence ON messages(channel_id, sequence);
    CREATE TABLE reactions (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'bot')),
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (message_id, emoji, actor_kind, actor_id)
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      media_type TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE deliveries (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('user', 'bot')),
      recipient_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('sent', 'delivered', 'read')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (message_id, recipient_kind, recipient_id)
    );
    CREATE TABLE bot_channel_state (
      bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      harness_id TEXT,
      session_id TEXT,
      PRIMARY KEY (bot_id, channel_id)
    );
    PRAGMA user_version = 1;
  `);
  const insertBot = database.prepare(
    "INSERT INTO bots (id, name, color, shape, harness, created_at) VALUES (?, ?, ?, ?, 'codex', ?)",
  );
  const insertChannel = database.prepare(
    "INSERT INTO channels (id, kind, title, created_at) VALUES (?, ?, ?, ?)",
  );
  const insertMember = database.prepare(
    "INSERT INTO channel_members (channel_id, member_kind, member_id, position) VALUES (?, ?, ?, ?)",
  );
  const insertState = database.prepare(
    "INSERT INTO bot_channel_state (bot_id, channel_id, harness_id, session_id) VALUES (?, ?, 'codex', ?)",
  );
  const insertMessage = database.prepare(
    "INSERT INTO messages (id, channel_id, kind, sender_kind, sender_id, text, created_at) VALUES (?, ?, 'text', 'user', ?, ?, ?)",
  );
  const insertDelivery = database.prepare(
    "INSERT INTO deliveries (message_id, recipient_kind, recipient_id, state, updated_at) VALUES (?, 'bot', ?, 'read', ?)",
  );
  const shapes = ["capsule", "rounded-cube", "diamond", "bean", "shield"];
  const bots = Array.from({ length: 9 }, (_, index) => {
    const id = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const sessionId = `legacy-session-${index + 1}`;
    const createdAt = `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`;
    insertBot.run(id, `Legacy ${index + 1}`, `#00000${index}`, shapes[index % shapes.length], createdAt);
    insertChannel.run(channelId, "direct", null, createdAt);
    insertMember.run(channelId, "user", HUMAN_MEMBER_ID, 0);
    insertMember.run(channelId, "bot", id, 1);
    insertState.run(id, channelId, sessionId);
    insertMessage.run(messageId, channelId, HUMAN_MEMBER_ID, `legacy transcript ${index + 1}`, createdAt);
    insertDelivery.run(messageId, id, createdAt);
    return { id, channelId, messageId, sessionId };
  });
  const groupChannelId = crypto.randomUUID();
  insertChannel.run(groupChannelId, "group", "Legacy group", "2026-01-01T00:01:00.000Z");
  insertMember.run(groupChannelId, "user", HUMAN_MEMBER_ID, 0);
  insertMember.run(groupChannelId, "bot", bots[0]!.id, 1);
  insertMember.run(groupChannelId, "bot", bots[1]!.id, 2);
  insertState.run(bots[0]!.id, groupChannelId, "legacy-group-session-1");
  insertState.run(bots[1]!.id, groupChannelId, "legacy-group-session-2");
  database.close();
  return { bots, groupChannelId };
}

function rebuildBotsAsLegacyVersionThree(homeDir: string): void {
  const database = new DatabaseSync(join(homeDir, "talk.sqlite"), { enableForeignKeyConstraints: false });
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE bots_v3 (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      shape TEXT NOT NULL,
      harness TEXT,
      config_mode TEXT NOT NULL DEFAULT 'isolated',
      display INTEGER NOT NULL CHECK (display BETWEEN 1 AND 8),
      created_at TEXT NOT NULL
    );
    INSERT INTO bots_v3 (id, name, color, shape, harness, config_mode, display, created_at)
      SELECT id, name, color, shape, harness, config_mode, display, created_at FROM bots;
    DROP TABLE bots;
    ALTER TABLE bots_v3 RENAME TO bots;
    CREATE UNIQUE INDEX bots_display_unique ON bots(display);
    DROP TABLE app_settings;
    DROP TABLE channel_reads;
    DROP INDEX messages_channel_activity;
    ALTER TABLE channels DROP COLUMN activity_sequence;
    ALTER TABLE messages DROP COLUMN card_json;
    ALTER TABLE messages DROP COLUMN activity_at;
    ALTER TABLE messages DROP COLUMN activity_sequence;
    ALTER TABLE messages DROP COLUMN revision;
    PRAGMA user_version = 3;
    COMMIT;
  `);
  database.close();
}

test("persisted Screen prepare failure does not prevent authenticated Talk from serving durable state", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-screen-recovery-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-screen-recovery-pwa-"));
  const botId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const workspaceDir = defaultWorkspaceDir(homeDir);
  let box: RunningBox | undefined;

  try {
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: botId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: "codex",
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      channelId,
    );
    home.appendMessage(channelId, {
      id: messageId,
      role: "user",
      text: "persisted transcript survives Screen recovery",
      createdAt: "2026-01-01T00:00:01.000Z",
      senderId: HUMAN_MEMBER_ID,
      recipientBotId: botId,
      receipt: "sent",
    });
    home.setSessionId(botId, channelId, "persisted-session-id");
    home.close();
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, "AGENTS.md"), "Persisted All Bots setting\n");

    box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer: new PrepareFailingComputer(join(homeDir, "cookies"), botId),
    });

    const cookie = await login(box.url);
    const [botsResponse, channelsResponse, messagesResponse, settingsResponse] = await Promise.all([
      fetch(`${box.url}/api/bots`, { headers: { cookie } }),
      fetch(`${box.url}/api/channels`, { headers: { cookie } }),
      fetch(`${box.url}/api/bots/${botId}/messages`, { headers: { cookie } }),
      fetch(`${box.url}/api/agents`, { headers: { cookie } }),
    ]);
    assert.equal(botsResponse.status, 200);
    assert.equal(channelsResponse.status, 200);
    assert.equal(messagesResponse.status, 200);
    assert.equal(settingsResponse.status, 200);

    const bots = (await botsResponse.json()) as { bots?: Array<{ id?: string; name?: string }> };
    const channels = (await channelsResponse.json()) as { channels?: Array<{ id?: string }> };
    const messages = (await messagesResponse.json()) as { messages?: Array<{ id?: string; text?: string }> };
    const settings = (await settingsResponse.json()) as { text?: string };
    assert.deepEqual(bots.bots?.map((bot) => [bot.id, bot.name]), [[botId, "Ada"]]);
    assert.ok(channels.channels?.some((channel) => channel.id === channelId));
    assert.deepEqual(messages.messages?.map((message) => [message.id, message.text]), [
      [messageId, "persisted transcript survives Screen recovery"],
    ]);
    assert.equal(settings.text, "Persisted All Bots setting\n");

    const reopened = new HomeStore(homeDir);
    assert.equal(reopened.getSessionId(botId, channelId), "persisted-session-id");
    reopened.close();
  } finally {
    await box?.close();
    await rm(homeDir, { recursive: true, force: true });
    await rm(pwaDir, { recursive: true, force: true });
  }
});

test("new Bot creation skips a display durably owned by an unavailable persisted Bot", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-durable-display-create-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-durable-display-create-pwa-"));
  const persistedBotId = crypto.randomUUID();
  const persistedChannelId = crypto.randomUUID();
  const computer = new DurableDisplayCreateComputer(
    {
      cookiesDir: join(homeDir, "cookies"),
      upstreams: ["http://127.0.0.1:16901", "http://127.0.0.1:16902"],
    },
    persistedBotId,
  );
  let box: RunningBox | undefined;

  try {
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: persistedBotId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      persistedChannelId,
    );
    home.close();

    box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer,
    });
    const cookie = await login(box.url);
    await waitForScreenState(box.url, cookie, persistedBotId, "unavailable");
    assert.deepEqual(
      computer.releaseCalls,
      [{ botId: persistedBotId, display: 1 }],
    );
    assert.equal(computer.display(persistedBotId), undefined);

    const create = await fetch(`${box.url}/api/bots`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Ben" }),
    });
    const newReservation = computer.reserveCalls.find((call) => call.botId !== persistedBotId);
    assert.ok(newReservation);
    assert.equal(newReservation.requestedDisplay, 2);
    assert.equal(create.status, 201);
    const created = (await create.json()) as {
      id?: string;
      name?: string;
      display?: number | null;
      screenState?: string;
    };
    assert.equal(created.id, newReservation.botId);
    assert.deepEqual(
      {
        name: created.name,
        display: created.display,
        screenState: created.screenState,
      },
      { name: "Ben", display: 2, screenState: "ready" },
    );
    assert.deepEqual(
      computer.prepareCalls.filter((call) => call.botId === created.id),
      [{ botId: created.id, display: 2 }],
    );
    assert.deepEqual(
      computer.releaseCalls.filter((call) => call.botId === created.id),
      [],
    );
    assert.deepEqual(
      computer.rollbackCalls.filter((call) => call.botId === created.id),
      [],
    );

    const botsResponse = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
    assert.equal(botsResponse.status, 200);
    const bots = (await botsResponse.json()) as {
      bots?: Array<{ id?: string; name?: string; display?: number | null; screenState?: string }>;
    };
    assert.deepEqual(
      bots.bots?.map((bot) => [bot.id, bot.name, bot.display, bot.screenState]),
      [
        [persistedBotId, "Ada", 1, "unavailable"],
        [created.id, "Ben", 2, "ready"],
      ],
    );

    const persisted = new HomeStore(homeDir);
    try {
      assert.equal(persisted.botDisplay(persistedBotId), 1);
      assert.equal(persisted.botDisplay(created.id!), 2);
      const directBotIds = persisted.listChannels()
        .filter((channel) => channel.kind === "direct")
        .flatMap((channel) => channel.members)
        .filter((member) => member.kind === "bot")
        .map((member) => member.id);
      assert.deepEqual(directBotIds, [persistedBotId, created.id]);
    } finally {
      persisted.close();
    }
  } finally {
    await box?.close().catch(() => undefined);
    await rm(homeDir, { recursive: true, force: true });
    await rm(pwaDir, { recursive: true, force: true });
  }
});

test("persisted Screen reserve, readiness, and commit failures stay chat-available and retry exact displays", async (t) => {
  for (const stage of ["reserve", "readiness", "commit"] as const) {
    await t.test(stage, async () => {
      const homeDir = await mkdtemp(join(tmpdir(), `openbot-${stage}-recovery-home-`));
      const pwaDir = await mkdtemp(join(tmpdir(), `openbot-${stage}-recovery-pwa-`));
      const workspaceDir = defaultWorkspaceDir(homeDir);
      const botId = crypto.randomUUID();
      const siblingId = crypto.randomUUID();
      const channelId = crypto.randomUUID();
      const siblingChannelId = crypto.randomUUID();
      const messageId = crypto.randomUUID();
      const upstreamHits: string[][] = [[], []];
      let readinessFailed = false;
      const upstreams = [0, 1].map((index) => http.createServer((req, res) => {
        upstreamHits[index]!.push(`${req.method ?? "GET"}:${req.url ?? "/"}`);
        const rejectReadiness = stage === "readiness" && index === 0 && !readinessFailed;
        if (rejectReadiness) readinessFailed = true;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(rejectReadiness
          ? "<html><title>Not Kasm</title></html>"
          : "<html><title>KasmVNC</title></html>");
      }));
      let box: RunningBox | undefined;

      try {
        for (const upstream of upstreams) {
          await new Promise<void>((resolve, reject) => {
            upstream.once("error", reject);
            upstream.listen(0, "127.0.0.1", () => resolve());
          });
        }
        const ports = upstreams.map((upstream) => {
          const address = upstream.address();
          if (!address || typeof address === "string") throw new Error("Screen stage fixture failed to bind");
          return address.port;
        });
        await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
        const home = new HomeStore(homeDir);
        home.createBot(
          {
            id: botId,
            name: `Failed ${stage}`,
            color: "#ff3b5c",
            shape: "capsule",
            harness: "codex",
            configMode: "isolated",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          channelId,
        );
        home.createBot(
          {
            id: siblingId,
            name: `Ready sibling ${stage}`,
            color: "#1e90ff",
            shape: "rounded-cube",
            harness: "codex",
            configMode: "isolated",
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          siblingChannelId,
        );
        home.appendMessage(channelId, {
          id: messageId,
          role: "user",
          text: `durable ${stage} transcript`,
          createdAt: "2026-01-01T00:00:02.000Z",
          senderId: HUMAN_MEMBER_ID,
          recipientBotId: botId,
          receipt: "sent",
        });
        home.setSessionId(botId, channelId, `durable-${stage}-session`);
        home.close();
        await mkdir(workspaceDir, { recursive: true });
        await writeFile(join(workspaceDir, "AGENTS.md"), `durable ${stage} setting\n`);

        const computer = new RetryableStageFailureComputer(
          {
            cookiesDir: join(homeDir, "cookies"),
            upstreams: ports.map((port) => `http://127.0.0.1:${port}`),
          },
          botId,
          stage,
        );
        box = await startBox({
          password: PASSWORD,
          pwaDir,
          host: "127.0.0.1",
          port: 0,
          homeDir,
          computer,
        });
        const cookie = await login(box.url);
        await Promise.all([
          waitForScreenState(box.url, cookie, botId, "unavailable"),
          waitForScreenState(box.url, cookie, siblingId, "ready"),
        ]);

        const [botsResponse, channelsResponse, messagesResponse, settingsResponse, computerResponse] =
          await Promise.all([
            fetch(`${box.url}/api/bots`, { headers: { cookie } }),
            fetch(`${box.url}/api/channels`, { headers: { cookie } }),
            fetch(`${box.url}/api/bots/${botId}/messages`, { headers: { cookie } }),
            fetch(`${box.url}/api/agents`, { headers: { cookie } }),
            fetch(`${box.url}/api/computer?botId=${encodeURIComponent(botId)}`, { headers: { cookie } }),
          ]);
        assert.deepEqual(
          [botsResponse, channelsResponse, messagesResponse, settingsResponse, computerResponse]
            .map((response) => response.status),
          [200, 200, 200, 200, 200],
        );
        const bots = (await botsResponse.json()) as {
          bots?: Array<{
            id?: string;
            display?: number | null;
            screenState?: string;
            screenAttempt?: string;
            screenError?: unknown;
          }>;
        };
        const failedBot = bots.bots?.find((bot) => bot.id === botId);
        const sibling = bots.bots?.find((bot) => bot.id === siblingId);
        assert.deepEqual(
          {
            display: failedBot?.display,
            screenState: failedBot?.screenState,
            screenError: failedBot?.screenError,
          },
          {
            display: 1,
            screenState: "unavailable",
            screenError: {
              stage,
              code: stage === "readiness" ? "SCREEN_NOT_READY" : "SCREEN_ATTACHMENT_FAILED",
              message: stage === "readiness"
                ? "Screen application did not become ready."
                : `Screen attachment failed during ${stage}.`,
            },
          },
        );
        assert.deepEqual(
          { id: sibling?.id, display: sibling?.display, screenState: sibling?.screenState },
          { id: siblingId, display: 2, screenState: "ready" },
        );
        assert.equal(typeof failedBot?.screenAttempt, "string");

        const channels = (await channelsResponse.json()) as { channels?: Array<{ id?: string }> };
        const messages = (await messagesResponse.json()) as { messages?: Array<{ id?: string; text?: string }> };
        const settings = (await settingsResponse.json()) as { text?: string };
        const unavailableComputer = (await computerResponse.json()) as {
          path?: string | null;
          ready?: boolean;
          screenState?: string;
          screenAttempt?: string;
          screenError?: unknown;
          display?: number | null;
        };
        assert.deepEqual(new Set(channels.channels?.map((channel) => channel.id)), new Set([channelId, siblingChannelId]));
        assert.deepEqual(messages.messages?.map((message) => [message.id, message.text]), [
          [messageId, `durable ${stage} transcript`],
        ]);
        assert.equal(settings.text, `durable ${stage} setting\n`);
        assert.deepEqual(
          {
            path: unavailableComputer.path,
            ready: unavailableComputer.ready,
            screenState: unavailableComputer.screenState,
            screenAttempt: unavailableComputer.screenAttempt,
            screenError: unavailableComputer.screenError,
            display: unavailableComputer.display,
          },
          {
            path: null,
            ready: false,
            screenState: "unavailable",
            screenAttempt: failedBot?.screenAttempt,
            screenError: failedBot?.screenError,
            display: 1,
          },
        );
        const persistedBeforeRetry = new HomeStore(homeDir);
        assert.equal(persistedBeforeRetry.getSessionId(botId, channelId), `durable-${stage}-session`);
        assert.equal(persistedBeforeRetry.botDisplay(botId), 1);
        persistedBeforeRetry.close();

        const hitsBeforeDeniedProxy = upstreamHits.map((hits) => [...hits]);
        assert.equal((await fetch(`${box.url}/screen/${botId}/`, { headers: { cookie } })).status, 503);
        assert.match(
          await rawUpgrade(box.url, `/screen/${botId}/websockify`, cookie),
          /^HTTP\/1\.1 503 Service Unavailable/u,
        );
        assert.deepEqual(upstreamHits, hitsBeforeDeniedProxy);

        const retryResponse = await fetch(`${box.url}/api/computer/retry`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ botId, screenAttempt: failedBot?.screenAttempt }),
        });
        assert.equal(retryResponse.status, 202);
        const acceptedRetry = (await retryResponse.json()) as Record<string, unknown>;
        assert.deepEqual(
          {
            botId: acceptedRetry.botId,
            path: acceptedRetry.path,
            ready: acceptedRetry.ready,
            screenState: acceptedRetry.screenState,
            display: acceptedRetry.display,
          },
          { botId, path: null, ready: false, screenState: "attaching", display: 1 },
        );
        for (const unrelated of ["messages", "permission", "needsYou", "name", "harness", "eyes"]) {
          assert.equal(Object.hasOwn(acceptedRetry, unrelated), false, `retry payload included ${unrelated}`);
        }
        await waitForScreenState(box.url, cookie, botId, "ready");

        const [retriedBotResponse, retriedMessagesResponse, retriedComputerResponse] = await Promise.all([
          fetch(`${box.url}/api/bots/${botId}`, { headers: { cookie } }),
          fetch(`${box.url}/api/bots/${botId}/messages`, { headers: { cookie } }),
          fetch(`${box.url}/api/computer?botId=${encodeURIComponent(botId)}`, { headers: { cookie } }),
        ]);
        const retriedBot = (await retriedBotResponse.json()) as {
          id?: string;
          display?: number | null;
          screenState?: string;
        };
        const retriedMessages = (await retriedMessagesResponse.json()) as {
          messages?: Array<{ id?: string; text?: string }>;
        };
        const retriedComputer = (await retriedComputerResponse.json()) as {
          path?: string | null;
          ready?: boolean;
          screenState?: string;
          display?: number | null;
        };
        assert.deepEqual(retriedBot, {
          ...(retriedBot as object),
          id: botId,
          display: 1,
          screenState: "ready",
        });
        assert.deepEqual(retriedMessages.messages?.map((message) => [message.id, message.text]), [
          [messageId, `durable ${stage} transcript`],
        ]);
        assert.deepEqual(
          {
            path: retriedComputer.path,
            ready: retriedComputer.ready,
            screenState: retriedComputer.screenState,
            display: retriedComputer.display,
          },
          { path: `/screen/${botId}/`, ready: true, screenState: "ready", display: 1 },
        );
        assert.equal(computer.display(botId)?.display, 1);
        assert.equal(computer.display(siblingId)?.display, 2);
        assert.deepEqual(
          computer.reserveCalls.filter((call) => call.botId === botId),
          [
            { botId, requestedDisplay: 1 },
            { botId, requestedDisplay: 1 },
          ],
        );
        assert.deepEqual(
          computer.releaseCalls,
          stage === "reserve" ? [] : [botId],
        );
        const persistedAfterRetry = new HomeStore(homeDir);
        assert.equal(persistedAfterRetry.getSessionId(botId, channelId), `durable-${stage}-session`);
        assert.equal(persistedAfterRetry.botDisplay(botId), 1);
        persistedAfterRetry.close();
      } finally {
        await box?.close().catch(() => undefined);
        for (const upstream of upstreams) {
          upstream.closeAllConnections();
          if (upstream.listening) await new Promise<void>((resolve) => upstream.close(() => resolve()));
        }
        await rm(homeDir, { recursive: true, force: true });
        await rm(pwaDir, { recursive: true, force: true });
      }
    });
  }
});

test("retrying one failed Screen does not invalidate a sibling attachment already in flight", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-per-bot-screen-attempt-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-per-bot-screen-attempt-pwa-"));
  const failedBotId = crypto.randomUUID();
  const pendingBotId = crypto.randomUUID();
  const computer = new RetryWhileSiblingPendingComputer({
    cookiesDir: join(homeDir, "cookies"),
    upstreams: ["http://127.0.0.1:16901", "http://127.0.0.1:16902"],
  }, failedBotId, pendingBotId);
  let box: RunningBox | undefined;

  try {
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: failedBotId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      crypto.randomUUID(),
    );
    home.createBot(
      {
        id: pendingBotId,
        name: "Ben",
        color: "#00a878",
        shape: "rounded-cube",
        harness: null,
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      crypto.randomUUID(),
    );
    home.close();

    box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer,
    });
    await computer.siblingPrepareStarted;
    const cookie = await login(box.url);
    await waitForScreenState(box.url, cookie, failedBotId, "unavailable");
    const failed = await fetch(
      `${box.url}/api/computer?botId=${encodeURIComponent(failedBotId)}`,
      { headers: { cookie } },
    ).then((response) => response.json()) as { screenAttempt?: string };
    const pendingBeforeRetry = await fetch(
      `${box.url}/api/computer?botId=${encodeURIComponent(pendingBotId)}`,
      { headers: { cookie } },
    ).then((response) => response.json()) as { screenAttempt?: string; screenState?: string };
    assert.equal(pendingBeforeRetry.screenState, "attaching");
    assert.equal(typeof failed.screenAttempt, "string");

    const retry = await fetch(`${box.url}/api/computer/retry`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ botId: failedBotId, screenAttempt: failed.screenAttempt }),
    });
    assert.equal(retry.status, 202);
    await waitForScreenState(box.url, cookie, failedBotId, "ready");
    const pendingAfterRetry = await fetch(
      `${box.url}/api/computer?botId=${encodeURIComponent(pendingBotId)}`,
      { headers: { cookie } },
    ).then((response) => response.json()) as { screenAttempt?: string; screenState?: string };
    assert.deepEqual({
      screenAttempt: pendingAfterRetry.screenAttempt,
      screenState: pendingAfterRetry.screenState,
    }, {
      screenAttempt: pendingBeforeRetry.screenAttempt,
      screenState: "attaching",
    });

    computer.completeSiblingPrepare();
    await waitForScreenState(box.url, cookie, pendingBotId, "ready");
    assert.equal(computer.display(failedBotId)?.display, 1);
    assert.equal(computer.display(pendingBotId)?.display, 2);
    assert.deepEqual(computer.reserveCalls, [
      { botId: failedBotId, requestedDisplay: 1 },
      { botId: pendingBotId, requestedDisplay: 2 },
      { botId: failedBotId, requestedDisplay: 1 },
    ]);
    assert.deepEqual(computer.releaseCalls, []);
  } finally {
    computer.completeSiblingPrepare();
    await box?.close().catch(() => undefined);
    await rm(homeDir, { recursive: true, force: true });
    await rm(pwaDir, { recursive: true, force: true });
  }
});

test("an unavailable persisted Screen exposes one truthful state and never falls back to the root Screen", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-unavailable-screen-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-unavailable-screen-pwa-"));
  const botId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  const rootHits: string[] = [];
  const root = http.createServer((req, res) => {
    rootHits.push(`http:${req.url ?? "/"}`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><title>KasmVNC</title></html>");
  });
  root.on("upgrade", (req, socket) => {
    rootHits.push(`upgrade:${req.url ?? "/"}`);
    socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: close\r\n\r\n");
  });
  let box: RunningBox | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      root.once("error", reject);
      root.listen(0, "127.0.0.1", () => resolve());
    });
    const address = root.address();
    if (!address || typeof address === "string") throw new Error("root Screen fixture failed to bind");
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: botId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      channelId,
    );
    home.close();
    const computer = new PrepareFailingComputer(
      join(homeDir, "cookies"),
      botId,
      [`http://127.0.0.1:${address.port}`],
    );

    box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer,
      kasmUser: "kasm",
      kasmPassword: "kasm-secret",
    });
    const cookie = await login(box.url);
    const botsResponse = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
    const bots = (await botsResponse.json()) as {
      bots?: Array<{ id?: string; display?: number | null; screenState?: string }>;
    };
    assert.deepEqual(bots.bots?.map((bot) => ({
      id: bot.id,
      display: bot.display,
      screenState: bot.screenState,
    })), [{ id: botId, display: 1, screenState: "unavailable" }]);

    const computerResponse = await fetch(
      `${box.url}/api/computer?botId=${encodeURIComponent(botId)}`,
      { headers: { cookie } },
    );
    assert.equal(computerResponse.status, 200);
    const computerBody = (await computerResponse.json()) as {
      path?: string | null;
      reachable?: boolean;
      ready?: boolean;
      display?: number | null;
      screenState?: string;
      ownership?: string;
      ownershipEpoch?: string;
    };
    assert.deepEqual(
      {
        path: computerBody.path,
        reachable: computerBody.reachable,
        ready: computerBody.ready,
        display: computerBody.display,
        screenState: computerBody.screenState,
      },
      { path: null, reachable: false, ready: false, display: 1, screenState: "unavailable" },
    );
    assert.equal(computerBody.ownership, "unknown");
    assert.equal(typeof computerBody.ownershipEpoch, "string");

    const release = await fetch(`${box.url}/api/computer/zoom`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ botId, zoom: false }),
    });
    assert.equal(release.status, 200);
    const released = (await release.json()) as {
      path?: string | null;
      ready?: boolean;
      screenState?: string;
      ownership?: string;
    };
    assert.deepEqual(
      {
        path: released.path,
        ready: released.ready,
        screenState: released.screenState,
        ownership: released.ownership,
      },
      { path: null, ready: false, screenState: "unavailable", ownership: "unknown" },
    );

    const grant = await fetch(`${box.url}/api/computer/zoom`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ botId, zoom: true, ownershipEpoch: computerBody.ownershipEpoch }),
    });
    assert.equal(grant.status, 409);
    const rejectedGrant = (await grant.json()) as {
      code?: string;
      path?: string | null;
      ready?: boolean;
      screenState?: string;
      ownership?: string;
    };
    assert.deepEqual(
      {
        code: rejectedGrant.code,
        path: rejectedGrant.path,
        ready: rejectedGrant.ready,
        screenState: rejectedGrant.screenState,
        ownership: rejectedGrant.ownership,
      },
      {
        code: "SCREEN_UNAVAILABLE",
        path: null,
        ready: false,
        screenState: "unavailable",
        ownership: "unknown",
      },
    );

    const proxied = await fetch(`${box.url}/screen/${botId}/`, { headers: { cookie } });
    assert.equal(proxied.status, 503);
    const upgrade = await rawUpgrade(box.url, `/screen/${botId}/websockify`, cookie);
    assert.match(upgrade, /^HTTP\/1\.1 503 Service Unavailable/u);
    assert.deepEqual(rootHits, []);
  } finally {
    const boxToClose = box;
    await cleanupScreenFixture({
      boxClose: boxToClose ? () => boxToClose.close() : undefined,
      servers: [root],
      paths: [homeDir, pwaDir],
    });
  }
});

test("Computer polling and Screen routing never materialize or serialize the Bot transcript", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-screen-no-transcript-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-screen-no-transcript-pwa-"));
  const botId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  const transcriptSentinel = "TRANSCRIPT-MUST-NOT-ENTER-COMPUTER-STATE";
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><title>KasmVNC</title></html>");
  });
  upstream.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: close\r\n\r\n");
  });
  const originalListMessages = HomeStore.prototype.listMessages;
  let transcriptReads = 0;
  HomeStore.prototype.listMessages = function listMessagesWithCounter(id: string) {
    transcriptReads += 1;
    return originalListMessages.call(this, id);
  };
  let box: RunningBox | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", () => resolve());
    });
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("transcript sentinel fixture failed to bind");
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: botId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: "codex",
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      channelId,
    );
    home.appendMessage(channelId, {
      id: crypto.randomUUID(),
      role: "user",
      text: transcriptSentinel,
      createdAt: "2026-01-01T00:00:01.000Z",
      senderId: HUMAN_MEMBER_ID,
      recipientBotId: botId,
      receipt: "sent",
    });
    home.close();
    box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer: new MemoryComputerRuntime({
        cookiesDir: join(homeDir, "cookies"),
        upstreams: [`http://127.0.0.1:${address.port}`],
      }),
    });
    const cookie = await login(box.url);
    await waitForScreenState(box.url, cookie, botId, "ready");
    assert.equal(transcriptReads, 0, "Kasm registration materialized the Transcript");

    const computerResponse = await fetch(
      `${box.url}/api/computer?botId=${encodeURIComponent(botId)}`,
      { headers: { cookie } },
    );
    assert.equal(computerResponse.status, 200);
    const rawComputer = await computerResponse.text();
    const computer = JSON.parse(rawComputer) as Record<string, unknown>;
    assert.equal(rawComputer.includes(transcriptSentinel), false);
    for (const unrelated of ["messages", "permission", "needsYou", "name", "harness", "eyes"]) {
      assert.equal(Object.hasOwn(computer, unrelated), false, `Computer payload included ${unrelated}`);
    }
    assert.deepEqual(
      {
        path: computer.path,
        botId: computer.botId,
        screenState: computer.screenState,
        display: computer.display,
      },
      { path: `/screen/${botId}/`, botId, screenState: "ready", display: 1 },
    );
    assert.equal((await fetch(`${box.url}/screen/${botId}/`, { headers: { cookie } })).status, 200);
    assert.match(
      await rawUpgrade(box.url, `/screen/${botId}/websockify`, cookie),
      /^HTTP\/1\.1 101 Switching Protocols/u,
    );
    assert.equal(transcriptReads, 0, "Computer or Screen hot path materialized the Transcript");
  } finally {
    HomeStore.prototype.listMessages = originalListMessages;
    await box?.close().catch(() => undefined);
    upstream.closeAllConnections();
    if (upstream.listening) await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(homeDir, { recursive: true, force: true });
    await rm(pwaDir, { recursive: true, force: true });
  }
});

test("every non-ready Screen state stays exact across Computer GET, zoom, HTTP, and Upgrade", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-screen-state-matrix-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-screen-state-matrix-pwa-"));
  const attachingBotId = crypto.randomUUID();
  const unavailableBotId = crypto.randomUUID();
  const cleanupBotId = crypto.randomUUID();
  const unassignedBotId = crypto.randomUUID();
  const readyBotId = crypto.randomUUID();
  const rootHits: string[] = [];
  const root = http.createServer((req, res) => {
    rootHits.push(`http:${req.url ?? "/"}`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><title>KasmVNC</title></html>");
  });
  root.on("upgrade", (req, socket) => {
    rootHits.push(`upgrade:${req.url ?? "/"}`);
    socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: close\r\n\r\n");
  });
  let box: RunningBox | undefined;
  let computer: ScreenStateMatrixComputer | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      root.once("error", reject);
      root.listen(0, "127.0.0.1", () => resolve());
    });
    const address = root.address();
    if (!address || typeof address === "string") throw new Error("Screen state matrix fixture failed to bind");
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const home = new HomeStore(homeDir);
    const stored = [
      [attachingBotId, "Attaching"],
      [unavailableBotId, "Unavailable"],
      [cleanupBotId, "Cleanup"],
      [unassignedBotId, "Unassigned"],
      [readyBotId, "Ready"],
    ] as const;
    for (const [id, name] of stored) {
      home.createBot(
        {
          id,
          name,
          color: "#ff3b5c",
          shape: "capsule",
          harness: null,
          configMode: "isolated",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        crypto.randomUUID(),
      );
    }
    home.close();
    const database = new DatabaseSync(join(homeDir, "talk.sqlite"));
    assert.equal(database.prepare("UPDATE bots SET display = NULL WHERE id = ?").run(unassignedBotId).changes, 1);
    database.close();
    computer = new ScreenStateMatrixComputer(
      {
        cookiesDir: join(homeDir, "cookies"),
        upstreams: Array.from({ length: 5 }, () => `http://127.0.0.1:${address.port}`),
      },
      attachingBotId,
      unavailableBotId,
      cleanupBotId,
    );
    box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer,
      kasmUser: "kasm",
      kasmPassword: "kasm-secret",
    });
    const cookie = await login(box.url);
    await computer.attachingStarted;
    await Promise.all([
      waitForScreenState(box.url, cookie, attachingBotId, "attaching"),
      waitForScreenState(box.url, cookie, unavailableBotId, "unavailable"),
      waitForScreenState(box.url, cookie, cleanupBotId, "cleanup-required"),
      waitForScreenState(box.url, cookie, unassignedBotId, "unassigned"),
      waitForScreenState(box.url, cookie, readyBotId, "ready"),
    ]);

    const cases = [
      {
        botId: attachingBotId,
        state: "attaching",
        display: 1,
        error: null,
        cleanupError: null,
        grantCode: "SCREEN_ATTACHING",
      },
      {
        botId: unavailableBotId,
        state: "unavailable",
        display: 2,
        error: {
          stage: "prepare",
          code: "SCREEN_ATTACHMENT_FAILED",
          message: "Screen attachment failed during prepare.",
        },
        cleanupError: null,
        grantCode: "SCREEN_UNAVAILABLE",
      },
      {
        botId: cleanupBotId,
        state: "cleanup-required",
        display: 3,
        error: {
          stage: "prepare",
          code: "SCREEN_ATTACHMENT_FAILED",
          message: "Screen attachment failed during prepare.",
        },
        cleanupError: {
          code: "SCREEN_CLEANUP_FAILED",
          message: "Screen cleanup did not complete.",
        },
        grantCode: "SCREEN_CLEANUP_REQUIRED",
      },
      {
        botId: unassignedBotId,
        state: "unassigned",
        display: null,
        error: null,
        cleanupError: null,
        grantCode: "SCREEN_UNASSIGNED",
      },
    ] as const;
    const hitsBeforeExplicitStates = [...rootHits];

    for (const expected of cases) {
      const get: Response = await fetch(
        `${box.url}/api/computer?botId=${encodeURIComponent(expected.botId)}`,
        { headers: { cookie } },
      );
      assert.equal(get.status, 200);
      const current = (await get.json()) as Record<string, unknown>;
      assert.equal(typeof current.screenAttempt, "string");
      const exact = {
        path: current.path,
        ready: current.ready,
        botId: current.botId,
        screenState: current.screenState,
        screenAttempt: current.screenAttempt,
        screenError: current.screenError,
        screenCleanupError: current.screenCleanupError,
        display: current.display,
        ownership: current.ownership,
      };
      assert.deepEqual(exact, {
        path: null,
        ready: false,
        botId: expected.botId,
        screenState: expected.state,
        screenAttempt: current.screenAttempt,
        screenError: expected.error,
        screenCleanupError: expected.cleanupError,
        display: expected.display,
        ownership: "unknown",
      });

      const release: Response = await fetch(`${box.url}/api/computer/zoom`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ botId: expected.botId, zoom: false }),
      });
      assert.equal(release.status, 200);
      const released = (await release.json()) as Record<string, unknown>;
      assert.deepEqual({
        path: released.path,
        ready: released.ready,
        botId: released.botId,
        screenState: released.screenState,
        screenAttempt: released.screenAttempt,
        screenError: released.screenError,
        screenCleanupError: released.screenCleanupError,
        display: released.display,
        ownership: released.ownership,
      }, exact);

      const grant: Response = await fetch(`${box.url}/api/computer/zoom`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          botId: expected.botId,
          zoom: true,
          ownershipEpoch: current.ownershipEpoch,
        }),
      });
      assert.equal(grant.status, 409);
      const rejected = (await grant.json()) as Record<string, unknown>;
      assert.equal(rejected.code, expected.grantCode);
      assert.deepEqual({
        path: rejected.path,
        ready: rejected.ready,
        botId: rejected.botId,
        screenState: rejected.screenState,
        screenAttempt: rejected.screenAttempt,
        screenError: rejected.screenError,
        screenCleanupError: rejected.screenCleanupError,
        display: rejected.display,
        ownership: rejected.ownership,
      }, exact);

      assert.equal((await fetch(`${box.url}/screen/${expected.botId}/`, { headers: { cookie } })).status, 503);
      assert.match(
        await rawUpgrade(box.url, `/screen/${expected.botId}/websockify`, cookie),
        /^HTTP\/1\.1 503 Service Unavailable/u,
      );
      assert.deepEqual(rootHits, hitsBeforeExplicitStates);
    }

    const cleanup = cases[2];
    const cleanupState = await fetch(
      `${box.url}/api/computer?botId=${encodeURIComponent(cleanup.botId)}`,
      { headers: { cookie } },
    ).then((response) => response.json()) as { screenAttempt?: string };
    const cleanupRetry = await fetch(`${box.url}/api/computer/retry`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ botId: cleanup.botId, screenAttempt: cleanupState.screenAttempt }),
    });
    assert.equal(cleanupRetry.status, 409);
    assert.equal(((await cleanupRetry.json()) as { code?: string }).code, "SCREEN_CLEANUP_REQUIRED");
    assert.deepEqual(rootHits, hitsBeforeExplicitStates);
  } finally {
    computer?.completeAttaching();
    await box?.close().catch(() => undefined);
    root.closeAllConnections();
    if (root.listening) await new Promise<void>((resolve) => root.close(() => resolve()));
    await rm(homeDir, { recursive: true, force: true });
    await rm(pwaDir, { recursive: true, force: true });
  }
});

test("Talk binds and authenticates while a persisted Screen attachment is still pending", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-attaching-screen-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-attaching-screen-pwa-"));
  const botId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  const computer = new DeferredPrepareComputer(join(homeDir, "cookies"));
  let box: RunningBox | undefined;
  let startResult: Promise<RunningBox> | undefined;

  try {
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: botId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      channelId,
    );
    home.close();

    startResult = startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer,
    });
    await computer.prepareStarted;
    box = await Promise.race([
      startResult,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Talk did not bind while Screen attachment was pending")), 500);
      }),
    ]);

    const cookie = await login(box.url);
    const botsResponse = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
    const bots = (await botsResponse.json()) as {
      bots?: Array<{
        id?: string;
        display?: number | null;
        screenState?: string;
        computerOwnership?: string;
      }>;
    };
    assert.deepEqual(bots.bots?.map((bot) => ({
      id: bot.id,
      display: bot.display,
      screenState: bot.screenState,
      computerOwnership: bot.computerOwnership,
    })), [{ id: botId, display: 1, screenState: "attaching", computerOwnership: "unknown" }]);

    computer.completePrepare();
    await waitForScreenState(box.url, cookie, botId, "ready");
  } finally {
    computer.completePrepare();
    if (!box && startResult) box = await startResult.catch(() => undefined);
    await box?.close();
    await rm(homeDir, { recursive: true, force: true });
    await rm(pwaDir, { recursive: true, force: true });
  }
});

test("persisted attaching root Screen stays private until its exact Bot is confirmed view-only", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-root-screen-gate-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-root-screen-gate-pwa-"));
  const botId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const publicHits: string[] = [];
  const registrationHits: string[] = [];
  let registrationResponse: http.ServerResponse | undefined;
  let registrationStartedResolve!: () => void;
  const registrationStarted = new Promise<void>((resolve) => (registrationStartedResolve = resolve));
  const sentinel = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/update_user?")) {
      registrationHits.push(req.url);
      registrationResponse = res;
      registrationStartedResolve();
      return;
    }
    publicHits.push(`${req.method ?? "GET"}:${req.url ?? "/"}`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><title>KasmVNC</title></html>");
  });
  sentinel.on("upgrade", (req, socket) => {
    publicHits.push(`UPGRADE:${req.url ?? "/"}`);
    socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: close\r\n\r\n");
  });
  let box: RunningBox | undefined;
  let computer: DeferredPrepareComputer | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      sentinel.once("error", reject);
      sentinel.listen(0, "127.0.0.1", () => resolve());
    });
    const address = sentinel.address();
    if (!address || typeof address === "string") throw new Error("root Screen sentinel failed to bind");
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: botId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      crypto.randomUUID(),
    );
    home.close();
    computer = new DeferredPrepareComputer(
      join(homeDir, "cookies"),
      [`http://127.0.0.1:${address.port}`],
    );
    box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer,
      kasmUser: "kasm",
      kasmPassword: "kasm-secret",
    });
    await computer.prepareStarted;
    const cookie = await login(box.url);
    const chat = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
    assert.equal(chat.status, 200);

    const pendingRoot = await fetch(`${box.url}/api/computer`, { headers: { cookie } });
    assert.equal(pendingRoot.status, 200);
    const pendingRootBody = (await pendingRoot.json()) as {
      path?: string | null;
      ready?: boolean;
      ownership?: string;
    };
    assert.deepEqual(
      { path: pendingRootBody.path, ready: pendingRootBody.ready, ownership: pendingRootBody.ownership },
      { path: null, ready: false, ownership: "unknown" },
    );
    assert.equal((await fetch(`${box.url}/screen/`, { headers: { cookie } })).status, 503);
    assert.match(
      await rawUpgrade(box.url, "/screen/websockify", cookie),
      /^HTTP\/1\.1 503 Service Unavailable/u,
    );
    assert.deepEqual(publicHits, []);

    computer.completePrepare();
    await registrationStarted;
    const registeringRoot = await fetch(`${box.url}/api/computer`, { headers: { cookie } });
    const registeringRootBody = (await registeringRoot.json()) as {
      path?: string | null;
      ready?: boolean;
      ownership?: string;
    };
    assert.deepEqual(
      {
        path: registeringRootBody.path,
        ready: registeringRootBody.ready,
        ownership: registeringRootBody.ownership,
      },
      { path: null, ready: false, ownership: "unknown" },
    );
    assert.equal((await fetch(`${box.url}/screen/`, { headers: { cookie } })).status, 503);
    assert.deepEqual(publicHits, []);
    assert.equal(registrationHits.length, 1);
    assert.equal(new URL(registrationHits[0]!, "http://kasm").searchParams.get("write"), "false");

    registrationResponse?.writeHead(200, { "content-type": "text/plain" });
    registrationResponse?.end("ok");
    await waitForScreenState(box.url, cookie, botId, "ready");
    const readyRoot = await fetch(`${box.url}/api/computer`, { headers: { cookie } });
    const readyRootBody = (await readyRoot.json()) as {
      path?: string | null;
      ready?: boolean;
      ownership?: string;
      display?: number | null;
    };
    assert.deepEqual(
      {
        path: readyRootBody.path,
        ready: readyRootBody.ready,
        ownership: readyRootBody.ownership,
        display: readyRootBody.display,
      },
      { path: "/screen/", ready: true, ownership: "view-only", display: 1 },
    );
    const rootScreen = await fetch(`${box.url}/screen/`, { headers: { cookie } });
    assert.equal(rootScreen.status, 200);
    assert.match(await rootScreen.text(), /KasmVNC/u);
    assert.match(
      await rawUpgrade(box.url, "/screen/websockify", cookie),
      /^HTTP\/1\.1 101 Switching Protocols/u,
    );
    const explicit = await fetch(
      `${box.url}/api/computer?botId=${encodeURIComponent(botId)}`,
      { headers: { cookie } },
    ).then((response) => response.json()) as { path?: string | null; ownership?: string; display?: number | null };
    assert.deepEqual(
      { path: explicit.path, ownership: explicit.ownership, display: explicit.display },
      { path: `/screen/${botId}/`, ownership: "view-only", display: 1 },
    );

    const unknownBotId = crypto.randomUUID();
    assert.notEqual(unknownBotId, botId);
    const hitsBeforeUnknownBot = publicHits.length;
    const unknownBotScreen = await fetch(
      `${box.url}/screen/${unknownBotId}/assets/client.js`,
      { headers: { cookie } },
    );
    assert.equal(unknownBotScreen.status, 404);
    assert.match(
      await rawUpgrade(box.url, `/screen/${unknownBotId}/websockify`, cookie),
      /^HTTP\/1\.1 404 Not Found/u,
    );
    assert.equal(publicHits.length, hitsBeforeUnknownBot);

    for (const uppercaseBotId of [
      botId.toUpperCase(),
      "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB",
    ]) {
      assert.equal(
        (await fetch(`${box.url}/screen/${uppercaseBotId}/assets/client.js`, { headers: { cookie } })).status,
        404,
      );
      assert.match(
        await rawUpgrade(box.url, `/screen/${uppercaseBotId}/websockify`, cookie),
        /^HTTP\/1\.1 404 Not Found/u,
      );
      assert.equal(publicHits.length, hitsBeforeUnknownBot);
    }

    const rootAsset = await fetch(`${box.url}/screen/assets/client.js`, { headers: { cookie } });
    assert.equal(rootAsset.status, 200);
    assert.equal(publicHits.at(-1), "GET:/assets/client.js");
  } finally {
    computer?.completePrepare();
    if (registrationResponse && !registrationResponse.writableEnded) registrationResponse.end();
    await box?.close().catch(() => undefined);
    sentinel.closeAllConnections();
    if (sentinel.listening) await new Promise<void>((resolve) => sentinel.close(() => resolve()));
    await rm(homeDir, { recursive: true, force: true });
    await rm(pwaDir, { recursive: true, force: true });
  }
});

test("failed persisted Screen cleanup is bounded and does not block or release a ready sibling", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-cleanup-required-screen-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-cleanup-required-screen-pwa-"));
  const failedBotId = crypto.randomUUID();
  const readyBotId = crypto.randomUUID();
  const computer = new CleanupFailingComputer(join(homeDir, "cookies"), failedBotId);
  let box: RunningBox | undefined;

  try {
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: failedBotId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      crypto.randomUUID(),
    );
    home.createBot(
      {
        id: readyBotId,
        name: "Ben",
        color: "#00a878",
        shape: "rounded-cube",
        harness: null,
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      crypto.randomUUID(),
    );
    home.close();

    box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer,
    });
    const cookie = await login(box.url);
    await Promise.all([
      waitForScreenState(box.url, cookie, failedBotId, "cleanup-required"),
      waitForScreenState(box.url, cookie, readyBotId, "ready"),
    ]);

    const response = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
    const body = (await response.json()) as {
      bots?: Array<{
        id?: string;
        display?: number | null;
        screenState?: string;
        screenError?: unknown;
        screenCleanupError?: unknown;
      }>;
    };
    const byId = new Map(body.bots?.map((bot) => [bot.id, bot]));
    assert.deepEqual(byId.get(failedBotId), {
      ...byId.get(failedBotId),
      display: 1,
      screenState: "cleanup-required",
      screenError: {
        stage: "prepare",
        code: "SCREEN_ATTACHMENT_FAILED",
        message: "Screen attachment failed during prepare.",
      },
      screenCleanupError: {
        code: "SCREEN_CLEANUP_FAILED",
        message: "Screen cleanup did not complete.",
      },
    });
    assert.equal(byId.get(readyBotId)?.display, 2);
    assert.equal(byId.get(readyBotId)?.screenState, "ready");
    assert.equal(computer.display(readyBotId)?.display, 2);
    assert.deepEqual(computer.releaseCalls, [failedBotId]);
  } finally {
    await box?.close();
    await rm(homeDir, { recursive: true, force: true });
    await rm(pwaDir, { recursive: true, force: true });
  }
});

test("unpublished provisioning recovery never rolls back a display durably owned by a published Bot", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-provisioning-display-conflict-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-provisioning-display-conflict-pwa-"));
  const firstBotId = crypto.randomUUID();
  const displayOwnerId = crypto.randomUUID();
  const provisioningId = crypto.randomUUID();
  const computer = new ProvisioningConflictComputer({ cookiesDir: join(homeDir, "cookies") });
  let box: RunningBox | undefined;
  let startupError: unknown;

  try {
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: firstBotId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      crypto.randomUUID(),
    );
    home.createBot(
      {
        id: displayOwnerId,
        name: "Ben",
        color: "#00a878",
        shape: "rounded-cube",
        harness: null,
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      crypto.randomUUID(),
    );
    home.beginBotProvisioning(provisioningId);
    home.setBotProvisioningWorkspaceOwned(provisioningId, false);
    home.setBotProvisioningDisplay(provisioningId, 2);
    home.close();

    try {
      box = await startBox({
        password: PASSWORD,
        pwaDir,
        host: "127.0.0.1",
        port: 0,
        homeDir,
        computer,
      });
    } catch (error) {
      startupError = error;
    }

    assert.equal(box, undefined, "Talk bound despite an unpublished cleanup ownership conflict");
    assert.match(String((startupError as Error | undefined)?.message), /cleanup.*display 2.*published Bot/i);
    assert.deepEqual(computer.rollbackCalls, []);
    const reopened = new HomeStore(homeDir);
    assert.deepEqual(reopened.listBotProvisionings(), [{
      botId: provisioningId,
      display: 2,
      workspaceOwned: false,
      state: "cleanup-required",
    }]);
    assert.equal(reopened.botDisplay(displayOwnerId), 2);
    reopened.close();
  } finally {
    await box?.close();
    await rm(homeDir, { recursive: true, force: true });
    await rm(pwaDir, { recursive: true, force: true });
  }
});

test("Talk shutdown waits for one in-flight persisted attachment cleanup and permits no late commit", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-screen-shutdown-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-screen-shutdown-pwa-"));
  const botId = crypto.randomUUID();
  const computer = new DeferredPrepareComputer(join(homeDir, "cookies"));
  let box: RunningBox | undefined;
  let closing: Promise<void> | undefined;

  try {
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: botId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      crypto.randomUUID(),
    );
    home.close();

    box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer,
    });
    await computer.prepareStarted;
    let closeSettled = false;
    closing = box.close().then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closeSettled, false, "Talk close returned before the owned attachment attempt settled");

    computer.completePrepare();
    await closing;
    assert.deepEqual(computer.commitCalls, []);
    assert.deepEqual(computer.releaseCalls, [botId]);
    assert.equal(computer.display(botId), undefined);
    const terminalCalls = {
      commits: [...computer.commitCalls],
      releases: [...computer.releaseCalls],
    };
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(computer.commitCalls, terminalCalls.commits);
    assert.deepEqual(computer.releaseCalls, terminalCalls.releases);
  } finally {
    computer.completePrepare();
    await closing?.catch(() => undefined);
    await box?.close().catch(() => undefined);
    await rm(homeDir, { recursive: true, force: true });
    await rm(pwaDir, { recursive: true, force: true });
  }
});

test("persisted Screen becomes usable only after Kasm registration publishes canonical view-only ownership", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-screen-ownership-recovery-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-screen-ownership-recovery-pwa-"));
  const botId = crypto.randomUUID();
  let resolveRegistrationStarted!: () => void;
  const registrationStarted = new Promise<void>((resolve) => (resolveRegistrationStarted = resolve));
  let registrationResponse: http.ServerResponse | undefined;
  let readinessHits = 0;
  const kasm = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/update_user?")) {
      registrationResponse = res;
      resolveRegistrationStarted();
      return;
    }
    readinessHits += 1;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><title>KasmVNC</title></html>");
  });
  let box: RunningBox | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      kasm.once("error", reject);
      kasm.listen(0, "127.0.0.1", () => resolve());
    });
    const address = kasm.address();
    if (!address || typeof address === "string") throw new Error("Kasm ownership fixture failed to bind");
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: botId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      crypto.randomUUID(),
    );
    home.close();
    const computer = new MemoryComputerRuntime({
      cookiesDir: join(homeDir, "cookies"),
      upstreams: [`http://127.0.0.1:${address.port}`],
    });

    box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer,
      kasmUser: "kasm",
      kasmPassword: "kasm-secret",
    });
    await registrationStarted;
    const cookie = await login(box.url);
    const attachingBots = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
    const attachingBody = (await attachingBots.json()) as {
      bots?: Array<{ id?: string; screenState?: string; computerOwnership?: string }>;
    };
    assert.deepEqual(attachingBody.bots?.map((bot) => ({
      id: bot.id,
      screenState: bot.screenState,
      computerOwnership: bot.computerOwnership,
    })), [{ id: botId, screenState: "attaching", computerOwnership: "unknown" }]);

    const pendingComputer = await fetch(
      `${box.url}/api/computer?botId=${encodeURIComponent(botId)}`,
      { headers: { cookie } },
    );
    const pendingBody = (await pendingComputer.json()) as {
      path?: string | null;
      ready?: boolean;
      screenState?: string;
      ownership?: string;
    };
    assert.deepEqual(
      {
        path: pendingBody.path,
        ready: pendingBody.ready,
        screenState: pendingBody.screenState,
        ownership: pendingBody.ownership,
      },
      { path: null, ready: false, screenState: "attaching", ownership: "unknown" },
    );
    assert.equal(readinessHits, 0);

    registrationResponse?.writeHead(200, { "content-type": "text/plain" });
    registrationResponse?.end("ok");
    await waitForScreenState(box.url, cookie, botId, "ready");
    const readyComputer = await fetch(
      `${box.url}/api/computer?botId=${encodeURIComponent(botId)}`,
      { headers: { cookie } },
    );
    const readyBody = (await readyComputer.json()) as {
      path?: string | null;
      screenState?: string;
      ownership?: string;
    };
    assert.deepEqual(
      { path: readyBody.path, screenState: readyBody.screenState, ownership: readyBody.ownership },
      { path: `/screen/${botId}/`, screenState: "ready", ownership: "view-only" },
    );
  } finally {
    registrationResponse?.end();
    await box?.close().catch(() => undefined);
    kasm.closeAllConnections();
    if (kasm.listening) await new Promise<void>((resolve) => kasm.close(() => resolve()));
    await rm(homeDir, { recursive: true, force: true });
    await rm(pwaDir, { recursive: true, force: true });
  }
});

test("schema-1 Home with nine Bots preserves Chat state and leaves overflow Screen durably unassigned across restart", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-nine-bot-schema-one-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-nine-bot-schema-one-pwa-"));
  const workspaceDir = defaultWorkspaceDir(homeDir);
  let box: RunningBox | undefined;
  let currentComputer: TrackingComputer | undefined;

  try {
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, "AGENTS.md"), "Legacy nine-Bot All Bots setting\n");
    const legacy = seedSchemaOneHome(homeDir);
    const start = () => {
      currentComputer = new TrackingComputer({
        cookiesDir: join(homeDir, `cookies-${crypto.randomUUID()}`),
        upstreams: Array.from({ length: 8 }, (_, index) => `http://127.0.0.1:${16901 + index}`),
      });
      return startBox({
        password: PASSWORD,
        pwaDir,
        host: "127.0.0.1",
        port: 0,
        homeDir,
        computer: currentComputer,
      });
    };

    for (let run = 0; run < 2; run += 1) {
      box = await start();
      const cookie = await login(box.url);
      await Promise.all(legacy.bots.slice(0, 8).map((bot) => waitForScreenState(box!.url, cookie, bot.id, "ready")));
      await waitForScreenState(box.url, cookie, legacy.bots[8]!.id, "unassigned");

      const [botsResponse, channelsResponse, settingsResponse] = await Promise.all([
        fetch(`${box.url}/api/bots`, { headers: { cookie } }),
        fetch(`${box.url}/api/channels`, { headers: { cookie } }),
        fetch(`${box.url}/api/agents`, { headers: { cookie } }),
      ]);
      const bots = (await botsResponse.json()) as {
        bots?: Array<{ id?: string; name?: string; display?: number | null; screenState?: string }>;
      };
      const channels = (await channelsResponse.json()) as {
        channels?: Array<{ id?: string; kind?: string; title?: string | null }>;
      };
      const settings = (await settingsResponse.json()) as { text?: string };
      assert.deepEqual(bots.bots?.map((bot) => bot.id), legacy.bots.map((bot) => bot.id));
      assert.deepEqual(bots.bots?.map((bot) => bot.name), legacy.bots.map((_bot, index) => `Legacy ${index + 1}`));
      assert.deepEqual(bots.bots?.map((bot) => bot.display), [1, 2, 3, 4, 5, 6, 7, 8, null]);
      assert.equal(new Set(bots.bots?.flatMap((bot) => bot.display === null ? [] : [bot.display])).size, 8);
      assert.equal(bots.bots?.[8]?.screenState, "unassigned");
      assert.ok(channels.channels?.some((channel) => (
        channel.id === legacy.groupChannelId && channel.kind === "group" && channel.title === "Legacy group"
      )));
      assert.equal(settings.text, "Legacy nine-Bot All Bots setting\n");

      for (let index = 0; index < legacy.bots.length; index += 1) {
        const bot = legacy.bots[index]!;
        const transcriptResponse = await fetch(`${box.url}/api/bots/${bot.id}/messages`, { headers: { cookie } });
        const transcript = (await transcriptResponse.json()) as {
          messages?: Array<{ id?: string; text?: string; receipt?: string }>;
        };
        assert.deepEqual(transcript.messages, [{
          id: bot.messageId,
          role: "user",
          senderId: HUMAN_MEMBER_ID,
          text: `legacy transcript ${index + 1}`,
          createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
          receipt: "read",
        }]);
      }

      const database = new DatabaseSync(join(homeDir, "talk.sqlite"), { readOnly: true });
      const rows = database.prepare("SELECT id, display FROM bots ORDER BY rowid").all() as Array<{
        id: string;
        display: number | null;
      }>;
      const sessions = database
        .prepare("SELECT bot_id, channel_id, session_id FROM bot_channel_state WHERE channel_id != ? ORDER BY rowid")
        .all(legacy.groupChannelId) as Array<{ bot_id: string; channel_id: string; session_id: string }>;
      assert.deepEqual(rows.map((row) => [row.id, row.display]), legacy.bots.map((bot, index) => [
        bot.id,
        index < 8 ? index + 1 : null,
      ]));
      assert.deepEqual(sessions.map((row) => [row.bot_id, row.channel_id, row.session_id]), legacy.bots.map((bot) => [
        bot.id,
        bot.channelId,
        bot.sessionId,
      ]));
      database.close();

      if (run === 0) {
        const overflowId = legacy.bots[8]!.id;
        const overflowResponse = await fetch(`${box.url}/api/bots/${overflowId}`, { headers: { cookie } });
        const overflow = (await overflowResponse.json()) as {
          screenAttempt?: string;
          screenState?: string;
          display?: number | null;
        };
        assert.equal(typeof overflow.screenAttempt, "string");
        const unchanged = {
          screenAttempt: overflow.screenAttempt,
          screenState: overflow.screenState,
          display: overflow.display,
          reserveCalls: currentComputer?.reserveCalls.length,
        };
        for (const invalidBody of ["null", "[]", "1", "true", '"retry"', "{"]) {
          const invalid: Response = await fetch(`${box.url}/api/computer/retry`, {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: invalidBody,
          });
          assert.equal(invalid.status, 400, `retry body ${invalidBody} was not rejected as a JSON object`);
        }
        const afterInvalidResponse = await fetch(`${box.url}/api/bots/${overflowId}`, { headers: { cookie } });
        const afterInvalid = (await afterInvalidResponse.json()) as {
          screenAttempt?: string;
          screenState?: string;
          display?: number | null;
        };
        assert.deepEqual(
          {
            screenAttempt: afterInvalid.screenAttempt,
            screenState: afterInvalid.screenState,
            display: afterInvalid.display,
            reserveCalls: currentComputer?.reserveCalls.length,
          },
          unchanged,
        );

        const fullRetry = await fetch(`${box.url}/api/computer/retry`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ botId: overflowId, screenAttempt: overflow.screenAttempt }),
        });
        assert.equal(fullRetry.status, 202);
        const accepted = (await fullRetry.json()) as { screenAttempt?: string; screenState?: string };
        assert.equal(accepted.screenState, "attaching");
        assert.notEqual(accepted.screenAttempt, overflow.screenAttempt);
        await waitForScreenState(box.url, cookie, overflowId, "unassigned");
        const settledResponse = await fetch(`${box.url}/api/bots/${overflowId}`, { headers: { cookie } });
        const settled = (await settledResponse.json()) as {
          screenAttempt?: string;
          screenState?: string;
          display?: number | null;
          messages?: unknown[];
        };
        assert.equal(settled.screenAttempt, accepted.screenAttempt);
        assert.equal(settled.screenState, "unassigned");
        assert.equal(settled.display, null);
        assert.deepEqual(settled.messages, [{
          id: legacy.bots[8]!.messageId,
          role: "user",
          senderId: HUMAN_MEMBER_ID,
          text: "legacy transcript 9",
          createdAt: "2026-01-01T00:00:08.000Z",
          receipt: "read",
        }]);
        assert.equal(currentComputer?.reserveCalls.length, unchanged.reserveCalls);
        assert.equal(currentComputer?.display(overflowId), undefined);
        const stale = await fetch(`${box.url}/api/computer/retry`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ botId: overflowId, screenAttempt: overflow.screenAttempt }),
        });
        assert.equal(stale.status, 409);
        assert.equal(((await stale.json()) as { code?: string }).code, "STALE_SCREEN_ATTEMPT");
      }

      await box.close();
      box = undefined;
    }

    const freedDisplay = new DatabaseSync(join(homeDir, "talk.sqlite"));
    const freed = freedDisplay.prepare("UPDATE bots SET display = NULL WHERE id = ? AND display = 1")
      .run(legacy.bots[0]!.id);
    assert.equal(freed.changes, 1);
    freedDisplay.close();

    box = await start();
    let cookie = await login(box.url);
    await Promise.all(legacy.bots.slice(1, 8).map((bot) => waitForScreenState(box!.url, cookie, bot.id, "ready")));
    await waitForScreenState(box.url, cookie, legacy.bots[0]!.id, "unassigned");
    await waitForScreenState(box.url, cookie, legacy.bots[8]!.id, "unassigned");
    const overflowBeforeRetry = await fetch(`${box.url}/api/bots/${legacy.bots[8]!.id}`, { headers: { cookie } });
    const overflow = (await overflowBeforeRetry.json()) as { screenAttempt?: string };
    assert.equal(typeof overflow.screenAttempt, "string");
    const retry = await fetch(`${box.url}/api/computer/retry`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ botId: legacy.bots[8]!.id, screenAttempt: overflow.screenAttempt }),
    });
    assert.equal(retry.status, 202);
    await waitForScreenState(box.url, cookie, legacy.bots[8]!.id, "ready");
    const recoveredBotsResponse = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
    const recoveredBots = (await recoveredBotsResponse.json()) as {
      bots?: Array<{ id?: string; display?: number | null; screenState?: string }>;
    };
    assert.deepEqual(recoveredBots.bots?.map((bot) => bot.id), legacy.bots.map((bot) => bot.id));
    assert.deepEqual(recoveredBots.bots?.map((bot) => bot.display), [null, 2, 3, 4, 5, 6, 7, 8, 1]);
    assert.equal(recoveredBots.bots?.[0]?.screenState, "unassigned");
    assert.equal(recoveredBots.bots?.[8]?.screenState, "ready");
    assert.equal(new Set(recoveredBots.bots?.flatMap((bot) => bot.display === null ? [] : [bot.display])).size, 8);
    const recoveredTranscriptResponse = await fetch(
      `${box.url}/api/bots/${legacy.bots[8]!.id}/messages`,
      { headers: { cookie } },
    );
    const recoveredTranscript = (await recoveredTranscriptResponse.json()) as { messages?: unknown[] };
    assert.deepEqual(recoveredTranscript.messages, [{
      id: legacy.bots[8]!.messageId,
      role: "user",
      senderId: HUMAN_MEMBER_ID,
      text: "legacy transcript 9",
      createdAt: "2026-01-01T00:00:08.000Z",
      receipt: "read",
    }]);
    await box.close();
    box = undefined;

    box = await start();
    cookie = await login(box.url);
    await Promise.all([
      ...legacy.bots.slice(1, 8).map((bot) => waitForScreenState(box!.url, cookie, bot.id, "ready")),
      waitForScreenState(box.url, cookie, legacy.bots[8]!.id, "ready"),
      waitForScreenState(box.url, cookie, legacy.bots[0]!.id, "unassigned"),
    ]);
    const restartedBotsResponse = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
    const restartedBots = (await restartedBotsResponse.json()) as {
      bots?: Array<{ id?: string; display?: number | null; screenState?: string }>;
    };
    assert.deepEqual(restartedBots.bots?.map((bot) => bot.id), legacy.bots.map((bot) => bot.id));
    assert.deepEqual(restartedBots.bots?.map((bot) => bot.display), [null, 2, 3, 4, 5, 6, 7, 8, 1]);
    assert.equal(restartedBots.bots?.[0]?.screenState, "unassigned");
    assert.equal(restartedBots.bots?.[8]?.screenState, "ready");
  } finally {
    await box?.close().catch(() => undefined);
    await rm(homeDir, { recursive: true, force: true });
    await rm(pwaDir, { recursive: true, force: true });
  }
});

test("Kasm registration rejection never publishes a committed persisted Screen as ready", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-screen-ownership-reject-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-screen-ownership-reject-pwa-"));
  const botId = crypto.randomUUID();
  const kasmHits: string[] = [];
  const kasm = http.createServer((req, res) => {
    kasmHits.push(req.url ?? "/");
    if (req.url?.startsWith("/api/update_user?")) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("controlled Kasm rejection");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><title>KasmVNC</title></html>");
  });
  let box: RunningBox | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      kasm.once("error", reject);
      kasm.listen(0, "127.0.0.1", () => resolve());
    });
    const address = kasm.address();
    if (!address || typeof address === "string") throw new Error("Kasm rejection fixture failed to bind");
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: botId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      crypto.randomUUID(),
    );
    home.close();
    const computer = new MemoryComputerRuntime({
      cookiesDir: join(homeDir, "cookies"),
      upstreams: [`http://127.0.0.1:${address.port}`],
    });

    box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer,
      kasmUser: "kasm",
      kasmPassword: "kasm-secret",
    });
    const cookie = await login(box.url);
    await waitForScreenState(box.url, cookie, botId, "unavailable");
    const botsResponse = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
    const bots = (await botsResponse.json()) as {
      bots?: Array<{
        id?: string;
        display?: number | null;
        screenState?: string;
        computerOwnership?: string;
        screenError?: unknown;
        screenCleanupError?: unknown;
      }>;
    };
    const bot = bots.bots?.find((item) => item.id === botId);
    assert.deepEqual(
      {
        display: bot?.display,
        screenState: bot?.screenState,
        computerOwnership: bot?.computerOwnership,
        screenError: bot?.screenError,
        screenCleanupError: bot?.screenCleanupError,
      },
      {
        display: 1,
        screenState: "unavailable",
        computerOwnership: "unknown",
        screenError: {
          stage: "ownership",
          code: "SCREEN_OWNERSHIP_FAILED",
          message: "Screen ownership registration failed.",
        },
        screenCleanupError: null,
      },
    );
    assert.equal(computer.display(botId), undefined);

    const hitsAfterRegistration = [...kasmHits];
    const computerResponse = await fetch(
      `${box.url}/api/computer?botId=${encodeURIComponent(botId)}`,
      { headers: { cookie } },
    );
    const computerBody = (await computerResponse.json()) as {
      path?: string | null;
      ready?: boolean;
      screenState?: string;
      ownership?: string;
    };
    assert.deepEqual(
      {
        path: computerBody.path,
        ready: computerBody.ready,
        screenState: computerBody.screenState,
        ownership: computerBody.ownership,
      },
      { path: null, ready: false, screenState: "unavailable", ownership: "unknown" },
    );
    assert.equal((await fetch(`${box.url}/screen/${botId}/`, { headers: { cookie } })).status, 503);
    assert.match(
      await rawUpgrade(box.url, `/screen/${botId}/websockify`, cookie),
      /^HTTP\/1\.1 503 Service Unavailable/u,
    );
    assert.deepEqual(kasmHits, hitsAfterRegistration);
  } finally {
    await box?.close().catch(() => undefined);
    kasm.closeAllConnections();
    if (kasm.listening) await new Promise<void>((resolve) => kasm.close(() => resolve()));
    await rm(homeDir, { recursive: true, force: true });
    await rm(pwaDir, { recursive: true, force: true });
  }
});

test("released failed Kasm target never blocks a healthy sibling write transition", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-released-kasm-target-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-released-kasm-target-pwa-"));
  const failedBotId = crypto.randomUUID();
  const readyBotId = crypto.randomUUID();
  const failedHits: string[] = [];
  const readyHits: string[] = [];
  const failedKasm = http.createServer((req, res) => {
    failedHits.push(`${req.method ?? "GET"}:${req.url ?? "/"}`);
    if (req.url?.startsWith("/api/update_user?")) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("controlled failed target registration");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><title>KasmVNC</title></html>");
  });
  const readyKasm = http.createServer((req, res) => {
    readyHits.push(`${req.method ?? "GET"}:${req.url ?? "/"}`);
    if (req.url?.startsWith("/api/update_user?")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><title>KasmVNC</title></html>");
  });
  let box: RunningBox | undefined;

  try {
    for (const server of [failedKasm, readyKasm]) {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
    }
    const ports = [failedKasm, readyKasm].map((server) => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Kasm sibling fixture failed to bind");
      return address.port;
    });
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: failedBotId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      crypto.randomUUID(),
    );
    home.createBot(
      {
        id: readyBotId,
        name: "Ben",
        color: "#1e90ff",
        shape: "rounded-cube",
        harness: null,
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      crypto.randomUUID(),
    );
    home.close();
    const computer = new MemoryComputerRuntime({
      cookiesDir: join(homeDir, "cookies"),
      upstreams: ports.map((port) => `http://127.0.0.1:${port}`),
    });
    box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer,
      kasmUser: "kasm",
      kasmPassword: "kasm-secret",
    });
    const cookie = await login(box.url);
    await Promise.all([
      waitForScreenState(box.url, cookie, failedBotId, "unavailable"),
      waitForScreenState(box.url, cookie, readyBotId, "ready"),
    ]);
    assert.equal(computer.display(failedBotId), undefined);
    assert.equal(computer.display(readyBotId)?.display, 2);
    assert.equal(failedHits.filter((hit) => hit.includes("/api/update_user?")).length, 1);

    const currentResponse = await fetch(
      `${box.url}/api/computer?botId=${encodeURIComponent(readyBotId)}`,
      { headers: { cookie } },
    );
    const current = (await currentResponse.json()) as {
      ownershipEpoch?: string;
      screenState?: string;
      display?: number | null;
    };
    assert.deepEqual(
      { screenState: current.screenState, display: current.display },
      { screenState: "ready", display: 2 },
    );
    const failedHitsBeforeSiblingWrite = [...failedHits];
    const writeResponse = await fetch(`${box.url}/api/computer/zoom`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        botId: readyBotId,
        zoom: true,
        ownershipEpoch: current.ownershipEpoch,
      }),
    });
    assert.equal(writeResponse.status, 200);
    const written = (await writeResponse.json()) as {
      path?: string | null;
      ownership?: string;
      screenState?: string;
      display?: number | null;
    };
    assert.deepEqual(
      {
        path: written.path,
        ownership: written.ownership,
        screenState: written.screenState,
        display: written.display,
      },
      {
        path: `/screen/${readyBotId}/`,
        ownership: "write",
        screenState: "ready",
        display: 2,
      },
    );
    assert.deepEqual(failedHits, failedHitsBeforeSiblingWrite);
    assert.ok(readyHits.some((hit) => hit.includes("/api/update_user?") && hit.includes("write=true")));
  } finally {
    await box?.close().catch(() => undefined);
    for (const server of [failedKasm, readyKasm]) {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(homeDir, { recursive: true, force: true });
    await rm(pwaDir, { recursive: true, force: true });
  }
});

test("ready Screen with unknown Kasm authority exposes no public proxy until repair confirms view-only", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-ready-unknown-authority-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-ready-unknown-authority-pwa-"));
  const botId = crypto.randomUUID();
  const updateWrites: boolean[] = [];
  const publicHits: string[] = [];
  let failEnable = true;
  let failCompensation = true;
  const kasm = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/update_user?")) {
      const write = new URL(req.url, "http://kasm").searchParams.get("write") === "true";
      updateWrites.push(write);
      if (write && failEnable) {
        failEnable = false;
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("controlled enable failure");
        return;
      }
      if (!write && !failEnable && failCompensation && updateWrites.includes(true)) {
        failCompensation = false;
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("controlled compensation failure");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    publicHits.push(`${req.method ?? "GET"}:${req.url ?? "/"}`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><title>KasmVNC</title></html>");
  });
  kasm.on("upgrade", (req, socket) => {
    publicHits.push(`UPGRADE:${req.url ?? "/"}`);
    socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: close\r\n\r\n");
  });
  let box: RunningBox | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      kasm.once("error", reject);
      kasm.listen(0, "127.0.0.1", () => resolve());
    });
    const address = kasm.address();
    if (!address || typeof address === "string") throw new Error("unknown authority fixture failed to bind");
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: botId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      crypto.randomUUID(),
    );
    home.close();
    box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer: new MemoryComputerRuntime({
        cookiesDir: join(homeDir, "cookies"),
        upstreams: [`http://127.0.0.1:${address.port}`],
      }),
      kasmUser: "kasm",
      kasmPassword: "kasm-secret",
    });
    const cookie = await login(box.url);
    await waitForScreenState(box.url, cookie, botId, "ready");
    const initial = await fetch(
      `${box.url}/api/computer?botId=${encodeURIComponent(botId)}`,
      { headers: { cookie } },
    ).then((response) => response.json()) as { ownershipEpoch?: string };

    const failedWrite = await fetch(`${box.url}/api/computer/zoom`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ botId, zoom: true, ownershipEpoch: initial.ownershipEpoch }),
    });
    assert.equal(failedWrite.status, 503);
    const failedState = (await failedWrite.json()) as {
      path?: string | null;
      ready?: boolean;
      screenState?: string;
      ownership?: string;
      display?: number | null;
    };
    assert.deepEqual(
      {
        path: failedState.path,
        ready: failedState.ready,
        screenState: failedState.screenState,
        ownership: failedState.ownership,
        display: failedState.display,
      },
      { path: null, ready: false, screenState: "ready", ownership: "unknown", display: 1 },
    );
    const publicHitsBeforeDeniedRoutes = [...publicHits];
    assert.equal((await fetch(`${box.url}/screen/${botId}/`, { headers: { cookie } })).status, 503);
    assert.match(
      await rawUpgrade(box.url, `/screen/${botId}/websockify`, cookie),
      /^HTTP\/1\.1 503 Service Unavailable/u,
    );
    assert.deepEqual(publicHits, publicHitsBeforeDeniedRoutes);

    const repaired = await fetch(`${box.url}/api/computer/zoom`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ botId, zoom: false }),
    });
    assert.equal(repaired.status, 200);
    const repairedState = (await repaired.json()) as {
      path?: string | null;
      ready?: boolean;
      screenState?: string;
      ownership?: string;
      display?: number | null;
    };
    assert.deepEqual(
      {
        path: repairedState.path,
        ready: repairedState.ready,
        screenState: repairedState.screenState,
        ownership: repairedState.ownership,
        display: repairedState.display,
      },
      {
        path: `/screen/${botId}/`,
        ready: true,
        screenState: "ready",
        ownership: "view-only",
        display: 1,
      },
    );
    assert.equal((await fetch(`${box.url}/screen/${botId}/`, { headers: { cookie } })).status, 200);
    assert.ok(updateWrites.includes(true));
    assert.ok(updateWrites.filter((write) => !write).length >= 3);
  } finally {
    await box?.close().catch(() => undefined);
    kasm.closeAllConnections();
    if (kasm.listening) await new Promise<void>((resolve) => kasm.close(() => resolve()));
    await rm(homeDir, { recursive: true, force: true });
    await rm(pwaDir, { recursive: true, force: true });
  }
});

test("Computer GET revalidates Screen authority after delayed readiness settles", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-delayed-readiness-authority-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-delayed-readiness-authority-pwa-"));
  const botId = crypto.randomUUID();
  const publicHits: string[] = [];
  let holdNextReadiness = false;
  let heldReadiness: http.ServerResponse | undefined;
  let resolveReadinessStarted!: () => void;
  const readinessStarted = new Promise<void>((resolve) => (resolveReadinessStarted = resolve));
  let failEnable = false;
  let enableFailed = false;
  let compensationFailed = false;
  const kasm = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/update_user?")) {
      const write = new URL(req.url, "http://kasm").searchParams.get("write") === "true";
      if (failEnable && write && !enableFailed) {
        enableFailed = true;
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("controlled delayed-readiness enable failure");
        return;
      }
      if (failEnable && !write && enableFailed && !compensationFailed) {
        compensationFailed = true;
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("controlled delayed-readiness compensation failure");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    publicHits.push(`${req.method ?? "GET"}:${req.url ?? "/"}`);
    if (holdNextReadiness) {
      holdNextReadiness = false;
      heldReadiness = res;
      resolveReadinessStarted();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><title>KasmVNC</title></html>");
  });
  let box: RunningBox | undefined;
  const releaseHeldReadiness = () => {
    if (!heldReadiness || heldReadiness.writableEnded) return;
    heldReadiness.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    heldReadiness.end("<html><title>KasmVNC</title></html>");
  };

  try {
    await new Promise<void>((resolve, reject) => {
      kasm.once("error", reject);
      kasm.listen(0, "127.0.0.1", () => resolve());
    });
    const address = kasm.address();
    if (!address || typeof address === "string") throw new Error("delayed readiness fixture failed to bind");
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: botId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      crypto.randomUUID(),
    );
    home.close();
    box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer: new MemoryComputerRuntime({
        cookiesDir: join(homeDir, "cookies"),
        upstreams: [`http://127.0.0.1:${address.port}`],
      }),
      kasmUser: "kasm",
      kasmPassword: "kasm-secret",
    });
    const cookie = await login(box.url);
    await waitForScreenState(box.url, cookie, botId, "ready");
    const initial = await fetch(
      `${box.url}/api/computer?botId=${encodeURIComponent(botId)}`,
      { headers: { cookie } },
    ).then((response) => response.json()) as {
      ownership?: string;
      ownershipEpoch?: string;
    };
    assert.equal(initial.ownership, "view-only");
    assert.equal(typeof initial.ownershipEpoch, "string");

    holdNextReadiness = true;
    const delayedComputer = fetch(
      `${box.url}/api/computer?botId=${encodeURIComponent(botId)}`,
      { headers: { cookie } },
    );
    await readinessStarted;

    failEnable = true;
    const failedWrite = await fetch(`${box.url}/api/computer/zoom`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ botId, zoom: true, ownershipEpoch: initial.ownershipEpoch }),
    });
    assert.equal(failedWrite.status, 503);
    const failedWriteBody = (await failedWrite.json()) as {
      path?: string | null;
      ready?: boolean;
      ownership?: string;
    };
    assert.deepEqual(
      {
        path: failedWriteBody.path,
        ready: failedWriteBody.ready,
        ownership: failedWriteBody.ownership,
      },
      { path: null, ready: false, ownership: "unknown" },
    );

    releaseHeldReadiness();
    const settled = await delayedComputer;
    assert.equal(settled.status, 200);
    const settledBody = (await settled.json()) as {
      path?: string | null;
      reachable?: boolean;
      ready?: boolean;
      screenState?: string;
      ownership?: string;
      display?: number | null;
    };
    assert.deepEqual(
      {
        path: settledBody.path,
        reachable: settledBody.reachable,
        ready: settledBody.ready,
        screenState: settledBody.screenState,
        ownership: settledBody.ownership,
        display: settledBody.display,
      },
      {
        path: null,
        reachable: false,
        ready: false,
        screenState: "ready",
        ownership: "unknown",
        display: 1,
      },
    );
    const hitsBeforeDeniedProxy = publicHits.length;
    assert.equal((await fetch(`${box.url}/screen/${botId}/`, { headers: { cookie } })).status, 503);
    assert.equal(publicHits.length, hitsBeforeDeniedProxy);
  } finally {
    releaseHeldReadiness();
    await box?.close().catch(() => undefined);
    kasm.closeAllConnections();
    if (kasm.listening) await new Promise<void>((resolve) => kasm.close(() => resolve()));
    await rm(homeDir, { recursive: true, force: true });
    await rm(pwaDir, { recursive: true, force: true });
  }
});

test("retry reconciles one cached-unknown Kasm target exactly once before publishing ready", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-screen-ownership-retry-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-screen-ownership-retry-pwa-"));
  const botId = crypto.randomUUID();
  const registrationRequests: string[] = [];
  let resolveSecondRegistrationStarted!: () => void;
  const secondRegistrationStarted = new Promise<void>((resolve) => (resolveSecondRegistrationStarted = resolve));
  let secondRegistrationResponse: http.ServerResponse | undefined;
  const kasm = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/update_user?")) {
      registrationRequests.push(req.url);
      if (registrationRequests.length === 1) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("controlled first registration rejection");
        return;
      }
      secondRegistrationResponse = res;
      resolveSecondRegistrationStarted();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><title>KasmVNC</title></html>");
  });
  let box: RunningBox | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      kasm.once("error", reject);
      kasm.listen(0, "127.0.0.1", () => resolve());
    });
    const address = kasm.address();
    if (!address || typeof address === "string") throw new Error("Kasm retry fixture failed to bind");
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: botId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      crypto.randomUUID(),
    );
    home.close();
    const computer = new MemoryComputerRuntime({
      cookiesDir: join(homeDir, "cookies"),
      upstreams: [`http://127.0.0.1:${address.port}`],
    });
    box = await startBox({
      password: PASSWORD,
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer,
      kasmUser: "kasm",
      kasmPassword: "kasm-secret",
    });
    const cookie = await login(box.url);
    await waitForScreenState(box.url, cookie, botId, "unavailable");
    const failedResponse = await fetch(`${box.url}/api/bots/${botId}`, { headers: { cookie } });
    const failedBot = (await failedResponse.json()) as {
      screenAttempt?: string;
      screenState?: string;
      computerOwnership?: string;
    };
    assert.equal(failedBot.screenState, "unavailable");
    assert.equal(failedBot.computerOwnership, "unknown");
    assert.equal(typeof failedBot.screenAttempt, "string");
    const failedAttempt = failedBot.screenAttempt!;
    assert.equal(registrationRequests.length, 1);

    const retryRequest = () => fetch(`${box!.url}/api/computer/retry`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ botId, screenAttempt: failedAttempt }),
    });
    const retryResponses = await Promise.all([retryRequest(), retryRequest()]);
    assert.deepEqual(retryResponses.map((response) => response.status).sort(), [202, 409]);
    const acceptedResponse = retryResponses.find((response) => response.status === 202)!;
    const rejectedResponse = retryResponses.find((response) => response.status === 409)!;
    const accepted = (await acceptedResponse.json()) as {
      screenAttempt?: string;
      screenState?: string;
      ownership?: string;
    };
    const rejected = (await rejectedResponse.json()) as { code?: string };
    assert.equal(accepted.screenState, "attaching");
    assert.equal(accepted.ownership, "unknown");
    assert.notEqual(accepted.screenAttempt, failedAttempt);
    assert.equal(rejected.code, "STALE_SCREEN_ATTEMPT");

    await secondRegistrationStarted;
    assert.equal(registrationRequests.length, 2);
    assert.ok(registrationRequests.every((request) => new URL(request, "http://kasm").searchParams.get("write") === "false"));
    const pendingComputer = await fetch(
      `${box.url}/api/computer?botId=${encodeURIComponent(botId)}`,
      { headers: { cookie } },
    );
    const pending = (await pendingComputer.json()) as {
      path?: string | null;
      ready?: boolean;
      screenState?: string;
      ownership?: string;
    };
    assert.deepEqual(
      { path: pending.path, ready: pending.ready, screenState: pending.screenState, ownership: pending.ownership },
      { path: null, ready: false, screenState: "attaching", ownership: "unknown" },
    );

    secondRegistrationResponse?.writeHead(200, { "content-type": "text/plain" });
    secondRegistrationResponse?.end("ok");
    await waitForScreenState(box.url, cookie, botId, "ready");
    const readyComputer = await fetch(
      `${box.url}/api/computer?botId=${encodeURIComponent(botId)}`,
      { headers: { cookie } },
    );
    const ready = (await readyComputer.json()) as {
      path?: string | null;
      screenState?: string;
      ownership?: string;
      display?: number | null;
    };
    assert.deepEqual(
      { path: ready.path, screenState: ready.screenState, ownership: ready.ownership, display: ready.display },
      { path: `/screen/${botId}/`, screenState: "ready", ownership: "view-only", display: 1 },
    );
    assert.equal(registrationRequests.length, 2);
    assert.equal(computer.display(botId)?.display, 1);

    const staleRetry = await retryRequest();
    assert.equal(staleRetry.status, 409);
    assert.equal(((await staleRetry.json()) as { code?: string }).code, "STALE_SCREEN_ATTEMPT");
    assert.equal(registrationRequests.length, 2);
  } finally {
    secondRegistrationResponse?.end();
    await box?.close().catch(() => undefined);
    kasm.closeAllConnections();
    if (kasm.listening) await new Promise<void>((resolve) => kasm.close(() => resolve()));
    await rm(homeDir, { recursive: true, force: true });
    await rm(pwaDir, { recursive: true, force: true });
  }
});

test("schema-3 Home rebuilds Bots to nullable display without changing relationships or durable content", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-schema-three-nullable-display-home-"));
  const firstBotId = crypto.randomUUID();
  const secondBotId = crypto.randomUUID();
  const firstChannelId = crypto.randomUUID();
  const secondChannelId = crypto.randomUUID();
  const messageId = crypto.randomUUID();

  try {
    const seed = new HomeStore(homeDir);
    seed.createBot(
      {
        id: firstBotId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: "codex",
        configMode: "host",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      firstChannelId,
    );
    seed.createBot(
      {
        id: secondBotId,
        name: "Ben",
        color: "#00a878",
        shape: "rounded-cube",
        harness: null,
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      secondChannelId,
    );
    seed.appendMessage(firstChannelId, {
      id: messageId,
      role: "user",
      text: "schema three transcript",
      createdAt: "2026-01-01T00:00:02.000Z",
      senderId: HUMAN_MEMBER_ID,
      recipientBotId: firstBotId,
      receipt: "read",
    });
    seed.setSessionId(firstBotId, firstChannelId, "schema-three-session");
    const group = seed.createGroup({ title: "Schema three group", memberBotIds: [firstBotId, secondBotId] });
    seed.setSessionId(firstBotId, group.id, "schema-three-group-session");
    seed.close();
    rebuildBotsAsLegacyVersionThree(homeDir);
    const legacyProbe = new DatabaseSync(join(homeDir, "talk.sqlite"));
    const expectedBotChannelState = (legacyProbe
      .prepare(
        "SELECT bot_id, channel_id, harness_id, session_id FROM bot_channel_state ORDER BY channel_id, bot_id",
      )
      .all() as Array<{
        bot_id: string;
        channel_id: string;
        harness_id: string | null;
        session_id: string | null;
      }>).map((row) => [row.bot_id, row.channel_id, row.harness_id, row.session_id]);
    legacyProbe.close();

    for (let run = 0; run < 2; run += 1) {
      const migrated = new HomeStore(homeDir);
      assert.deepEqual(migrated.listBots(), [
        {
          id: firstBotId,
          name: "Ada",
          color: "#ff3b5c",
          shape: "capsule",
          harness: "codex",
          configMode: "host",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: secondBotId,
          name: "Ben",
          color: "#00a878",
          shape: "rounded-cube",
          harness: null,
          configMode: "isolated",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ]);
      assert.equal(migrated.botDisplay(firstBotId), 1);
      assert.equal(migrated.botDisplay(secondBotId), 2);
      assert.deepEqual(migrated.listMessages(firstChannelId), [{
        id: messageId,
        role: "user",
        senderId: HUMAN_MEMBER_ID,
        text: "schema three transcript",
        createdAt: "2026-01-01T00:00:02.000Z",
        receipt: "read",
      }]);
      assert.equal(migrated.getSessionId(firstBotId, firstChannelId), "schema-three-session");
      assert.equal(migrated.getSessionId(firstBotId, group.id), "schema-three-group-session");
      assert.equal(migrated.getChannel(group.id)?.title, "Schema three group");
      migrated.close();

      const probe = new DatabaseSync(join(homeDir, "talk.sqlite"));
      const version = probe.prepare("PRAGMA user_version").get() as { user_version?: number };
      const columns = probe.prepare("PRAGMA table_info(bots)").all() as Array<{
        name?: string;
        notnull?: number;
      }>;
      assert.equal(version.user_version, HOME_SCHEMA_VERSION);
      assert.equal(columns.find((column) => column.name === "display")?.notnull, 0);
      const migratedBotChannelState = (probe
        .prepare(
          "SELECT bot_id, channel_id, harness_id, session_id FROM bot_channel_state ORDER BY channel_id, bot_id",
        )
        .all() as Array<{
          bot_id: string;
          channel_id: string;
          harness_id: string | null;
          session_id: string | null;
        }>).map((row) => [row.bot_id, row.channel_id, row.harness_id, row.session_id]);
      assert.deepEqual(migratedBotChannelState, expectedBotChannelState);
      assert.deepEqual(probe.prepare("PRAGMA foreign_key_check").all(), []);
      assert.throws(
        () => probe.prepare("UPDATE bots SET display = 1 WHERE id = ?").run(secondBotId),
        /unique constraint/i,
      );
      probe.close();
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("failed schema-3 rebuild rolls back the original table, version, Bots, and sessions", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-schema-three-rollback-home-"));
  const botId = crypto.randomUUID();
  const orphanBotId = crypto.randomUUID();
  const channelId = crypto.randomUUID();

  try {
    const seed = new HomeStore(homeDir);
    seed.createBot(
      {
        id: botId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: "codex",
        configMode: "isolated",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      channelId,
    );
    seed.setSessionId(botId, channelId, "schema-three-preserved-session");
    seed.close();
    rebuildBotsAsLegacyVersionThree(homeDir);

    const corrupt = new DatabaseSync(join(homeDir, "talk.sqlite"), { enableForeignKeyConstraints: false });
    corrupt.prepare(
      `INSERT INTO bot_channel_state (bot_id, channel_id, harness_id, session_id)
       VALUES (?, ?, 'codex', 'orphan-session')`,
    ).run(orphanBotId, channelId);
    const expectedBots = corrupt.prepare(
      "SELECT id, name, color, shape, harness, config_mode, display, created_at FROM bots ORDER BY rowid",
    ).all();
    const expectedStates = corrupt.prepare(
      "SELECT bot_id, channel_id, harness_id, session_id FROM bot_channel_state ORDER BY bot_id, channel_id",
    ).all();
    corrupt.close();

    assert.throws(
      () => new HomeStore(homeDir),
      /migration would break persisted relationships/i,
    );

    const probe = new DatabaseSync(join(homeDir, "talk.sqlite"), { enableForeignKeyConstraints: false });
    const version = probe.prepare("PRAGMA user_version").get() as { user_version?: number };
    const columns = probe.prepare("PRAGMA table_info(bots)").all() as Array<{
      name?: string;
      notnull?: number;
    }>;
    assert.equal(version.user_version, 3);
    assert.equal(columns.find((column) => column.name === "display")?.notnull, 1);
    assert.deepEqual(probe.prepare(
      "SELECT id, name, color, shape, harness, config_mode, display, created_at FROM bots ORDER BY rowid",
    ).all(), expectedBots);
    assert.deepEqual(probe.prepare(
      "SELECT bot_id, channel_id, harness_id, session_id FROM bot_channel_state ORDER BY bot_id, channel_id",
    ).all(), expectedStates);
    assert.equal(
      probe.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'bots_v4_migration'").get(),
      undefined,
    );
    assert.equal(probe.prepare("PRAGMA foreign_key_check").all().length, 1);
    probe.close();
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
