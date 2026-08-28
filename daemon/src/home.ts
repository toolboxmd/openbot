import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SHAPES, type FaceShape } from "./face.ts";
import { isHarnessId, type HarnessId } from "./harness.ts";
import {
  assertGeneratedBotId,
  isGeneratedBotId,
  isHostGrantAccess,
  isHostGrantDuration,
  pathCoveredByGrant,
  type ConfigMode,
  type HostGrantAccess,
  type HostGrantDuration,
} from "./harness-home.ts";

export const HOME_SCHEMA_VERSION = 4;
export const HUMAN_MEMBER_ID = "you";
const BOT_DISPLAY_MAX = 8;

export type MessageReceipt = "sent" | "delivered" | "read";

export type MessageReaction = {
  emoji: string;
  by: "user";
};

export type TranscriptKind = "text" | "host-grant";

export type TranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  kind?: TranscriptKind;
  receipt?: MessageReceipt;
  replyTo?: string;
  reactions?: MessageReaction[];
};

export type StoredBot = {
  id: string;
  name: string;
  color: string;
  shape: FaceShape;
  harness: HarnessId | null;
  configMode?: ConfigMode;
  createdAt: string;
};

export type StoredBotProvisioning = {
  botId: string;
  display: number | null;
  workspaceOwned: boolean;
  state: "preparing" | "cleanup-required";
};

export type StoredHostGrant = {
  id: string;
  path: string;
  access: HostGrantAccess;
  duration: HostGrantDuration;
  consumed: boolean;
  createdAt: string;
};

export type ChannelKind = "direct" | "group" | "bot-to-bot";

export type ChannelMember = {
  kind: "user" | "bot";
  id: string;
};

export type StoredChannel = {
  id: string;
  kind: ChannelKind;
  title: string | null;
  createdAt: string;
  members: ChannelMember[];
  messages: TranscriptMessage[];
};

export type NewMessage = TranscriptMessage & {
  senderId: string;
  recipientBotId?: string;
};

type SqlRow = Record<string, unknown>;

export function defaultHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENBOT_HOME?.trim();
  return path.resolve(configured || path.join(os.homedir(), ".openbot"));
}

export function defaultWorkspaceDir(homeDir = defaultHomeDir()): string {
  return path.join(homeDir, "workspace");
}

export class HomeStore {
  readonly homeDir: string;
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private closed = false;
  private readonly sessionGrants: StoredHostGrant[] = [];

  constructor(homeDir = defaultHomeDir()) {
    this.homeDir = path.resolve(homeDir);
    this.databasePath = path.join(this.homeDir, "talk.sqlite");
    fs.mkdirSync(this.homeDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.homeDir, 0o700);
    const existed = fs.existsSync(this.databasePath);
    if (existed) assertSupportedSchema(this.databasePath);
    else fs.closeSync(fs.openSync(this.databasePath, "wx", 0o600));
    this.db = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true });
    try {
      this.migrate();
      this.assertPersistedBotIds();
      fs.chmodSync(this.databasePath, 0o600);
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // Preserve the startup failure that made Home unusable.
      }
      throw error;
    }
  }

  get workspaceDir(): string {
    return defaultWorkspaceDir(this.homeDir);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  listBots(): StoredBot[] {
    return this.db
      .prepare("SELECT id, name, color, shape, harness, config_mode, created_at FROM bots ORDER BY rowid")
      .all()
      .flatMap((row) => reviveBot(row as SqlRow));
  }

  listBotProvisionings(): StoredBotProvisioning[] {
    return (this.db
      .prepare(
        "SELECT bot_id, display, workspace_owned, state FROM bot_provisioning ORDER BY created_at, bot_id",
      )
      .all() as SqlRow[]).map((row) => ({
      botId: String(row.bot_id),
      display: typeof row.display === "number" ? row.display : null,
      workspaceOwned: row.workspace_owned === 1,
      state: row.state === "cleanup-required" ? "cleanup-required" : "preparing",
    }));
  }

  botDisplay(botId: string): number | null | undefined {
    assertGeneratedBotId(botId);
    const row = this.db.prepare("SELECT display FROM bots WHERE id = ?").get(botId) as SqlRow | undefined;
    if (!row) return undefined;
    if (row.display === null) return null;
    if (!isBotDisplay(row.display)) throw invalidPersistedBotDisplayError();
    return row.display;
  }

  botIdForDisplay(display: number): string | null {
    if (!isBotDisplay(display)) throw new Error("Bot display is invalid");
    const row = this.db.prepare("SELECT id FROM bots WHERE display = ?").get(display) as SqlRow | undefined;
    return typeof row?.id === "string" ? row.id : null;
  }

  availableBotDisplays(): number[] {
    const used = new Set(
      (this.db.prepare("SELECT display FROM bots WHERE display IS NOT NULL").all() as SqlRow[])
        .map((row) => row.display)
        .filter(isBotDisplay),
    );
    return Array.from({ length: BOT_DISPLAY_MAX }, (_, index) => index + 1)
      .filter((display) => !used.has(display));
  }

  claimBotDisplay(botId: string, display: number): void {
    assertGeneratedBotId(botId);
    if (!isBotDisplay(display)) throw new Error("Bot display is invalid");
    this.transaction(() => {
      const row = this.db.prepare("SELECT display FROM bots WHERE id = ?").get(botId) as SqlRow | undefined;
      if (!row) throw Object.assign(new Error("Bot not found"), { status: 404 });
      if (row.display !== null) {
        throw Object.assign(new Error("Bot already has a Screen display assignment"), { status: 409 });
      }
      const changed = this.db
        .prepare("UPDATE bots SET display = ? WHERE id = ? AND display IS NULL")
        .run(display, botId);
      if (changed.changes !== 1) {
        throw Object.assign(new Error("Bot Screen display assignment changed"), { status: 409 });
      }
    });
  }

  beginBotProvisioning(botId: string): void {
    assertGeneratedBotId(botId);
    this.db
      .prepare(
        `INSERT INTO bot_provisioning
         (bot_id, display, workspace_owned, state, cleanup_error, created_at)
         VALUES (?, NULL, 1, 'preparing', NULL, ?)`,
      )
      .run(botId, new Date().toISOString());
  }

  setBotProvisioningDisplay(botId: string, display: number | null): void {
    assertGeneratedBotId(botId);
    if (display !== null && (!Number.isInteger(display) || display < 1 || display > 8)) {
      throw new Error("Bot provisioning display is invalid");
    }
    const changed = this.db.prepare("UPDATE bot_provisioning SET display = ? WHERE bot_id = ?").run(display, botId);
    if (changed.changes !== 1) throw new Error("Bot provisioning state is missing");
  }

  claimBotProvisioningDisplay(botId: string): number {
    assertGeneratedBotId(botId);
    let claimedDisplay: number | undefined;
    this.transaction(() => {
      const provisioning = this.db
        .prepare("SELECT display FROM bot_provisioning WHERE bot_id = ?")
        .get(botId) as SqlRow | undefined;
      if (!provisioning) throw new Error("Bot provisioning state is missing");
      if (isBotDisplay(provisioning.display)) {
        claimedDisplay = provisioning.display;
        return;
      }
      if (provisioning.display !== null) throw new Error("Bot provisioning display is invalid");
      claimedDisplay = this.nextBotDisplay();
      const changed = this.db
        .prepare("UPDATE bot_provisioning SET display = ? WHERE bot_id = ? AND display IS NULL")
        .run(claimedDisplay, botId);
      if (changed.changes !== 1) throw new Error("Bot provisioning display changed");
    });
    return claimedDisplay!;
  }

  setBotProvisioningWorkspaceOwned(botId: string, owned: boolean): void {
    assertGeneratedBotId(botId);
    const changed = this.db
      .prepare("UPDATE bot_provisioning SET workspace_owned = ? WHERE bot_id = ?")
      .run(owned ? 1 : 0, botId);
    if (changed.changes !== 1) throw new Error("Bot provisioning state is missing");
  }

  markBotProvisioningCleanupRequired(botId: string, detail: string): void {
    assertGeneratedBotId(botId);
    const bounded = Buffer.from(detail, "utf8").subarray(0, 1_024).toString("utf8");
    const changed = this.db
      .prepare(
        "UPDATE bot_provisioning SET state = 'cleanup-required', cleanup_error = ? WHERE bot_id = ?",
      )
      .run(bounded, botId);
    if (changed.changes !== 1) throw new Error("Bot provisioning state is missing");
  }

  clearBotProvisioning(botId: string): void {
    assertGeneratedBotId(botId);
    this.db.prepare("DELETE FROM bot_provisioning WHERE bot_id = ?").run(botId);
  }

  listChannels(): StoredChannel[] {
    const rows = this.db
      .prepare("SELECT id, kind, title, created_at FROM channels ORDER BY created_at, id")
      .all() as SqlRow[];
    return rows.flatMap((row) => {
      const channel = this.reviveChannel(row);
      return channel ? [channel] : [];
    });
  }

  listMessages(channelId: string): TranscriptMessage[] {
    return this.db
      .prepare(
        `SELECT id, kind, sender_kind, text, created_at, reply_to
         FROM messages WHERE channel_id = ? ORDER BY sequence`,
      )
      .all(channelId)
      .flatMap((message) => this.reviveMessage(message as SqlRow));
  }

  getMessage(channelId: string, messageId: string): TranscriptMessage | null {
    const row = this.db
      .prepare(
        `SELECT id, kind, sender_kind, text, created_at, reply_to
         FROM messages WHERE channel_id = ? AND id = ?`,
      )
      .get(channelId, messageId) as SqlRow | undefined;
    if (!row) return null;
    return this.reviveMessage(row)[0] ?? null;
  }

  directChannelId(botId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT channels.id AS channel_id
         FROM channels
         JOIN channel_members ON channel_members.channel_id = channels.id
         WHERE channels.kind = 'direct'
           AND channel_members.member_kind = 'bot'
           AND channel_members.member_id = ?
         LIMIT 1`,
      )
      .get(botId) as SqlRow | undefined;
    return typeof row?.channel_id === "string" ? row.channel_id : null;
  }

  getChannel(id: string): StoredChannel | null {
    const row = this.db
      .prepare("SELECT id, kind, title, created_at FROM channels WHERE id = ?")
      .get(id) as SqlRow | undefined;
    if (!row) return null;
    return this.reviveChannel(row);
  }

  createGroup(input: { title?: string | null; memberBotIds: string[] }): StoredChannel {
    const memberBotIds = uniqueIds(input.memberBotIds);
    if (memberBotIds.length === 0) {
      throw Object.assign(new Error("members are required"), { status: 400 });
    }
    const bots = this.listBots();
    const byId = new Map(bots.map((bot) => [bot.id, bot]));
    for (const id of memberBotIds) {
      if (!byId.has(id)) throw Object.assign(new Error("unknown Bot"), { status: 400 });
    }
    if (memberBotIds.length < 2) {
      throw Object.assign(new Error("group needs several Bots"), { status: 400 });
    }
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : null;
    const createdAt = new Date().toISOString();
    const id = crypto.randomUUID();
    const members: ChannelMember[] = [
      { kind: "user", id: HUMAN_MEMBER_ID },
      ...memberBotIds.map((botId) => ({ kind: "bot" as const, id: botId })),
    ];
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO channels (id, kind, title, created_at) VALUES (?, 'group', ?, ?)")
        .run(id, title, createdAt);
      const insertMember = this.db.prepare(
        "INSERT INTO channel_members (channel_id, member_kind, member_id, position) VALUES (?, ?, ?, ?)",
      );
      members.forEach((member, index) => {
        insertMember.run(id, member.kind, member.id, index);
      });
      const insertState = this.db.prepare(
        "INSERT INTO bot_channel_state (bot_id, channel_id, harness_id, session_id) VALUES (?, ?, ?, NULL)",
      );
      for (const botId of memberBotIds) {
        insertState.run(botId, id, byId.get(botId)?.harness ?? null);
      }
    });
    return { id, kind: "group", title, createdAt, members, messages: [] };
  }

  createBot(bot: StoredBot, channelId: string): StoredChannel {
    assertGeneratedBotId(bot.id);
    let channel: StoredChannel | undefined;
    this.transaction(() => {
      channel = this.insertBot(bot, channelId, this.nextBotDisplay());
    });
    return channel!;
  }

  commitProvisionedBot(bot: StoredBot, channelId: string): StoredChannel {
    assertGeneratedBotId(bot.id);
    let channel: StoredChannel | undefined;
    this.transaction(() => {
      const provisioning = this.db
        .prepare("SELECT bot_id, display FROM bot_provisioning WHERE bot_id = ?")
        .get(bot.id) as SqlRow | undefined;
      if (!provisioning) throw new Error("Bot provisioning state is missing");
      if (!isBotDisplay(provisioning.display)) throw new Error("Bot provisioning display is not committed");
      channel = this.insertBot(bot, channelId, provisioning.display);
      const cleared = this.db.prepare("DELETE FROM bot_provisioning WHERE bot_id = ?").run(bot.id);
      if (cleared.changes !== 1) throw new Error("Bot provisioning state was not committed");
    });
    return channel!;
  }

  setConfigMode(botId: string, configMode: ConfigMode): void {
    if (this.closed) return;
    this.transaction(() => {
      const changed = this.db.prepare("UPDATE bots SET config_mode = ? WHERE id = ?").run(configMode, botId);
      if (changed.changes !== 1) throw Object.assign(new Error("Bot not found"), { status: 404 });
      this.db.prepare("UPDATE bot_channel_state SET session_id = NULL WHERE bot_id = ?").run(botId);
    });
  }

  addHostGrant(input: {
    path: string;
    access: HostGrantAccess;
    duration: HostGrantDuration;
  }): StoredHostGrant {
    const grant: StoredHostGrant = {
      id: crypto.randomUUID(),
      path: path.resolve(input.path),
      access: input.access,
      duration: input.duration,
      consumed: false,
      createdAt: new Date().toISOString(),
    };
    if (input.duration === "session") {
      this.sessionGrants.push(grant);
      return grant;
    }
    this.db
      .prepare(
        `INSERT INTO host_grants (id, path, access, duration, consumed, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
      )
      .run(grant.id, grant.path, grant.access, grant.duration, grant.createdAt);
    return grant;
  }

  matchHostGrant(requestPath: string, requested: HostGrantAccess): StoredHostGrant | null {
    const resolved = path.resolve(requestPath);
    const live = [...this.sessionGrants, ...this.listPersistedGrants()].filter((grant) => !grant.consumed);
    for (const grant of live) {
      if (!pathCoveredByGrant(resolved, grant.path)) continue;
      if (grant.access === "deny") return grant;
      if (grant.access === "read-write") return grant;
      if (grant.access === "read" && requested === "read") return grant;
    }
    return null;
  }

  consumeHostGrant(id: string): void {
    const session = this.sessionGrants.find((grant) => grant.id === id);
    if (session) {
      session.consumed = true;
      return;
    }
    this.db.prepare("UPDATE host_grants SET consumed = 1 WHERE id = ?").run(id);
  }

  listHostGrants(): StoredHostGrant[] {
    return [...this.sessionGrants, ...this.listPersistedGrants()].filter((grant) => !grant.consumed);
  }

  private listPersistedGrants(): StoredHostGrant[] {
    return this.db
      .prepare("SELECT id, path, access, duration, consumed, created_at FROM host_grants ORDER BY created_at")
      .all()
      .flatMap((row) => reviveGrant(row as SqlRow));
  }

  setHarness(botId: string, harness: HarnessId): void {
    if (this.closed) return;
    this.transaction(() => {
      const changed = this.db.prepare("UPDATE bots SET harness = ? WHERE id = ?").run(harness, botId);
      if (changed.changes !== 1) throw Object.assign(new Error("Bot not found"), { status: 404 });
      this.db
        .prepare("UPDATE bot_channel_state SET harness_id = ?, session_id = NULL WHERE bot_id = ?")
        .run(harness, botId);
    });
  }

  getSessionId(botId: string, channelId: string): string | null {
    const row = this.db
      .prepare("SELECT session_id FROM bot_channel_state WHERE bot_id = ? AND channel_id = ?")
      .get(botId, channelId) as SqlRow | undefined;
    return typeof row?.session_id === "string" && row.session_id ? row.session_id : null;
  }

  getChannelHarness(botId: string, channelId: string): string | null {
    const row = this.db
      .prepare("SELECT harness_id FROM bot_channel_state WHERE bot_id = ? AND channel_id = ?")
      .get(botId, channelId) as SqlRow | undefined;
    return typeof row?.harness_id === "string" && row.harness_id ? row.harness_id : null;
  }

  setSessionId(botId: string, channelId: string, sessionId: string | null): void {
    if (this.closed) return;
    const changed = this.db
      .prepare("UPDATE bot_channel_state SET session_id = ? WHERE bot_id = ? AND channel_id = ?")
      .run(sessionId, botId, channelId);
    if (changed.changes !== 1) {
      throw Object.assign(new Error("Bot Channel state not found"), { status: 404 });
    }
  }

  appendMessage(channelId: string, message: NewMessage): void {
    if (this.closed) return;
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO messages
            (id, channel_id, kind, sender_kind, sender_id, text, created_at, reply_to)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          message.id,
          channelId,
          message.kind ?? "text",
          message.role === "user" ? "user" : "bot",
          message.senderId,
          message.text,
          message.createdAt,
          message.replyTo ?? null,
        );
      if (message.receipt && message.recipientBotId) {
        this.db
          .prepare(
            `INSERT INTO deliveries
              (message_id, recipient_kind, recipient_id, state, updated_at)
             VALUES (?, 'bot', ?, ?, ?)`,
          )
          .run(message.id, message.recipientBotId, message.receipt, message.createdAt);
      }
    });
  }

  updateMessageText(messageId: string, text: string): void {
    if (this.closed) return;
    this.db.prepare("UPDATE messages SET text = ? WHERE id = ?").run(text, messageId);
  }

  setReceipt(messageId: string, recipientBotId: string, receipt: MessageReceipt, updatedAt: string): void {
    if (this.closed) return;
    this.db
      .prepare(
        `INSERT INTO deliveries (message_id, recipient_kind, recipient_id, state, updated_at)
         VALUES (?, 'bot', ?, ?, ?)
         ON CONFLICT(message_id, recipient_kind, recipient_id)
         DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(messageId, recipientBotId, receipt, updatedAt);
  }

  toggleReaction(messageId: string, emoji: string, createdAt: string): boolean {
    if (this.closed) return false;
    const existing = this.db
      .prepare(
        "SELECT 1 AS found FROM reactions WHERE message_id = ? AND emoji = ? AND actor_kind = 'user' AND actor_id = ?",
      )
      .get(messageId, emoji, HUMAN_MEMBER_ID) as SqlRow | undefined;
    if (existing) {
      this.db
        .prepare(
          "DELETE FROM reactions WHERE message_id = ? AND emoji = ? AND actor_kind = 'user' AND actor_id = ?",
        )
        .run(messageId, emoji, HUMAN_MEMBER_ID);
      return false;
    }
    this.db
      .prepare(
        `INSERT INTO reactions (message_id, emoji, actor_kind, actor_id, created_at)
         VALUES (?, ?, 'user', ?, ?)`,
      )
      .run(messageId, emoji, HUMAN_MEMBER_ID, createdAt);
    return true;
  }

  private migrate(): void {
    const version = readSchemaVersion(this.db);
    if (version > HOME_SCHEMA_VERSION) {
      this.db.close();
      throw newerSchemaError(version);
    }
    if (version === HOME_SCHEMA_VERSION) return;
    if (version === 3) {
      this.migrateVersionThree();
      return;
    }

    this.transaction(() => {
      if (version === 0) {
        this.db.exec(`
        CREATE TABLE bots (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          color TEXT NOT NULL,
          shape TEXT NOT NULL,
          harness TEXT,
          config_mode TEXT NOT NULL DEFAULT 'isolated',
          display INTEGER CHECK (display BETWEEN 1 AND 8),
          created_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX bots_display_unique ON bots(display);

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

        CREATE TABLE bot_provisioning (
          bot_id TEXT PRIMARY KEY,
          display INTEGER CHECK (display BETWEEN 1 AND 8),
          workspace_owned INTEGER NOT NULL DEFAULT 1 CHECK (workspace_owned IN (0, 1)),
          state TEXT NOT NULL CHECK (state IN ('preparing', 'cleanup-required')),
          cleanup_error TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE host_grants (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          access TEXT NOT NULL,
          duration TEXT NOT NULL,
          consumed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        `);
      } else if (version === 1) {
        this.db.exec(`
          ALTER TABLE bots ADD COLUMN config_mode TEXT NOT NULL DEFAULT 'isolated';
          CREATE TABLE IF NOT EXISTS host_grants (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL,
            access TEXT NOT NULL,
            duration TEXT NOT NULL,
            consumed INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
          );
        `);
      }
      if (version === 1 || version === 2) {
        this.db.exec(`
          ALTER TABLE bots ADD COLUMN display INTEGER CHECK (display BETWEEN 1 AND 8);

          CREATE TABLE bot_provisioning (
            bot_id TEXT PRIMARY KEY,
            display INTEGER CHECK (display BETWEEN 1 AND 8),
            workspace_owned INTEGER NOT NULL DEFAULT 1 CHECK (workspace_owned IN (0, 1)),
            state TEXT NOT NULL CHECK (state IN ('preparing', 'cleanup-required')),
            cleanup_error TEXT,
            created_at TEXT NOT NULL
          );
        `);
        const persistedBots = this.db.prepare("SELECT id FROM bots ORDER BY rowid").all() as SqlRow[];
        const setDisplay = this.db.prepare("UPDATE bots SET display = ? WHERE id = ?");
        persistedBots.slice(0, BOT_DISPLAY_MAX).forEach((row, index) => {
          setDisplay.run(index + 1, String(row.id));
        });
        this.db.exec("CREATE UNIQUE INDEX bots_display_unique ON bots(display);");
      }
      this.db.exec(`PRAGMA user_version = ${HOME_SCHEMA_VERSION};`);
    });
  }

  private migrateVersionThree(): void {
    this.db.exec("PRAGMA foreign_keys = OFF;");
    try {
      const foreignKeys = this.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: unknown } | undefined;
      if (foreignKeys?.foreign_keys !== 0) {
        throw new Error("Home schema migration could not suspend foreign-key enforcement");
      }
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE bots_v4_migration (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT NOT NULL,
            shape TEXT NOT NULL,
            harness TEXT,
            config_mode TEXT NOT NULL DEFAULT 'isolated',
            display INTEGER CHECK (display BETWEEN 1 AND 8),
            created_at TEXT NOT NULL
          );

          INSERT INTO bots_v4_migration
            (id, name, color, shape, harness, config_mode, display, created_at)
          SELECT id, name, color, shape, harness, config_mode, display, created_at
          FROM bots;

          DROP TABLE bots;
          ALTER TABLE bots_v4_migration RENAME TO bots;
          CREATE UNIQUE INDEX bots_display_unique ON bots(display);
        `);
        const violations = this.db.prepare("PRAGMA foreign_key_check").all();
        if (violations.length > 0) {
          throw new Error("Home schema migration would break persisted relationships");
        }
        this.db.exec(`PRAGMA user_version = ${HOME_SCHEMA_VERSION};`);
      });
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON;");
    }
  }

  private assertPersistedBotIds(): void {
    const rows = this.db.prepare("SELECT id, display FROM bots").all() as SqlRow[];
    if (rows.some((row) => !isGeneratedBotId(row.id))) throw invalidPersistedBotIdError();
    if (rows.some((row) => row.display !== null && !isBotDisplay(row.display))) {
      throw invalidPersistedBotDisplayError();
    }
    const provisioning = this.db.prepare("SELECT bot_id FROM bot_provisioning").all() as SqlRow[];
    if (provisioning.some((row) => !isGeneratedBotId(row.bot_id))) throw invalidPersistedBotIdError();
  }

  private reviveChannel(row: SqlRow): StoredChannel | null {
    if (typeof row.id !== "string" || !isChannelKind(row.kind) || typeof row.created_at !== "string") return null;
    const members = this.db
      .prepare(
        "SELECT member_kind, member_id FROM channel_members WHERE channel_id = ? ORDER BY position, member_id",
      )
      .all(row.id)
      .flatMap((member) => reviveMember(member as SqlRow));
    return {
      id: row.id,
      kind: row.kind,
      title: typeof row.title === "string" ? row.title : null,
      createdAt: row.created_at,
      members,
      messages: this.listMessages(row.id),
    };
  }

  private reviveMessage(row: SqlRow): TranscriptMessage[] {
    if (typeof row.id !== "string" || typeof row.text !== "string" || typeof row.created_at !== "string") return [];
    if (row.sender_kind !== "user" && row.sender_kind !== "bot") return [];
    const receiptRow = this.db
      .prepare(
        "SELECT state FROM deliveries WHERE message_id = ? AND recipient_kind = 'bot' ORDER BY updated_at DESC LIMIT 1",
      )
      .get(row.id) as SqlRow | undefined;
    const reactions = this.db
      .prepare(
        "SELECT emoji FROM reactions WHERE message_id = ? AND actor_kind = 'user' ORDER BY created_at, emoji",
      )
      .all(row.id)
      .flatMap((reaction) =>
        typeof (reaction as SqlRow).emoji === "string"
          ? [{ emoji: (reaction as { emoji: string }).emoji, by: "user" as const }]
          : [],
      );
    const message: TranscriptMessage = {
      id: row.id,
      role: row.sender_kind === "user" ? "user" : "assistant",
      text: row.text,
      createdAt: row.created_at,
    };
    if (row.kind === "host-grant") message.kind = "host-grant";
    if (isReceipt(receiptRow?.state)) message.receipt = receiptRow.state;
    if (typeof row.reply_to === "string" && row.reply_to) message.replyTo = row.reply_to;
    if (reactions.length) message.reactions = reactions;
    return [message];
  }

  private nextBotDisplay(): number {
    const used = new Set(
      (this.db.prepare(`
        SELECT display FROM bots WHERE display IS NOT NULL
        UNION ALL
        SELECT display FROM bot_provisioning WHERE display IS NOT NULL
      `).all() as SqlRow[])
        .map((row) => row.display)
        .filter(isBotDisplay),
    );
    const display = Array.from({ length: BOT_DISPLAY_MAX }, (_, index) => index + 1)
      .find((candidate) => !used.has(candidate));
    if (!display) throw Object.assign(new Error("Computer is out of displays"), { status: 409 });
    return display;
  }

  private insertBot(bot: StoredBot, channelId: string, display: number): StoredChannel {
    if (!isBotDisplay(display)) throw new Error("Bot display is invalid");
    const channel: StoredChannel = {
      id: channelId,
      kind: "direct",
      title: null,
      createdAt: bot.createdAt,
      members: [
        { kind: "user", id: HUMAN_MEMBER_ID },
        { kind: "bot", id: bot.id },
      ],
      messages: [],
    };
    this.db
      .prepare(
        "INSERT INTO bots (id, name, color, shape, harness, config_mode, display, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        bot.id,
        bot.name,
        bot.color,
        bot.shape,
        bot.harness,
        bot.configMode ?? "isolated",
        display,
        bot.createdAt,
      );
    this.db
      .prepare("INSERT INTO channels (id, kind, title, created_at) VALUES (?, ?, ?, ?)")
      .run(channel.id, channel.kind, channel.title, channel.createdAt);
    const insertMember = this.db.prepare(
      "INSERT INTO channel_members (channel_id, member_kind, member_id, position) VALUES (?, ?, ?, ?)",
    );
    channel.members.forEach((member, index) => {
      insertMember.run(channel.id, member.kind, member.id, index);
    });
    this.db
      .prepare(
        "INSERT INTO bot_channel_state (bot_id, channel_id, harness_id, session_id) VALUES (?, ?, ?, NULL)",
      )
      .run(bot.id, channel.id, bot.harness);
    return channel;
  }

  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The original database error is more useful.
      }
      throw err;
    }
  }
}

function reviveBot(row: SqlRow): StoredBot[] {
  if (!isGeneratedBotId(row.id)) throw invalidPersistedBotIdError();
  if (
    typeof row.name !== "string" ||
    typeof row.color !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.shape !== "string" ||
    !(SHAPES as readonly string[]).includes(row.shape)
  ) {
    return [];
  }
  const harness = typeof row.harness === "string" && isHarnessId(row.harness) ? row.harness : null;
  const configMode: ConfigMode = row.config_mode === "host" ? "host" : "isolated";
  return [
    {
      id: row.id,
      name: row.name,
      color: row.color,
      shape: row.shape as FaceShape,
      harness,
      configMode,
      createdAt: row.created_at,
    },
  ];
}

function invalidPersistedBotIdError(): Error {
  return new Error(
    "Corrupt Home: invalid persisted Bot ID; repair or remove the Bot row before restarting OpenBot",
  );
}

function isBotDisplay(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= BOT_DISPLAY_MAX;
}

function invalidPersistedBotDisplayError(): Error {
  return new Error(
    "Corrupt Home: invalid persisted Bot display; repair or remove the Bot row before restarting OpenBot",
  );
}

function reviveGrant(row: SqlRow): StoredHostGrant[] {
  if (
    typeof row.id !== "string" ||
    typeof row.path !== "string" ||
    typeof row.created_at !== "string" ||
    !isHostGrantAccess(row.access) ||
    !isHostGrantDuration(row.duration)
  ) {
    return [];
  }
  return [
    {
      id: row.id,
      path: row.path,
      access: row.access,
      duration: row.duration,
      consumed: row.consumed === 1 || row.consumed === true,
      createdAt: row.created_at,
    },
  ];
}

function reviveMember(row: SqlRow): ChannelMember[] {
  if ((row.member_kind !== "user" && row.member_kind !== "bot") || typeof row.member_id !== "string") return [];
  return [{ kind: row.member_kind, id: row.member_id }];
}

function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function isChannelKind(value: unknown): value is ChannelKind {
  return value === "direct" || value === "group" || value === "bot-to-bot";
}

function isReceipt(value: unknown): value is MessageReceipt {
  return value === "sent" || value === "delivered" || value === "read";
}

function assertSupportedSchema(databasePath: string): void {
  const probe = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const version = readSchemaVersion(probe);
    if (version > HOME_SCHEMA_VERSION) throw newerSchemaError(version);
  } finally {
    probe.close();
  }
}

function readSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
  const version = Number(row?.user_version ?? 0);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error("talk.sqlite has an invalid schema version");
  }
  return version;
}

function newerSchemaError(version: number): Error {
  return new Error(
    `talk.sqlite schema ${version} is newer than this Talk (supports ${HOME_SCHEMA_VERSION}); refusing to write`,
  );
}
