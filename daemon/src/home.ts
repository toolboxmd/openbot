import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SHAPES, type FaceShape } from "./face.ts";
import { isHarnessId, type HarnessId } from "./harness.ts";

export const HOME_SCHEMA_VERSION = 1;
export const HUMAN_MEMBER_ID = "you";

export type MessageReceipt = "sent" | "delivered" | "read";

export type MessageReaction = {
  emoji: string;
  by: "user";
};

export type TranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
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

type NewMessage = TranscriptMessage & {
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

  constructor(homeDir = defaultHomeDir()) {
    this.homeDir = path.resolve(homeDir);
    this.databasePath = path.join(this.homeDir, "talk.sqlite");
    if (fs.existsSync(this.databasePath)) assertSupportedSchema(this.databasePath);
    fs.mkdirSync(this.homeDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.homeDir, 0o700);
    if (!fs.existsSync(this.databasePath)) fs.closeSync(fs.openSync(this.databasePath, "wx", 0o600));
    this.db = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true });
    this.migrate();
    fs.chmodSync(this.databasePath, 0o600);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  listBots(): StoredBot[] {
    return this.db
      .prepare("SELECT id, name, color, shape, harness, created_at FROM bots ORDER BY created_at, id")
      .all()
      .flatMap((row) => reviveBot(row as SqlRow));
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

  createBot(bot: StoredBot, channelId: string): StoredChannel {
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
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO bots (id, name, color, shape, harness, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(bot.id, bot.name, bot.color, bot.shape, bot.harness, bot.createdAt);
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
    });
    return channel;
  }

  setHarness(botId: string, harness: HarnessId): void {
    this.transaction(() => {
      const changed = this.db.prepare("UPDATE bots SET harness = ? WHERE id = ?").run(harness, botId);
      if (changed.changes !== 1) throw Object.assign(new Error("Bot not found"), { status: 404 });
      this.db
        .prepare("UPDATE bot_channel_state SET harness_id = ?, session_id = NULL WHERE bot_id = ?")
        .run(harness, botId);
    });
  }

  appendMessage(channelId: string, message: NewMessage): void {
    if (this.closed) return;
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO messages
            (id, channel_id, kind, sender_kind, sender_id, text, created_at, reply_to)
           VALUES (?, ?, 'text', ?, ?, ?, ?, ?)`,
        )
        .run(
          message.id,
          channelId,
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
    const changed = this.db.prepare("UPDATE messages SET text = ? WHERE id = ?").run(text, messageId);
    if (changed.changes !== 1) throw new Error("message not found");
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

    this.transaction(() => {
      this.db.exec(`
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
    });
  }

  private reviveChannel(row: SqlRow): StoredChannel | null {
    if (typeof row.id !== "string" || !isChannelKind(row.kind) || typeof row.created_at !== "string") return null;
    const members = this.db
      .prepare(
        "SELECT member_kind, member_id FROM channel_members WHERE channel_id = ? ORDER BY position, member_id",
      )
      .all(row.id)
      .flatMap((member) => reviveMember(member as SqlRow));
    const messages = this.db
      .prepare(
        `SELECT id, sender_kind, text, created_at, reply_to
         FROM messages WHERE channel_id = ? ORDER BY sequence`,
      )
      .all(row.id)
      .flatMap((message) => this.reviveMessage(message as SqlRow));
    return {
      id: row.id,
      kind: row.kind,
      title: typeof row.title === "string" ? row.title : null,
      createdAt: row.created_at,
      members,
      messages,
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
    if (isReceipt(receiptRow?.state)) message.receipt = receiptRow.state;
    if (typeof row.reply_to === "string" && row.reply_to) message.replyTo = row.reply_to;
    if (reactions.length) message.reactions = reactions;
    return [message];
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
  if (
    typeof row.id !== "string" ||
    typeof row.name !== "string" ||
    typeof row.color !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.shape !== "string" ||
    !(SHAPES as readonly string[]).includes(row.shape)
  ) {
    return [];
  }
  const harness = typeof row.harness === "string" && isHarnessId(row.harness) ? row.harness : null;
  return [
    {
      id: row.id,
      name: row.name,
      color: row.color,
      shape: row.shape as FaceShape,
      harness,
      createdAt: row.created_at,
    },
  ];
}

function reviveMember(row: SqlRow): ChannelMember[] {
  if ((row.member_kind !== "user" && row.member_kind !== "bot") || typeof row.member_id !== "string") return [];
  return [{ kind: row.member_kind, id: row.member_id }];
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
