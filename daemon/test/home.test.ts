import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { startBox } from "../src/box.ts";
import { BotStore, channelHistory, talkPrompt } from "../src/bots.ts";
import { MemoryComputerRuntime } from "../src/computer.ts";
import { HUMAN_MEMBER_ID, HomeStore } from "../src/home.ts";

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "openbot-home-"));
}

function iso(offsetMs = 0): string {
  return new Date(Date.parse("2026-01-01T00:00:00.000Z") + offsetMs).toISOString();
}

describe("HomeStore sqlite", () => {
  test("persists a direct Channel transcript, members, receipts, reactions, and replyTo", async () => {
    const homeDir = await tempHome();
    const adaId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const replyId = crypto.randomUUID();

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
    home.appendMessage(channel.id, {
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
    home.appendMessage(channel.id, {
      id: assistantId,
      role: "assistant",
      text: "hi there",
      createdAt: iso(2000),
      senderId: adaId,
    });
    assert.equal(home.toggleReaction(assistantId, "❤️", iso(2100)), true);
    home.appendMessage(channel.id, {
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
    const channels = again.listChannels();
    assert.equal(channels.length, 1);
    const restored = channels[0];
    assert.ok(restored);
    assert.equal(restored.id, channelId);
    assert.equal(restored.kind, "direct");
    assert.equal(restored.members.length, 2);
    assert.deepEqual(
      restored.members.map((member) => `${member.kind}:${member.id}`).sort(),
      [`bot:${adaId}`, `user:${HUMAN_MEMBER_ID}`].sort(),
    );
    assert.equal(restored.messages.length, 3);
    const [user, assistant, reply] = restored.messages;
    assert.equal(user.id, userId);
    assert.equal(user.role, "user");
    assert.equal(user.text, "hello Ada");
    assert.equal(user.receipt, "read");
    assert.equal(assistant.id, assistantId);
    assert.equal(assistant.role, "assistant");
    assert.deepEqual(assistant.reactions, [{ emoji: "❤️", by: "user" }]);
    assert.equal(reply.id, replyId);
    assert.equal(reply.replyTo, assistantId);
    assert.equal(reply.receipt, "sent");
    again.close();
  });

  test("talk.sqlite lives under Home, not under workspace", async () => {
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
    const workspaceFiles = await readdir(workspace);
    assert.equal(
      workspaceFiles.some((name) => name.endsWith(".sqlite") || name === "talk.sqlite"),
      false,
      `workspace must stay empty of sqlite, got ${JSON.stringify(workspaceFiles)}`,
    );
  });

  test("refuses a newer schema with a read-only probe", async () => {
    const homeDir = await tempHome();
    const databasePath = join(homeDir, "talk.sqlite");
    const seed = new DatabaseSync(databasePath);
    seed.exec("PRAGMA user_version = 99");
    seed.close();

    assert.throws(() => new HomeStore(homeDir), /refusing to write/);

    const probe = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = probe.prepare("PRAGMA user_version").get() as { user_version?: number };
      assert.equal(row.user_version, 99);
    } finally {
      probe.close();
    }
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
    const history = channelHistory(
      [{ id: "u1", role: "user", text: huge, createdAt: iso() }],
      "Ada",
    );
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

describe("BotStore reattachDisplays", () => {
  test("restores Ada display 1 and Bob display 2 from HomeStore order", async () => {
    const homeDir = await tempHome();
    const adaId = crypto.randomUUID();
    const bobId = crypto.randomUUID();
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
      crypto.randomUUID(),
    );
    home.createBot(
      {
        id: bobId,
        name: "Bob",
        color: "#2f8cff",
        shape: "bean",
        harness: null,
        createdAt: iso(1000),
      },
      crypto.randomUUID(),
    );
    home.close();

    const computer = new MemoryComputerRuntime({
      cookiesDir: join(await tempHome(), "cookies"),
    });
    const store = new BotStore(homeDir, { computer });
    await store.reattachDisplays();
    assert.equal(computer.display(adaId)?.display, 1);
    assert.equal(computer.display(bobId)?.display, 2);
    const listed = store.list();
    assert.equal(listed.length, 2);
    assert.equal(listed[0]?.id, adaId);
    assert.equal(listed[1]?.id, bobId);
    assert.equal(listed[0]?.display, 1);
    assert.equal(listed[1]?.display, 2);
    store.close();
  });

  test("startBox reattaches Ada display 1 and Bob display 2", async () => {
    const homeDir = await tempHome();
    const adaId = crypto.randomUUID();
    const bobId = crypto.randomUUID();
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
      crypto.randomUUID(),
    );
    home.createBot(
      {
        id: bobId,
        name: "Bob",
        color: "#2f8cff",
        shape: "bean",
        harness: null,
        createdAt: iso(1000),
      },
      crypto.randomUUID(),
    );
    home.close();

    const computer = new MemoryComputerRuntime({
      cookiesDir: join(await tempHome(), "cookies"),
    });
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-home-pwa-"));
    await writeFile(join(pwaDir, "index.html"), `<!doctype html><title>OpenBot</title>`);
    const box = await startBox({
      password: "correct-horse",
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      computer,
    });
    try {
      assert.equal(computer.display(adaId)?.display, 1);
      assert.equal(computer.display(bobId)?.display, 2);
    } finally {
      await box.close();
    }
  });
});
