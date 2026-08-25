import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { startBox } from "../src/box.ts";

const PASSWORD = "correct-horse";

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

describe("Talk HTTP messages without a Harness", () => {
  test("new Bot has an empty Channel and send requires a Harness", async () => {
    const box = await startBox({
      password: PASSWORD,
      pwaDir: await emptyPwa(),
      host: "127.0.0.1",
      port: 0,
      homeDir: await mkdtemp(join(tmpdir(), "openbot-msg-home-")),
    });
    try {
      const cookie = await login(box.url);
      const created = await fetch(`${box.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      });
      const createdText = await created.text();
      assert.equal(created.status, 201, createdText);
      const bot = JSON.parse(createdText) as { id: string };
      const messages = await fetch(`${box.url}/api/bots/${bot.id}/messages`, { headers: { cookie } });
      assert.ok(messages.ok, `GET messages failed: ${messages.status}`);
      const thread = (await messages.json()) as { channelId?: string; messages?: unknown[] };
      assert.ok(thread.channelId);
      assert.deepEqual(thread.messages, []);

      const posted = await fetch(`${box.url}/api/bots/${bot.id}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      assert.equal(posted.status, 400);
      const body = (await posted.json()) as { error?: string };
      assert.match(body.error ?? "", /Harness/i);
    } finally {
      await box.close();
    }
  });
});
