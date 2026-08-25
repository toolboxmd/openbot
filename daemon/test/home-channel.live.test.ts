import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { startBox, type RunningBox } from "../src/box.ts";
import { listHarnessesOnPath, spawnSpec } from "../src/harness.ts";
import { defaultWorkspaceDir } from "../src/home.ts";

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

async function createAda(url: string, cookie: string): Promise<string> {
  const created = await fetch(`${url}/api/bots`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada" }),
  });
  const createdBody = await created.text();
  assert.equal(created.status, 201, `create Ada failed: ${created.status} ${createdBody}`);
  const ada = JSON.parse(createdBody) as { id: string };
  const picked = await fetch(`${url}/api/bots/${ada.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ harness: "codex" }),
  });
  const pickedBody = await picked.text();
  assert.ok(picked.ok, `pick harness failed: ${picked.status} ${pickedBody}`);
  return ada.id;
}

async function postText(url: string, cookie: string, botId: string, text: string): Promise<void> {
  const posted = await fetch(`${url}/api/bots/${botId}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const postedBody = await posted.text();
  if (!posted.ok) {
    assert.fail(`POST messages failed: ${posted.status} ${postedBody}`);
  }
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


function readSessionId(homeDir: string): string | null {
  const db = new DatabaseSync(join(homeDir, "talk.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT session_id FROM bot_channel_state LIMIT 1").get() as
      | { session_id?: unknown }
      | undefined;
    return typeof row?.session_id === "string" && row.session_id ? row.session_id : null;
  } finally {
    db.close();
  }
}

function writeSessionId(homeDir: string, sessionId: string): void {
  const db = new DatabaseSync(join(homeDir, "talk.sqlite"));
  try {
    const changed = db.prepare("UPDATE bot_channel_state SET session_id = ?").run(sessionId);
    if (changed.changes !== 1) throw new Error("failed to write session_id");
  } finally {
    db.close();
  }
}


function assistantText(messages: PublicMessage[], afterCount = 0): string {
  return messages
    .filter((message) => message.role === "assistant" && message.text)
    .slice(afterCount)
    .map((message) => message.text)
    .join("\n");
}

const describeLive = liveCodexAvailable() ? describe : describe.skip;

describeLive("Live Codex Talk HTTP", () => {
  test(
    "after restart Ada replies with the first code",
    { timeout: 300_000 },
    async () => {
      const homeDir = await mkdtemp(join(tmpdir(), "openbot-live-home-"));
      const phrase = `LIVE-ORBIT-${Date.now()}`;
      const firstTurn = `Remember this exact secret code and do not shorten it: ${phrase}. Reply with a short ack.`;
      const followUp = "What was the exact secret code? Reply with only that exact LIVE-ORBIT string, including the number.";
      let box = await openBox(homeDir);
      try {
        const cookie = await login(box.url);
        const adaId = await createAda(box.url, cookie);
        await postText(box.url, cookie, adaId, firstTurn);

        const first = await pollAssistant(box.url, cookie, adaId, 1);
        assert.ok(first.some((message) => message.role === "user" && message.text.includes(phrase)));
        assert.ok(first.some((message) => message.role === "assistant" && message.text));
        await pollIdle(box.url, cookie, adaId);

        assert.equal(existsSync(join(homeDir, "talk.sqlite")), true);
        assert.equal(existsSync(join(defaultWorkspaceDir(homeDir), "talk.sqlite")), false);
        assert.equal(existsSync(join(homeDir, "bots.json")), false);
        const sessionBefore = readSessionId(homeDir);
        assert.ok(sessionBefore, "ACP session id must be stored in talk.sqlite before Talk close");

        await box.close();
        box = await openBox(homeDir);
        const sessionRestart = readSessionId(homeDir);
        assert.equal(sessionRestart, sessionBefore, "session_id must survive Talk restart");
        const cookie2 = await login(box.url);
        const restored = await getMessages(box.url, cookie2, adaId);
        assert.ok(
          restored.some((message) => message.role === "user" && message.text.includes(phrase)),
          "user bubble must survive Talk restart",
        );
        assert.ok(
          restored.some((message) => message.role === "assistant" && message.text),
          "assistant bubble must survive Talk restart",
        );
        const assistantCount = restored.filter((message) => message.role === "assistant" && message.text).length;

        await postText(box.url, cookie2, adaId, followUp);
        await pollIdle(box.url, cookie2, adaId);
        const after = await getMessages(box.url, cookie2, adaId);
        assert.ok(after.some((message) => message.role === "user" && message.text === followUp));
        const combined = assistantText(after, assistantCount);
        assert.ok(
          combined.includes(phrase),
          `second live reply must use the first code ${phrase}; got ${JSON.stringify(combined)}`,
        );
        const sessionAfter = readSessionId(homeDir);
        const livePath = sessionAfter === sessionBefore ? "session/load" : "session/new+inject";
        console.log(
          `Live Codex after restart: ${livePath}; session_id before=${sessionBefore} after=${sessionAfter}`,
        );
        if (livePath === "session/load") {
          assert.equal(sessionAfter, sessionBefore);
        } else {
          assert.ok(sessionAfter, "fallback session/new must persist a new session id");
          assert.notEqual(sessionAfter, sessionBefore);
        }
      } finally {
        await box.close();
      }
    },
  );

  test(
    "broken stored session id falls back to inject",
    { timeout: 300_000 },
    async () => {
      const homeDir = await mkdtemp(join(tmpdir(), "openbot-live-corrupt-"));
      const phrase = `LIVE-ORBIT-${Date.now()}`;
      const firstTurn = `Remember this exact secret code and do not shorten it: ${phrase}. Reply with a short ack.`;
      const followUp = "What was the exact secret code? Reply with only that exact LIVE-ORBIT string, including the number.";
      let box = await openBox(homeDir);
      try {
        const cookie = await login(box.url);
        const adaId = await createAda(box.url, cookie);
        await postText(box.url, cookie, adaId, firstTurn);
        await pollAssistant(box.url, cookie, adaId, 1);
        await pollIdle(box.url, cookie, adaId);
        const realId = readSessionId(homeDir);
        assert.ok(realId, "ACP session id must be stored before corrupt");

        await box.close();
        writeSessionId(homeDir, "bogus-session-id");
        assert.equal(readSessionId(homeDir), "bogus-session-id");

        box = await openBox(homeDir);
        const cookie2 = await login(box.url);
        const restored = await getMessages(box.url, cookie2, adaId);
        const assistantCount = restored.filter((message) => message.role === "assistant" && message.text).length;
        await postText(box.url, cookie2, adaId, followUp);
        await pollIdle(box.url, cookie2, adaId);
        const after = await getMessages(box.url, cookie2, adaId);
        const combined = assistantText(after, assistantCount);
        assert.ok(
          combined.includes(phrase),
          `inject fallback must still use the first code ${phrase}; got ${JSON.stringify(combined)}`,
        );
        const sessionAfter = readSessionId(homeDir);
        assert.ok(sessionAfter);
        assert.notEqual(sessionAfter, "bogus-session-id");
        console.log(`Live Codex corrupt-id fallback: session/new+inject; new session_id=${sessionAfter}`);
      } finally {
        await box.close();
      }
    },
  );

  test(
    "Zoom does not pause a live Codex Session",
    { timeout: 300_000 },
    async () => {
      const homeDir = await mkdtemp(join(tmpdir(), "openbot-live-zoom-"));
      const box = await openBox(homeDir);
      try {
        const cookie = await login(box.url);
        const adaId = await createAda(box.url, cookie);
        await postText(box.url, cookie, adaId, "Reply with the word go.");
        const first = await pollAssistant(box.url, cookie, adaId, 1);
        const assistantCount = first.filter((message) => message.role === "assistant" && message.text).length;
        await pollIdle(box.url, cookie, adaId);

        const zoom = await fetch(`${box.url}/api/computer/zoom`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ botId: adaId, zoom: true }),
        });
        const zoomBody = await zoom.text();
        assert.equal(zoom.status, 200, `zoom failed: ${zoom.status} ${zoomBody}`);
        const zoomed = JSON.parse(zoomBody) as { zoom?: boolean };
        assert.equal(zoomed.zoom, true);

        await postText(box.url, cookie, adaId, "Reply with the word zoomed.");
        const after = await pollAssistant(box.url, cookie, adaId, assistantCount + 1);
        const fresh = after
          .filter((message) => message.role === "assistant" && message.text)
          .slice(assistantCount);
        assert.ok(fresh.length >= 1, "Session must still reply while Zoom is on");
        await pollIdle(box.url, cookie, adaId);

        const listed = await fetch(`${box.url}/api/bots/${adaId}`, { headers: { cookie } });
        const bot = (await listed.json()) as { zoom?: boolean; write?: boolean };
        assert.equal(bot.zoom, true);
        assert.equal(bot.write, false);
      } finally {
        await box.close();
      }
    },
  );
});
