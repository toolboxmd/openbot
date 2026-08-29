import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { AcpSession } from "../src/bots.ts";
import { startBox, type RunningBox } from "../src/box.ts";
import type { SpawnSpec } from "../src/harness.ts";

const PASSWORD = "correct-horse";

type PublicMessage = {
  id: string;
  role: "user" | "assistant";
  senderId?: string;
  text: string;
  createdAt?: string;
  receipt?: "sent" | "delivered" | "read";
};

type BotBody = {
  id: string;
  write?: boolean;
  eyes?: { mode?: string };
  messages?: PublicMessage[];
};

type TestHandlers = {
  onPromptWritten?: () => void;
  onPromptFlushed?: () => void;
  onAssistant?: (text: string, delta?: { start?: boolean; done?: boolean }) => void;
};

function cookieHeader(res: Response): string {
  return res.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

function defer<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function gatedFakeAcp() {
  let handlers: TestHandlers | undefined;
  const written = defer();
  const flushed = defer();
  const finish = defer();
  const closed = defer<Error>();
  let promptCalls = 0;

  function until<T>(p: Promise<T>): Promise<T> {
    return Promise.race([
      p,
      closed.promise.then((err) => {
        throw err;
      }),
    ]);
  }

  const spawnAcp = (_spec: SpawnSpec, _cwd: string, next?: TestHandlers): AcpSession => {
    handlers = next;
    return {
      close() {
        closed.resolve(new Error("ACP closed"));
      },
      async initialize() {
        return {};
      },
      async newSession() {
        return "s1";
      },
      cancel() {},
      async prompt() {
        promptCalls += 1;
        await until(written.promise);
        handlers?.onPromptWritten?.();
        await until(flushed.promise);
        handlers?.onPromptFlushed?.();
        await until(finish.promise);
        handlers?.onAssistant?.("First.", { start: true, done: true });
        handlers?.onAssistant?.("See https://example.com/docs", { start: true, done: true });
        return "First.\nSee https://example.com/docs";
      },
      respondPermission() {},
    };
  };

  return {
    spawnAcp,
    promptCalls: () => promptCalls,
    releaseWritten: () => written.resolve(),
    releaseFlushed: () => flushed.resolve(),
    releaseFinish: () => finish.resolve(),
  };
}

async function emptyPwa(): Promise<string> {
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-pwa-"));
  await writeFile(join(pwaDir, "index.html"), `<!doctype html><title>OpenBot</title>`);
  return pwaDir;
}

async function startTalk(spawnAcp: ReturnType<typeof gatedFakeAcp>["spawnAcp"]): Promise<RunningBox> {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-ws-"));
  return startBox({
    password: PASSWORD,
    pwaDir: await emptyPwa(),
    host: "127.0.0.1",
    port: 0,
    homeDir,
    listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
    spawnAcp,
  });
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

async function createTalkBot(url: string, cookie: string): Promise<string> {
  const created = await fetch(`${url}/api/bots`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada" }),
  });
  assert.equal(created.status, 201);
  const bot = (await created.json()) as BotBody;
  const picked = await fetch(`${url}/api/bots/${bot.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ harness: "codex" }),
  });
  assert.ok(picked.ok, `pick harness failed: ${picked.status} ${await picked.text()}`);
  return bot.id;
}

async function getBot(url: string, cookie: string, id: string): Promise<BotBody> {
  const res = await fetch(`${url}/api/bots/${id}`, { headers: { cookie } });
  assert.ok(res.ok, `GET bot failed: ${res.status}`);
  return (await res.json()) as BotBody;
}

async function getMessages(url: string, cookie: string, id: string): Promise<PublicMessage[]> {
  const res = await fetch(`${url}/api/bots/${id}/messages`, { headers: { cookie } });
  assert.ok(res.ok, `GET messages failed: ${res.status}`);
  const body = (await res.json()) as { messages?: PublicMessage[] };
  return body.messages ?? [];
}

function isIsoDate(value: string | undefined): boolean {
  if (!value) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().length > 0;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("Talk HTTP Turn bubbles and receipts", () => {
  let box: RunningBox;
  const fake = gatedFakeAcp();

  after(async () => {
    if (box) await box.close();
  });

  test("a Turn persists sent then delivered then read, then several Bot bubbles", async () => {
    box = await startTalk(fake.spawnAcp);
    const cookie = await login(box.url);
    const id = await createTalkBot(box.url, cookie);

    const posted = await fetch(`${box.url}/api/bots/${id}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "Look at https://example.com/docs please" }),
    });
    assert.ok(posted.ok, `POST messages failed: ${posted.status} ${await posted.text()}`);

    const afterPost = await getBot(box.url, cookie, id);
    const viaMessages = await getMessages(box.url, cookie, id);
    assert.equal(afterPost.write, true, "GET bot must expose write:true while the Turn is in flight");
    assert.ok(
      afterPost.eyes?.mode === "write" || afterPost.eyes?.mode === "work",
      `eyes.mode must be write or work in flight, got ${afterPost.eyes?.mode}`,
    );
    assert.equal(
      (afterPost.messages ?? []).some((m) => /is working/i.test(m.text)),
      false,
      "is working must not persist in messages[]",
    );
    const user = (afterPost.messages ?? []).find((m) => m.role === "user");
    assert.ok(user, "user bubble must exist after POST");
    assert.equal(user.senderId, "you");
    assert.equal(user.text, "Look at https://example.com/docs please");
    assert.equal(user.receipt, "sent");
    assert.ok(isIsoDate(user.createdAt), `createdAt must be ISO, got ${user.createdAt}`);
    assert.ok(user.id);
    assert.equal(viaMessages.find((m) => m.id === user.id)?.receipt, "sent");
    const assistantsAfterPost = (afterPost.messages ?? []).filter((m) => m.role === "assistant" && m.text);
    assert.equal(assistantsAfterPost.length, 0, "assistant bubbles must not exist before prompt is released");
    assert.notEqual(user.receipt, "read", "must not report read before sent/delivered");
    assert.notEqual(user.receipt, "delivered");

    fake.releaseWritten();
    await tick();
    const afterDelivered = await getBot(box.url, cookie, id);
    const deliveredUser = (afterDelivered.messages ?? []).find((m) => m.id === user.id);
    assert.equal(deliveredUser?.receipt, "delivered");
    assert.equal(
      (afterDelivered.messages ?? []).filter((m) => m.role === "assistant" && m.text).length,
      0,
    );

    fake.releaseFlushed();
    await tick();
    const afterRead = await getBot(box.url, cookie, id);
    const readUser = (afterRead.messages ?? []).find((m) => m.id === user.id);
    assert.equal(readUser?.receipt, "read");
    assert.equal(
      (afterRead.messages ?? []).filter((m) => m.role === "assistant" && m.text).length,
      0,
      "read is before the turn completes; no assistant bubbles yet",
    );

    fake.releaseFinish();
    await tick();
    const done = await getBot(box.url, cookie, id);
    assert.equal(done.write, false, "write must clear when the Turn lands");
    assert.ok(
      done.eyes?.mode !== "write" && done.eyes?.mode !== "work",
      `eyes.mode must leave write/work when idle, got ${done.eyes?.mode}`,
    );
    assert.equal(
      (done.messages ?? []).some((m) => /is working/i.test(m.text)),
      false,
      "is working must not land in the transcript",
    );
    const messages = done.messages ?? [];
    const assistants = messages.filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 2, "two ACP messages must be two bubbles; server must not concatenate");
    assert.equal(assistants[0]?.text, "First.");
    assert.equal(assistants[1]?.text, "See https://example.com/docs");
    assert.equal(assistants[0]?.senderId, id);
    assert.equal(assistants[1]?.senderId, id);
    assert.notEqual(assistants[0]?.id, assistants[1]?.id);
    assert.ok(isIsoDate(assistants[0]?.createdAt));
    assert.ok(isIsoDate(assistants[1]?.createdAt));
    assert.match(assistants[1]?.text ?? "", /https:\/\/example.com\/docs/);
    assert.equal(
      assistants.some((m) => m.text === "First.See https://example.com/docs" || m.text.includes("First.\n")),
      false,
      "server must not split or join by concatenating one string",
    );

    const again = await getBot(box.url, cookie, id);
    assert.deepEqual(
      (again.messages ?? []).map((m) => m.id),
      messages.map((m) => m.id),
    );
    const laterUser = (again.messages ?? []).find((m) => m.id === user.id);
    assert.equal(laterUser?.receipt, "read");
  });
});
