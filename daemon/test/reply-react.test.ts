import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { AcpSession } from "../src/bots.ts";
import { startBox, type RunningBox } from "../src/box.ts";
import type { SpawnSpec } from "../src/harness.ts";

const PASSWORD = "correct-horse";

type PublicReaction = { emoji: string; by: "user" };

type PublicMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt?: string;
  receipt?: "sent" | "delivered" | "read";
  replyTo?: string;
  reactions?: PublicReaction[];
};

type BotBody = {
  id: string;
  write?: boolean;
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
  let resolve!: (value?: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res as (value?: T) => void;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Gate = {
  written: ReturnType<typeof defer>;
  flushed: ReturnType<typeof defer>;
  finish: ReturnType<typeof defer>;
};

function gatedFakeAcp() {
  let handlers: TestHandlers | undefined;
  const closed = defer<Error>();
  const gates: Gate[] = [];
  let next = 0;
  const prompts: string[] = [];

  function until<T>(p: Promise<T>): Promise<T> {
    return Promise.race([
      p,
      closed.promise.then((err) => {
        throw err;
      }),
    ]);
  }

  const spawnAcp = (_spec: SpawnSpec, _cwd: string, nextHandlers?: TestHandlers): AcpSession => {
    handlers = nextHandlers;
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
      async prompt(text: string) {
        prompts.push(text);
        const gate = gates[next++];
        if (!gate) throw new Error("prompt without arm()");
        await until(gate.written.promise);
        handlers?.onPromptWritten?.();
        await until(gate.flushed.promise);
        handlers?.onPromptFlushed?.();
        await until(gate.finish.promise);
        handlers?.onAssistant?.("First.", { start: true, done: true });
        handlers?.onAssistant?.("Second.", { start: true, done: true });
        return "First.\nSecond.";
      },
      respondPermission() {},
    };
  };

  return {
    spawnAcp,
    prompts: () => prompts,
    arm(): Gate {
      const gate: Gate = { written: defer(), flushed: defer(), finish: defer() };
      gates.push(gate);
      return gate;
    },
  };
}

async function emptyPwa(): Promise<string> {
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-pwa-"));
  await writeFile(join(pwaDir, "index.html"), `<!doctype html><title>OpenBot</title>`);
  return pwaDir;
}

async function startTalk(spawnAcp: ReturnType<typeof gatedFakeAcp>["spawnAcp"], homeDir: string): Promise<RunningBox> {
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

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function releaseTurn(gate: Gate): Promise<void> {
  gate.written.resolve();
  await tick();
  gate.flushed.resolve();
  await tick();
  gate.finish.resolve();
  await tick();
}

async function openTalk() {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-ws-"));
  const fake = gatedFakeAcp();
  const box = await startTalk(fake.spawnAcp, homeDir);
  const cookie = await login(box.url);
  const id = await createTalkBot(box.url, cookie);
  return { box, fake, cookie, id, homeDir };
}

describe("Talk HTTP reply and react", () => {
  test("replyTo nests on the user bubble, keeps receipts, and survives GET plus Talk restart", async () => {
    const opened = await openTalk();
    let { box, fake, cookie, id, homeDir } = opened;
    try {
      const first = fake.arm();
      const posted = await fetch(`${box.url}/api/bots/${id}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      assert.ok(posted.ok, `POST messages failed: ${posted.status} ${await posted.text()}`);
      await releaseTurn(first);

      const afterTurn = await getBot(box.url, cookie, id);
      const target = (afterTurn.messages ?? []).find((m) => m.role === "assistant" && m.text === "First.");
      assert.ok(target?.id, "need a Bot bubble to reply to");
      const beforeCount = (afterTurn.messages ?? []).length;

      const replyGate = fake.arm();
      const replied = await fetch(`${box.url}/api/bots/${id}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "on that", replyTo: target.id }),
      });
      if (!replied.ok) {
        assert.fail(`POST reply failed: ${replied.status} ${await replied.text()}`);
      }
      const afterReply = (await replied.json()) as BotBody;
      assert.equal(afterReply.write, true, "a reply is still a Turn; write must be true");
      const userReply = (afterReply.messages ?? []).find((m) => m.text === "on that");
      assert.ok(userReply, "user reply bubble must exist");
      assert.equal(userReply.role, "user");
      assert.equal(userReply.replyTo, target.id);
      assert.equal(userReply.receipt, "sent");
      assert.equal(
        (afterReply.messages ?? []).some((m) => m.role === "user" && m.text.includes("First.")),
        false,
        "reply must not paste the target into a new main-timeline quote bubble",
      );
      assert.equal((afterReply.messages ?? []).length, beforeCount + 1);

      replyGate.written.resolve();
      await tick();
      const delivered = await getBot(box.url, cookie, id);
      const deliveredUser = (delivered.messages ?? []).find((m) => m.id === userReply.id);
      assert.equal(deliveredUser?.receipt, "delivered");
      assert.equal(deliveredUser?.replyTo, target.id);

      replyGate.flushed.resolve();
      await tick();
      const read = await getBot(box.url, cookie, id);
      const readUser = (read.messages ?? []).find((m) => m.id === userReply.id);
      assert.equal(readUser?.receipt, "read");
      assert.equal(readUser?.replyTo, target.id);

      replyGate.finish.resolve();
      await tick();

      const refreshed = await getBot(box.url, cookie, id);
      const still = (refreshed.messages ?? []).find((m) => m.id === userReply.id);
      assert.equal(still?.replyTo, target.id, "GET bot after refresh must keep replyTo");
      assert.equal(still?.receipt, "read");

      await box.close();
      box = await startTalk(fake.spawnAcp, homeDir);
      const cookie2 = await login(box.url);
      const restored = await getBot(box.url, cookie2, id);
      const persisted = (restored.messages ?? []).find((m) => m.id === userReply.id);
      assert.equal(persisted?.replyTo, target.id, "Talk restart must persist replyTo with the Channel");
    } finally {
      await box.close();
    }
  });

  test("emoji tapback toggles on the bubble, is not a new message, and persists", async () => {
    const opened = await openTalk();
    let { box, fake, cookie, id, homeDir } = opened;
    try {
      const first = fake.arm();
      const posted = await fetch(`${box.url}/api/bots/${id}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      assert.ok(posted.ok);
      await releaseTurn(first);

      const before = await getBot(box.url, cookie, id);
      const target = (before.messages ?? []).find((m) => m.role === "assistant");
      assert.ok(target?.id);
      const beforeCount = (before.messages ?? []).length;

      const reacted = await fetch(`${box.url}/api/bots/${id}/messages/${target.id}/reactions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ emoji: "❤️" }),
      });
      if (!reacted.ok) {
        assert.fail(`POST reaction failed: ${reacted.status} ${await reacted.text()}`);
      }
      const after = (await reacted.json()) as BotBody;
      assert.equal((after.messages ?? []).length, beforeCount, "a tapback must not append a new message");
      const bubbled = (after.messages ?? []).find((m) => m.id === target.id);
      assert.deepEqual(bubbled?.reactions, [{ emoji: "❤️", by: "user" }]);
      assert.equal(after.write, false);

      const again = await getBot(box.url, cookie, id);
      assert.deepEqual(
        (again.messages ?? []).find((m) => m.id === target.id)?.reactions,
        [{ emoji: "❤️", by: "user" }],
        "GET bot after refresh must keep the tapback",
      );

      await box.close();
      box = await startTalk(fake.spawnAcp, homeDir);
      cookie = await login(box.url);
      const restored = await getBot(box.url, cookie, id);
      assert.deepEqual(
        (restored.messages ?? []).find((m) => m.id === target.id)?.reactions,
        [{ emoji: "❤️", by: "user" }],
      );

      const thumbs = await fetch(`${box.url}/api/bots/${id}/messages/${target.id}/reactions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ emoji: "👍" }),
      });
      assert.ok(thumbs.ok);
      const both = ((await thumbs.json()) as BotBody).messages?.find((m) => m.id === target.id);
      assert.deepEqual(both?.reactions, [
        { emoji: "❤️", by: "user" },
        { emoji: "👍", by: "user" },
      ]);

      const toggle = await fetch(`${box.url}/api/bots/${id}/messages/${target.id}/reactions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ emoji: "❤️" }),
      });
      assert.ok(toggle.ok);
      const leftover = ((await toggle.json()) as BotBody).messages?.find((m) => m.id === target.id);
      assert.deepEqual(leftover?.reactions, [{ emoji: "👍", by: "user" }]);
    } finally {
      await box.close();
    }
  });

  test("unknown replyTo is 400, unknown reaction target is 404, nested reply still writes", async () => {
    const { box, fake, cookie, id } = await openTalk();
    try {
      const first = fake.arm();
      const posted = await fetch(`${box.url}/api/bots/${id}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      assert.ok(posted.ok);
      await releaseTurn(first);

      const current = await getBot(box.url, cookie, id);
      const target = (current.messages ?? []).find((m) => m.role === "assistant");
      assert.ok(target?.id);

      const badReply = await fetch(`${box.url}/api/bots/${id}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "nope", replyTo: "missing-bubble" }),
      });
      assert.equal(badReply.status, 400);

      const badReact = await fetch(`${box.url}/api/bots/${id}/messages/missing-bubble/reactions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ emoji: "😂" }),
      });
      assert.equal(badReact.status, 404);

      const emptyEmoji = await fetch(`${box.url}/api/bots/${id}/messages/${target.id}/reactions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ emoji: "   " }),
      });
      assert.equal(emptyEmoji.status, 400);

      const replyGate = fake.arm();
      const nested = await fetch(`${box.url}/api/bots/${id}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "nested", replyTo: target.id }),
      });
      if (!nested.ok) {
        assert.fail(`nested reply failed: ${nested.status} ${await nested.text()}`);
      }
      const body = (await nested.json()) as BotBody;
      const nestedMsg = (body.messages ?? []).find((m) => m.text === "nested");
      assert.equal(nestedMsg?.replyTo, target.id);
      assert.equal(nestedMsg?.receipt, "sent");
      assert.equal(body.write, true);

      const interruptGate = fake.arm();
      const interrupt = await fetch(`${box.url}/api/bots/${id}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "stop", replyTo: nestedMsg?.id }),
      });
      assert.equal(interrupt.status, 200, "interrupt + write must still work for a reply");
      const stopped = (await interrupt.json()) as BotBody;
      assert.equal(stopped.write, true);
      const stopMsg = (stopped.messages ?? []).find((m) => m.text === "stop");
      assert.equal(stopMsg?.replyTo, nestedMsg?.id);
      assert.equal(stopMsg?.receipt, "sent");

      await releaseTurn(interruptGate);
      replyGate.written.resolve();
      replyGate.flushed.resolve();
      replyGate.finish.resolve();
      await tick();
    } finally {
      await box.close();
    }
  });
});
