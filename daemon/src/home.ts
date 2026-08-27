import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SHAPES, type FaceShape } from "./face.ts";
import { isHarnessId, type HarnessId } from "./harness.ts";
import {
  isHostGrantAccess,
  isHostGrantDuration,
  pathCoveredByGrant,
  type ConfigMode,
  type HostGrantAccess,
  type HostGrantDuration,
} from "./harness-home.ts";
import {
  expiredTranscriptCard,
  legacyHostGrantTranscriptCard,
  parseTranscriptCard,
  transcriptCardSummary,
  type TranscriptCard,
} from "./transcript-card.ts";

export const HOME_SCHEMA_VERSION = 5;
export const HUMAN_MEMBER_ID = "you";

export type MessageReceipt = "sent" | "delivered" | "read";

export type MessageReaction = {
  emoji: string;
  by: "user";
};

export type TranscriptKind = "text" | "host-grant" | "card";

export type TranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  senderId: string;
  text: string;
  createdAt: string;
  kind?: TranscriptKind;
  card?: TranscriptCard;
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

export type ChannelCursor = {
  sequence: number;
  revision: number;
};

export type NewMessage = TranscriptMessage & {
  recipientBotId?: string;
};

export type ChannelActivity = {
  latestText: string | null;
  lastActivityAt: string;
  unread: boolean;
  cursor: ChannelCursor;
};

export type StoredChannelSummary = Omit<StoredChannel, "messages"> & {
  activity: ChannelActivity;
};

type SqlRow = Record<string, unknown>;

const CHANNEL_SUMMARY_SELECT = `SELECT
  channels.id,
  channels.kind,
  channels.title,
  channels.created_at,
  (
    SELECT substr(messages.text, 1, 512)
    FROM messages
    WHERE messages.channel_id = channels.id
      AND messages.kind IN ('text', 'card')
      AND trim(messages.text) <> ''
    ORDER BY messages.activity_sequence DESC
    LIMIT 1
  ) AS latest_text,
  COALESCE((
    SELECT messages.activity_at
    FROM messages
    WHERE messages.channel_id = channels.id
      AND messages.kind IN ('text', 'card')
      AND trim(messages.text) <> ''
    ORDER BY messages.activity_sequence DESC
    LIMIT 1
  ), channels.created_at) AS last_activity_at,
  COALESCE((
    SELECT messages.activity_sequence
    FROM messages
    WHERE messages.channel_id = channels.id
    ORDER BY messages.activity_sequence DESC
    LIMIT 1
  ), 0) AS cursor_sequence,
  COALESCE((
    SELECT messages.revision
    FROM messages
    WHERE messages.channel_id = channels.id
    ORDER BY messages.activity_sequence DESC
    LIMIT 1
  ), 0) AS cursor_revision,
  EXISTS(
    SELECT 1
    FROM messages
    LEFT JOIN channel_reads ON channel_reads.channel_id = messages.channel_id
    WHERE messages.channel_id = channels.id
      AND messages.kind IN ('text', 'card')
      AND messages.sender_kind = 'bot'
      AND trim(messages.text) <> ''
      AND (
        messages.activity_sequence > COALESCE(channel_reads.last_read_sequence, 0)
        OR (
          messages.activity_sequence = COALESCE(channel_reads.last_read_sequence, 0)
          AND messages.revision > COALESCE(channel_reads.last_read_revision, 0)
        )
      )
  ) AS unread
FROM channels`;

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
    this.migrate();
    fs.chmodSync(this.databasePath, 0o600);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
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

  listChannels(): StoredChannel[] {
    const rows = this.db
      .prepare("SELECT id, kind, title, created_at FROM channels ORDER BY created_at, id")
      .all() as SqlRow[];
    return rows.flatMap((row) => {
      const channel = this.reviveChannel(row);
      return channel ? [channel] : [];
    });
  }

  listChannelSummaries(): StoredChannelSummary[] {
    const rows = this.db
      .prepare(`${CHANNEL_SUMMARY_SELECT} ORDER BY channels.created_at, channels.id`)
      .all() as SqlRow[];
    const membersByChannel = new Map<string, ChannelMember[]>();
    const memberRows = this.db
      .prepare(
        `SELECT channel_id, member_kind, member_id
         FROM channel_members
         ORDER BY channel_id, position, member_id`,
      )
      .all() as SqlRow[];
    for (const row of memberRows) {
      if (typeof row.channel_id !== "string") continue;
      const member = reviveMember(row)[0];
      if (!member) continue;
      const members = membersByChannel.get(row.channel_id) ?? [];
      members.push(member);
      membersByChannel.set(row.channel_id, members);
    }
    return rows.flatMap((row) => {
      const members = typeof row.id === "string" ? membersByChannel.get(row.id) ?? [] : [];
      const summary = this.reviveChannelSummary(row, members);
      return summary ? [summary] : [];
    });
  }

  getChannelSummary(id: string): StoredChannelSummary | null {
    const row = this.db
      .prepare(`${CHANNEL_SUMMARY_SELECT} WHERE channels.id = ?`)
      .get(id) as SqlRow | undefined;
    if (!row) return null;
    const members = this.db
      .prepare(
        `SELECT member_kind, member_id
         FROM channel_members
         WHERE channel_id = ?
         ORDER BY position, member_id`,
      )
      .all(id)
      .flatMap((member) => reviveMember(member as SqlRow));
    return this.reviveChannelSummary(row, members);
  }

  listMessages(channelId: string): TranscriptMessage[] {
    return this.db
      .prepare(
        `SELECT id, kind, sender_kind, sender_id, text, created_at, reply_to, card_json
         FROM messages WHERE channel_id = ? ORDER BY sequence`,
      )
      .all(channelId)
      .flatMap((message) => this.reviveMessage(message as SqlRow));
  }

  getMessage(channelId: string, messageId: string): TranscriptMessage | null {
    const row = this.db
      .prepare(
        `SELECT id, kind, sender_kind, sender_id, text, created_at, reply_to, card_json
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

  channelActivity(channelId: string): ChannelActivity {
    const summary = this.getChannelSummary(channelId);
    if (!summary) {
      throw Object.assign(new Error("Channel not found"), { status: 404 });
    }
    return summary.activity;
  }

  markChannelRead(channelId: string, cursor: ChannelCursor, updatedAt = new Date().toISOString()): void {
    if (this.closed) return;
    if (
      !Number.isSafeInteger(cursor.sequence)
      || cursor.sequence < 0
      || !Number.isSafeInteger(cursor.revision)
      || cursor.revision < 0
    ) {
      throw Object.assign(new Error("invalid Channel cursor"), { status: 400 });
    }
    const channel = this.db.prepare("SELECT 1 AS found FROM channels WHERE id = ?").get(channelId) as SqlRow | undefined;
    if (channel?.found !== 1) throw Object.assign(new Error("Channel not found"), { status: 404 });
    if (cursor.sequence === 0 && cursor.revision !== 0) {
      throw Object.assign(new Error("invalid Channel cursor"), { status: 400 });
    }
    if (cursor.sequence > 0) {
      const latest = this.db
        .prepare("SELECT activity_sequence AS sequence FROM channels WHERE id = ?")
        .get(channelId) as SqlRow | undefined;
      if (cursor.revision === 0 || typeof latest?.sequence !== "number" || cursor.sequence > latest.sequence) {
        throw Object.assign(new Error("invalid Channel cursor"), { status: 400 });
      }
    }
    this.db
      .prepare(
        `INSERT INTO channel_reads (channel_id, last_read_sequence, last_read_revision, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(channel_id)
         DO UPDATE SET
           last_read_sequence = CASE
             WHEN excluded.last_read_sequence > channel_reads.last_read_sequence
             THEN excluded.last_read_sequence
             ELSE channel_reads.last_read_sequence
           END,
           last_read_revision = CASE
             WHEN excluded.last_read_sequence > channel_reads.last_read_sequence
             THEN excluded.last_read_revision
             WHEN excluded.last_read_sequence = channel_reads.last_read_sequence
             THEN MAX(excluded.last_read_revision, channel_reads.last_read_revision)
             ELSE channel_reads.last_read_revision
           END,
           updated_at = CASE
             WHEN excluded.last_read_sequence > channel_reads.last_read_sequence
               OR (
                 excluded.last_read_sequence = channel_reads.last_read_sequence
                 AND excluded.last_read_revision > channel_reads.last_read_revision
               )
             THEN excluded.updated_at
             ELSE channel_reads.updated_at
           END`,
      )
      .run(channelId, cursor.sequence, cursor.revision, updatedAt);
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
          "INSERT INTO bots (id, name, color, shape, harness, config_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(bot.id, bot.name, bot.color, bot.shape, bot.harness, bot.configMode ?? "isolated", bot.createdAt);
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
      const activitySequence = this.nextChannelActivitySequence(channelId);
      this.db
        .prepare(
          `INSERT INTO messages
            (id, channel_id, kind, sender_kind, sender_id, text, created_at, reply_to,
             activity_sequence, activity_at, card_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          activitySequence,
          message.createdAt,
          message.card ? JSON.stringify(message.card) : null,
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

  updateMessageText(messageId: string, text: string, updatedAt = new Date().toISOString()): void {
    if (this.closed) return;
    this.transaction(() => {
      const row = this.db.prepare("SELECT channel_id FROM messages WHERE id = ?").get(messageId) as SqlRow | undefined;
      if (typeof row?.channel_id !== "string") return;
      const activitySequence = this.nextChannelActivitySequence(row.channel_id);
      this.db
        .prepare(
          `UPDATE messages
           SET text = ?, revision = revision + 1, activity_sequence = ?, activity_at = ?
           WHERE id = ?`,
        )
        .run(text, activitySequence, updatedAt, messageId);
    });
  }

  updateMessageCard(messageId: string, card: TranscriptCard, updatedAt = new Date().toISOString()): void {
    if (this.closed) return;
    this.transaction(() => {
      const row = this.db.prepare("SELECT channel_id FROM messages WHERE id = ? AND kind = 'card'").get(messageId) as SqlRow | undefined;
      if (typeof row?.channel_id !== "string") {
        throw Object.assign(new Error("Transcript Card not found"), { status: 404 });
      }
      const activitySequence = this.nextChannelActivitySequence(row.channel_id);
      this.db
        .prepare(
          `UPDATE messages
           SET text = ?, card_json = ?, revision = revision + 1, activity_sequence = ?, activity_at = ?
           WHERE id = ?`,
        )
        .run(transcriptCardSummary(card), JSON.stringify(card), activitySequence, updatedAt, messageId);
    });
  }

  resolveHostGrantCard(
    messageId: string,
    card: TranscriptCard,
    grantInput: { path: string; access: HostGrantAccess; duration: HostGrantDuration } | null,
    updatedAt = new Date().toISOString(),
  ): StoredHostGrant | null {
    if (this.closed) throw new Error("Home is closed");
    const grant = grantInput && grantInput.duration !== "once"
      ? {
          id: crypto.randomUUID(),
          path: path.resolve(grantInput.path),
          access: grantInput.access,
          duration: grantInput.duration,
          consumed: false,
          createdAt: updatedAt,
        }
      : null;
    this.transaction(() => {
      const row = this.db.prepare("SELECT channel_id FROM messages WHERE id = ? AND kind = 'card'").get(messageId) as SqlRow | undefined;
      if (typeof row?.channel_id !== "string") {
        throw Object.assign(new Error("Transcript Card not found"), { status: 404 });
      }
      if (grant?.duration === "until-revoked") {
        this.db
          .prepare(
            `INSERT INTO host_grants (id, path, access, duration, consumed, created_at)
             VALUES (?, ?, ?, ?, 0, ?)`,
          )
          .run(grant.id, grant.path, grant.access, grant.duration, grant.createdAt);
      }
      const activitySequence = this.nextChannelActivitySequence(row.channel_id);
      this.db
        .prepare(
          `UPDATE messages
           SET text = ?, card_json = ?, revision = revision + 1, activity_sequence = ?, activity_at = ?
           WHERE id = ?`,
        )
        .run(transcriptCardSummary(card), JSON.stringify(card), activitySequence, updatedAt, messageId);
    });
    if (grant?.duration === "session") this.sessionGrants.push(grant);
    return grant;
  }

  expirePendingTranscriptCards(updatedAt = new Date().toISOString()): void {
    if (this.closed) return;
    const rows = this.db
      .prepare("SELECT id, card_json FROM messages WHERE kind = 'card' AND card_json IS NOT NULL")
      .all() as SqlRow[];
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.card_json !== "string") continue;
      try {
        const card = parseTranscriptCard(JSON.parse(row.card_json) as unknown);
        if (!card || card.status.tone !== "waiting" || card.actions.length === 0) continue;
        this.updateMessageCard(row.id, expiredTranscriptCard(card), updatedAt);
      } catch {
        // Malformed private state stays hidden and cannot become actionable.
      }
    }
  }

  deleteMessage(messageId: string): boolean {
    if (this.closed) return false;
    return this.transaction(() => {
      this.db
        .prepare("UPDATE messages SET reply_to = NULL, revision = revision + 1 WHERE reply_to = ?")
        .run(messageId);
      const deleted = this.db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
      return deleted.changes === 1;
    });
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
          created_at TEXT NOT NULL
        );

        CREATE TABLE channels (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('direct', 'group', 'bot-to-bot')),
          title TEXT,
          activity_sequence INTEGER NOT NULL DEFAULT 0,
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
          revision INTEGER NOT NULL DEFAULT 1,
          activity_sequence INTEGER NOT NULL,
          activity_at TEXT NOT NULL,
          id TEXT NOT NULL UNIQUE,
          channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
          kind TEXT NOT NULL DEFAULT 'text',
          sender_kind TEXT NOT NULL CHECK (sender_kind IN ('user', 'bot')),
          sender_id TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          reply_to TEXT REFERENCES messages(id),
          card_json TEXT
        );

        CREATE INDEX messages_channel_sequence ON messages(channel_id, sequence);
        CREATE INDEX messages_channel_activity ON messages(channel_id, activity_sequence DESC);

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

        CREATE TABLE channel_reads (
          channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
          last_read_sequence INTEGER NOT NULL DEFAULT 0,
          last_read_revision INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
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
      }
      if (version === 1) {
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
      if (version <= 2) {
        if (version > 0 && !tableHasColumn(this.db, "messages", "revision")) {
          this.db.exec("ALTER TABLE messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;");
        }
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS channel_reads (
            channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
            last_read_sequence INTEGER NOT NULL DEFAULT 0,
            last_read_revision INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
          );
        `);
        if (version > 0) {
          this.db.exec(`
            INSERT INTO channel_reads (channel_id, last_read_sequence, last_read_revision, updated_at)
            SELECT
              channels.id,
              COALESCE(messages.sequence, 0),
              COALESCE(messages.revision, 0),
              COALESCE(messages.created_at, channels.created_at)
            FROM channels
            LEFT JOIN messages ON messages.sequence = (
              SELECT MAX(latest.sequence)
              FROM messages AS latest
              WHERE latest.channel_id = channels.id
            )
            ON CONFLICT(channel_id) DO NOTHING;
          `);
        }
      }
      if (version <= 3) {
        if (!tableHasColumn(this.db, "messages", "activity_sequence")) {
          this.db.exec("ALTER TABLE messages ADD COLUMN activity_sequence INTEGER NOT NULL DEFAULT 0;");
        }
        if (!tableHasColumn(this.db, "messages", "activity_at")) {
          this.db.exec("ALTER TABLE messages ADD COLUMN activity_at TEXT NOT NULL DEFAULT '';");
        }
        this.db.exec(`
          UPDATE messages
          SET activity_sequence = sequence
          WHERE activity_sequence = 0;
          UPDATE messages
          SET activity_at = created_at
          WHERE activity_at = '';
        `);
        if (!tableHasColumn(this.db, "channels", "activity_sequence")) {
          this.db.exec("ALTER TABLE channels ADD COLUMN activity_sequence INTEGER NOT NULL DEFAULT 0;");
        }
        this.db.exec(`
          UPDATE channels
          SET activity_sequence = COALESCE((
            SELECT MAX(messages.activity_sequence)
            FROM messages
            WHERE messages.channel_id = channels.id
          ), 0);
          CREATE INDEX IF NOT EXISTS messages_channel_activity
            ON messages(channel_id, activity_sequence DESC);
        `);
      }
      if (version <= 4 && !tableHasColumn(this.db, "messages", "card_json")) {
        this.db.exec("ALTER TABLE messages ADD COLUMN card_json TEXT;");
      }
      if (version <= 4) {
        const legacyCards = this.db
          .prepare("SELECT id, text FROM messages WHERE kind = 'host-grant'")
          .all() as SqlRow[];
        const migrateCard = this.db.prepare(
          "UPDATE messages SET kind = 'card', text = ?, card_json = ? WHERE id = ?",
        );
        for (const row of legacyCards) {
          if (typeof row.id !== "string" || typeof row.text !== "string") continue;
          const card = legacyHostGrantTranscriptCard(row.text);
          migrateCard.run(transcriptCardSummary(card), JSON.stringify(card), row.id);
        }
      }
      this.db.exec(`PRAGMA user_version = ${HOME_SCHEMA_VERSION};`);
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
    return {
      id: row.id,
      kind: row.kind,
      title: typeof row.title === "string" ? row.title : null,
      createdAt: row.created_at,
      members,
      messages: this.listMessages(row.id),
    };
  }

  private reviveChannelSummary(row: SqlRow, members: ChannelMember[]): StoredChannelSummary | null {
    if (
      typeof row.id !== "string"
      || !isChannelKind(row.kind)
      || typeof row.created_at !== "string"
      || typeof row.last_activity_at !== "string"
      || typeof row.cursor_sequence !== "number"
      || typeof row.cursor_revision !== "number"
    ) {
      return null;
    }
    return {
      id: row.id,
      kind: row.kind,
      title: typeof row.title === "string" ? row.title : null,
      createdAt: row.created_at,
      members,
      activity: {
        latestText: typeof row.latest_text === "string" ? row.latest_text : null,
        lastActivityAt: row.last_activity_at,
        unread: row.unread === 1,
        cursor: { sequence: row.cursor_sequence, revision: row.cursor_revision },
      },
    };
  }

  private reviveMessage(row: SqlRow): TranscriptMessage[] {
    if (
      typeof row.id !== "string"
      || typeof row.sender_id !== "string"
      || typeof row.text !== "string"
      || typeof row.created_at !== "string"
    ) return [];
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
      senderId: row.sender_id,
      text: row.text,
      createdAt: row.created_at,
    };
    if (row.kind === "host-grant") message.kind = "host-grant";
    if (row.kind === "card" && typeof row.card_json === "string") {
      try {
        const card = parseTranscriptCard(JSON.parse(row.card_json) as unknown);
        if (card) {
          message.kind = "card";
          message.card = card;
        }
      } catch {
        // Keep malformed private state out of the public Transcript.
      }
    }
    if (isReceipt(receiptRow?.state)) message.receipt = receiptRow.state;
    if (typeof row.reply_to === "string" && row.reply_to) message.replyTo = row.reply_to;
    if (reactions.length) message.reactions = reactions;
    return [message];
  }

  private nextChannelActivitySequence(channelId: string): number {
    const changed = this.db
      .prepare("UPDATE channels SET activity_sequence = activity_sequence + 1 WHERE id = ?")
      .run(channelId);
    if (changed.changes !== 1) throw Object.assign(new Error("Channel not found"), { status: 404 });
    const row = this.db
      .prepare("SELECT activity_sequence FROM channels WHERE id = ?")
      .get(channelId) as SqlRow | undefined;
    if (typeof row?.activity_sequence !== "number") {
      throw new Error("could not allocate Channel activity sequence");
    }
    return row.activity_sequence;
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

function tableHasColumn(database: DatabaseSync, table: string, column: string): boolean {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  return rows.some((row) => row.name === column);
}

function newerSchemaError(version: number): Error {
  return new Error(
    `talk.sqlite schema ${version} is newer than this Talk (supports ${HOME_SCHEMA_VERSION}); refusing to write`,
  );
}
