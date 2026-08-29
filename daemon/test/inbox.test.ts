import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { BotStore } from "../src/bots.ts";
import { startBox } from "../src/box.ts";
import { HomeStore } from "../src/home.ts";

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "openbot-inbox-home-"));
}

function seedUnread(homeDir: string) {
  const botId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  const home = new HomeStore(homeDir);
  home.createBot(
    {
      id: botId,
      name: "Ada",
      color: "#ff3b5c",
      shape: "capsule",
      harness: null,
      createdAt: "2026-08-27T10:00:00.000Z",
    },
    channelId,
  );
  home.appendMessage(channelId, {
    id: crypto.randomUUID(),
    role: "assistant",
    text: "Visible inbox reply",
    createdAt: "2026-08-27T10:01:00.000Z",
    senderId: botId,
  });
  home.appendMessage(channelId, {
    id: crypto.randomUUID(),
    role: "assistant",
    kind: "host-grant",
    text: "/Users/private/hidden",
    createdAt: "2026-08-27T10:02:00.000Z",
    senderId: botId,
  });
  home.close();
  return { botId, channelId };
}

function cookieHeader(res: Response): string {
  return res.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

describe("Chat inbox product state", () => {
  test("BotStore list exposes a safe real activity summary and its read transition", async () => {
    const homeDir = await tempHome();
    const { botId } = seedUnread(homeDir);
    const store = new BotStore(homeDir);
    try {
      const listed = store.list().find((bot) => bot.id === botId);
      assert.ok(listed);
      assert.equal(listed.messages, undefined);
      assert.deepEqual(listed.activity, {
        latestText: "Visible inbox reply",
        lastActivityAt: "2026-08-27T10:01:00.000Z",
        unread: true,
        cursor: { sequence: 2, revision: 1 },
      });
      assert.equal(store.markBotRead(botId, listed.activity.cursor).unread, false);
      assert.equal(store.list().find((bot) => bot.id === botId)?.activity.unread, false);
    } finally {
      store.close();
    }
  });

  test("authenticated read endpoints persist unread state and reject anonymous mutation", async () => {
    const homeDir = await tempHome();
    const { botId, channelId } = seedUnread(homeDir);
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-inbox-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const box = await startBox({
      password: "correct-horse",
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
    });
    try {
      const anonymous = await fetch(`${box.url}/api/bots/${botId}/read`, { method: "POST" });
      assert.equal(anonymous.status, 401);

      const login = await fetch(`${box.url}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "correct-horse" }),
      });
      const cookie = cookieHeader(login);
      const before = await fetch(`${box.url}/api/inbox`, { headers: { cookie } });
      const beforeBody = (await before.json()) as {
        bots: Array<{
          id: string;
          activity: {
            latestText: string | null;
            unread: boolean;
            cursor: { sequence: number; revision: number };
          };
          messages?: unknown[];
        }>;
        channels: unknown[];
      };
      const row = beforeBody.bots.find((bot) => bot.id === botId);
      assert.equal(row?.activity.latestText, "Visible inbox reply");
      assert.equal(row?.activity.unread, true);
      assert.equal(row?.messages, undefined);
      assert.ok(beforeBody.channels.length > 0);

      const missingCursor = await fetch(`${box.url}/api/bots/${botId}/read`, {
        method: "POST",
        headers: { cookie },
      });
      assert.equal(missingCursor.status, 400);

      const concurrent = new HomeStore(homeDir);
      concurrent.appendMessage(channelId, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: "Arrived after the browser snapshot",
        createdAt: "2026-08-27T10:03:00.000Z",
        senderId: botId,
      });
      concurrent.close();

      const marked = await fetch(`${box.url}/api/bots/${botId}/read`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cursor: row?.activity.cursor }),
      });
      assert.equal(marked.status, 200);
      assert.equal(((await marked.json()) as { activity: { unread: boolean } }).activity.unread, true);

      const latest = await fetch(`${box.url}/api/inbox`, { headers: { cookie } });
      const latestBody = (await latest.json()) as {
        bots: Array<{ id: string; activity: { cursor: { sequence: number; revision: number } } }>;
      };
      const latestCursor = latestBody.bots.find((bot) => bot.id === botId)?.activity.cursor;

      const channelMarked = await fetch(`${box.url}/api/channels/${channelId}/read`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cursor: latestCursor }),
      });
      assert.equal(channelMarked.status, 200);

      const after = await fetch(`${box.url}/api/inbox`, { headers: { cookie } });
      const afterBody = (await after.json()) as { bots: Array<{ id: string; activity: { unread: boolean } }> };
      assert.equal(afterBody.bots.find((bot) => bot.id === botId)?.activity.unread, false);
    } finally {
      await box.close();
    }
  });
});
