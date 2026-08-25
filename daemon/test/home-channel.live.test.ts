import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { startBox, type RunningBox } from "../src/box.ts";
import { listHarnessesOnPath, spawnSpec } from "../src/harness.ts";

const PASSWORD = "correct-horse";
const POLL_MS = 120_000;

function cookieHeader(res: Response): string {
  return res.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

function liveCodexAvailable(): boolean {
  if (!listHarnessesOnPath().some((item) => item.id === "codex")) return false;
  try {
    spawnSpec("codex");
    return true;
  } catch {
    return false;
  }
}

async function emptyPwa(): Promise<string> {
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-live-pwa-"));
  await writeFile(join(pwaDir, "index.html"), `<!doctype html><title>OpenBot</title>`);
  return pwaDir;
}

async function login(url: string): Promise<string> {
  const res = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const body = await res.text();
  assert.ok(res.ok, `login failed: ${res.status} ${body}`);
  const cookie = cookieHeader(res);
  assert.ok(cookie, "login did not return a cookie");
  return cookie;
}

type PublicMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

async function getMessages(url: string, cookie: string, botId: string): Promise<PublicMessage[]> {
  const res = await fetch(`${url}/api/bots/${botId}/messages`, { headers: { cookie } });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`GET messages failed: ${res.status} ${body}`);
  }
  const parsed = JSON.parse(body) as { messages?: PublicMessage[]; error?: string };
  return parsed.messages ?? [];
}

async function pollAssistant(
  url: string,
  cookie: string,
  botId: string,
  minAssistants: number,
  timeoutMs = POLL_MS,
): Promise<PublicMessage[]> {
  const start = Date.now();
  let last: PublicMessage[] = [];
  while (Date.now() - start < timeoutMs) {
    last = await getMessages(url, cookie, botId);
    const assistants = last.filter((message) => message.role === "assistant" && message.text);
    if (assistants.length >= minAssistants) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `timed out waiting for ${minAssistants} assistant bubble(s); last messages=${JSON.stringify(last)}`,
  );
}


async function pollIdle(url: string, cookie: string, botId: string, timeoutMs = POLL_MS): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${url}/api/bots/${botId}`, { headers: { cookie } });
    const body = await res.text();
    if (!res.ok) throw new Error(`GET bot failed: ${res.status} ${body}`);
    const bot = JSON.parse(body) as { write?: boolean };
    if (bot.write === false) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("timed out waiting for the Turn to go idle");
}

async function openBox(homeDir: string): Promise<RunningBox> {
  return startBox({
    password: PASSWORD,
    pwaDir: await emptyPwa(),
    host: "127.0.0.1",
    port: 0,
    homeDir,
  });
}

describe("Talk restart restores two Bots", () => {
  test("Ada and Bob remain after close and startBox again", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "openbot-live-two-"));
    let box = await openBox(homeDir);
    try {
      const cookie = await login(box.url);
      const adaRes = await fetch(`${box.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      });
      const adaText = await adaRes.text();
      assert.equal(adaRes.status, 201, adaText);
      const bobRes = await fetch(`${box.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Bob" }),
      });
      const bobText = await bobRes.text();
      assert.equal(bobRes.status, 201, bobText);
      const adaId = (JSON.parse(adaText) as { id: string }).id;
      const bobId = (JSON.parse(bobText) as { id: string }).id;
      await box.close();
      box = await openBox(homeDir);
      const cookie2 = await login(box.url);
      const listed = await fetch(`${box.url}/api/bots`, { headers: { cookie: cookie2 } });
      const listedText = await listed.text();
      assert.ok(listed.ok, `GET bots failed: ${listed.status} ${listedText}`);
      const body = JSON.parse(listedText) as { bots: Array<{ id: string; name: string }> };
      assert.deepEqual(body.bots.map((bot) => bot.name).sort(), ["Ada", "Bob"]);
      assert.ok(body.bots.some((bot) => bot.id === adaId));
      assert.ok(body.bots.some((bot) => bot.id === bobId));
    } finally {
      await box.close();
    }
  });
});

const describeLive = liveCodexAvailable() ? describe : describe.skip;

describeLive("Live Codex Talk HTTP", () => {
  test(
    "restart restores the Channel and a second real Codex Turn still replies",
    { timeout: 300_000 },
    async () => {
      const homeDir = await mkdtemp(join(tmpdir(), "openbot-live-home-"));
      const phrase = `LIVE-ORBIT-${Date.now()}`;
      const followUp = `LIVE-AGAIN-${Date.now()}`;
      let box = await openBox(homeDir);
      try {
        const cookie = await login(box.url);
        const created = await fetch(`${box.url}/api/bots`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ name: "Ada" }),
        });
        const createdBody = await created.text();
        assert.equal(created.status, 201, `create Ada failed: ${created.status} ${createdBody}`);
        const ada = JSON.parse(createdBody) as { id: string };
        const picked = await fetch(`${box.url}/api/bots/${ada.id}`, {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ harness: "codex" }),
        });
        const pickedBody = await picked.text();
        assert.ok(picked.ok, `pick harness failed: ${picked.status} ${pickedBody}`);

        const posted = await fetch(`${box.url}/api/bots/${ada.id}/messages`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ text: phrase }),
        });
        const postedBody = await posted.text();
        if (!posted.ok) {
          assert.fail(`POST messages failed: ${posted.status} ${postedBody}`);
        }

        const first = await pollAssistant(box.url, cookie, ada.id, 1);
        assert.ok(first.some((message) => message.role === "user" && message.text === phrase));
        assert.ok(first.some((message) => message.role === "assistant" && message.text));
        await pollIdle(box.url, cookie, ada.id);

        await box.close();
        box = await openBox(homeDir);
        const cookie2 = await login(box.url);
        const restored = await getMessages(box.url, cookie2, ada.id);
        assert.ok(
          restored.some((message) => message.role === "user" && message.text === phrase),
          "user bubble must survive Talk restart",
        );
        assert.ok(
          restored.some((message) => message.role === "assistant" && message.text),
          "assistant bubble must survive Talk restart",
        );
        const assistantCount = restored.filter((message) => message.role === "assistant" && message.text).length;

        const second = await fetch(`${box.url}/api/bots/${ada.id}/messages`, {
          method: "POST",
          headers: { cookie: cookie2, "content-type": "application/json" },
          body: JSON.stringify({ text: followUp }),
        });
        const secondBody = await second.text();
        if (!second.ok) {
          assert.fail(`second POST messages failed: ${second.status} ${secondBody}`);
        }
        const after = await pollAssistant(box.url, cookie2, ada.id, assistantCount + 1);
        assert.ok(after.some((message) => message.role === "user" && message.text === followUp));
        assert.ok(
          after.filter((message) => message.role === "assistant" && message.text).length >= assistantCount + 1,
        );
        await pollIdle(box.url, cookie2, ada.id);
      } finally {
        await box.close();
      }
    },
  );
});
