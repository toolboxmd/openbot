import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { startBox } from "../src/box.ts";
import { HUMAN_MEMBER_ID, HomeStore } from "../src/home.ts";

const PASSWORD = "correct-horse";

type PublicReaction = { emoji: string; by: "user" };

type PublicMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  replyTo?: string;
  reactions?: PublicReaction[];
};

type BotBody = {
  id: string;
  messages?: PublicMessage[];
};

function cookieHeader(res: Response): string {
  return res.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

async function emptyPwa(): Promise<string> {
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-pwa-"));
  await writeFile(join(pwaDir, "index.html"), `<!doctype html><title>OpenBot</title>`);
  return pwaDir;
}

async function login(url: string): Promise<string> {
  const res = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.ok(res.ok, `login failed: ${res.status}`);
  return cookieHeader(res);
}

async function getBot(url: string, cookie: string, id: string): Promise<BotBody> {
  const res = await fetch(`${url}/api/bots/${id}`, { headers: { cookie } });
  const text = await res.text();
  assert.ok(res.ok, `GET bot failed: ${res.status} ${text}`);
  return JSON.parse(text) as BotBody;
}

describe("Talk HTTP react without spawning ACP", () => {
  test("emoji tapback toggles on a persisted bubble and is not a new message", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-react-home-"));
    const adaId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const home = new HomeStore(homeDir);
    home.createBot(
      {
        id: adaId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: null,
        createdAt,
      },
      channelId,
    );
    home.appendMessage(channelId, {
      id: userId,
      role: "user",
      text: "hello",
      createdAt,
      senderId: HUMAN_MEMBER_ID,
      recipientBotId: adaId,
      receipt: "sent",
    });
    home.appendMessage(channelId, {
      id: assistantId,
      role: "assistant",
      text: "hi there",
      createdAt,
      senderId: adaId,
    });
    home.close();

    const box = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      homeDir,
    });
    try {
      const cookie = await login(box.url);
      const before = await getBot(box.url, cookie, adaId);
      const beforeCount = (before.messages ?? []).length;
      assert.equal(beforeCount, 2);

      const reacted = await fetch(`${box.url}/api/bots/${adaId}/messages/${assistantId}/reactions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ emoji: "❤️" }),
      });
      const reactedText = await reacted.text();
      assert.ok(reacted.ok, `POST reaction failed: ${reacted.status} ${reactedText}`);
      const after = JSON.parse(reactedText) as BotBody;
      assert.equal((after.messages ?? []).length, beforeCount, "a tapback must not append a new message");
      assert.deepEqual(
        (after.messages ?? []).find((message) => message.id === assistantId)?.reactions,
        [{ emoji: "❤️", by: "user" }],
      );

      const again = await getBot(box.url, cookie, adaId);
      assert.deepEqual(
        (again.messages ?? []).find((message) => message.id === assistantId)?.reactions,
        [{ emoji: "❤️", by: "user" }],
      );

      const thumbs = await fetch(`${box.url}/api/bots/${adaId}/messages/${assistantId}/reactions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ emoji: "👍" }),
      });
      assert.ok(thumbs.ok);
      const both = ((await thumbs.json()) as BotBody).messages?.find((message) => message.id === assistantId);
      assert.deepEqual(both?.reactions, [
        { emoji: "❤️", by: "user" },
        { emoji: "👍", by: "user" },
      ]);

      const toggle = await fetch(`${box.url}/api/bots/${adaId}/messages/${assistantId}/reactions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ emoji: "❤️" }),
      });
      assert.ok(toggle.ok);
      const leftover = ((await toggle.json()) as BotBody).messages?.find((message) => message.id === assistantId);
      assert.deepEqual(leftover?.reactions, [{ emoji: "👍", by: "user" }]);

      const badReact = await fetch(`${box.url}/api/bots/${adaId}/messages/missing-bubble/reactions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ emoji: "😂" }),
      });
      assert.equal(badReact.status, 404);

      const emptyEmoji = await fetch(`${box.url}/api/bots/${adaId}/messages/${assistantId}/reactions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ emoji: "   " }),
      });
      assert.equal(emptyEmoji.status, 400);
    } finally {
      await box.close();
    }

    const restored = new HomeStore(homeDir);
    try {
      const channel = restored.listChannels()[0];
      assert.deepEqual(
        channel?.messages.find((message) => message.id === assistantId)?.reactions,
        [{ emoji: "👍", by: "user" }],
      );
    } finally {
      restored.close();
    }
  });
});
