import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import {
  HOME_SCHEMA_VERSION,
  HomeStore,
  type StoredBot,
} from "../src/home.ts";

function tableColumns(database: DatabaseSync, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>)
    .flatMap((row) => typeof row.name === "string" ? [row.name] : []);
}

function tableExists(database: DatabaseSync, table: string): boolean {
  const row = database
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { found?: number } | undefined;
  return row?.found === 1;
}

async function seededCombinedHome(prefix: string): Promise<{
  homeDir: string;
  bot: StoredBot;
  channelId: string;
  messageId: string;
}> {
  const homeDir = await mkdtemp(join(tmpdir(), prefix));
  const bot: StoredBot = {
    id: crypto.randomUUID(),
    name: "Ada",
    color: "#ff3b5c",
    shape: "capsule",
    harness: null,
    configMode: "isolated",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const channelId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const home = new HomeStore(homeDir);
  home.createBot(bot, channelId);
  home.appendMessage(channelId, {
    id: messageId,
    role: "assistant",
    senderId: bot.id,
    text: "preserve me",
    createdAt: "2026-01-01T00:00:01.000Z",
  });
  home.close();
  return { homeDir, bot, channelId, messageId };
}

describe("combined Home schema lineage", () => {
  test("migrates the exact isolated-train schema 4 shape without losing Screen state", async () => {
    const fixture = await seededCombinedHome("openbot-combined-isolated-schema-");
    const database = new DatabaseSync(join(fixture.homeDir, "talk.sqlite"));
    database.exec(`
      DROP TABLE app_settings;
      DROP TABLE channel_reads;
      DROP INDEX messages_channel_activity;
      ALTER TABLE channels DROP COLUMN activity_sequence;
      ALTER TABLE messages DROP COLUMN card_json;
      ALTER TABLE messages DROP COLUMN activity_at;
      ALTER TABLE messages DROP COLUMN activity_sequence;
      ALTER TABLE messages DROP COLUMN revision;
      PRAGMA user_version = 4;
    `);
    database.close();

    const migrated = new HomeStore(fixture.homeDir);
    try {
      assert.equal(migrated.botDisplay(fixture.bot.id), 1);
      assert.equal(migrated.getMessage(fixture.channelId, fixture.messageId)?.text, "preserve me");
      assert.equal(migrated.readAppSettings().defaultConfigMode, "isolated");
    } finally {
      migrated.close();
    }

    const probe = new DatabaseSync(join(fixture.homeDir, "talk.sqlite"), { readOnly: true });
    try {
      assert.equal(tableExists(probe, "bot_provisioning"), true);
      assert.equal(tableExists(probe, "channel_reads"), true);
      assert.equal(tableExists(probe, "app_settings"), true);
      assert.equal(tableColumns(probe, "bots").includes("display"), true);
      assert.equal(tableColumns(probe, "messages").includes("revision"), true);
      assert.equal(tableColumns(probe, "messages").includes("activity_sequence"), true);
      assert.equal(tableColumns(probe, "messages").includes("card_json"), true);
      const version = probe.prepare("PRAGMA user_version").get() as { user_version?: number };
      assert.equal(version.user_version, HOME_SCHEMA_VERSION);
    } finally {
      probe.close();
    }
  });

  test("migrates the exact familiar-train schema 6 shape without losing Messenger state", async () => {
    const fixture = await seededCombinedHome("openbot-combined-familiar-schema-");
    const database = new DatabaseSync(join(fixture.homeDir, "talk.sqlite"));
    database.exec(`
      DROP TABLE bot_provisioning;
      DROP INDEX bots_display_unique;
      ALTER TABLE bots DROP COLUMN display;
      PRAGMA user_version = 6;
    `);
    database.close();

    const migrated = new HomeStore(fixture.homeDir);
    try {
      assert.equal(migrated.botDisplay(fixture.bot.id), 1);
      assert.equal(migrated.getMessage(fixture.channelId, fixture.messageId)?.text, "preserve me");
      assert.equal(migrated.readAppSettings().defaultConfigMode, "isolated");
    } finally {
      migrated.close();
    }

    const probe = new DatabaseSync(join(fixture.homeDir, "talk.sqlite"), { readOnly: true });
    try {
      assert.equal(tableExists(probe, "bot_provisioning"), true);
      assert.equal(tableExists(probe, "channel_reads"), true);
      assert.equal(tableExists(probe, "app_settings"), true);
      assert.equal(tableColumns(probe, "bots").includes("display"), true);
      assert.equal(tableColumns(probe, "messages").includes("revision"), true);
      assert.equal(tableColumns(probe, "messages").includes("activity_sequence"), true);
      assert.equal(tableColumns(probe, "messages").includes("card_json"), true);
      const version = probe.prepare("PRAGMA user_version").get() as { user_version?: number };
      assert.equal(version.user_version, HOME_SCHEMA_VERSION);
    } finally {
      probe.close();
    }
  });
});
