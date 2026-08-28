import assert from "node:assert/strict";
import crypto from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  AcpClient,
  type AcpHandlers,
  type PermissionPrompt,
} from "../src/acp.ts";
import { BotStore } from "../src/bots.ts";
import { startBox, type RunningBox } from "../src/box.ts";
import type { SpawnSpec } from "../src/harness.ts";
import { HomeStore } from "../src/home.ts";
import {
  hostGrantTranscriptCard,
  type TranscriptCard,
} from "../src/transcript-card.ts";

const REQUESTED_HOST_PATH = "/tmp/openbot-permission-flush-host.txt";

const PERMISSION_ACP = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const mode = process.argv[1];
const receiptFile = process.argv[2];
const healthyText = process.argv[3] || "Recovered on a fresh permission client.";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let promptId = null;

process.on("SIGTERM", () => {});
if (mode === "preflush") {
  setInterval(() => {}, 1_000);
}

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 990 && message.error?.code === -32601) {
    fs.writeFileSync(receiptFile + ".later-seen", "seen");
    return;
  }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "permission-flush-session" } });
    return;
  }
  if (message.method === "session/load" || message.method === "session/resume") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    if (mode === "healthy") {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "permission-flush-session",
            update: {
              sessionUpdate: "agent_message",
              content: { type: "text", text: healthyText },
              messageId: "fresh-permission-recovery"
            }
          }
        })
        + "\n"
        + JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { stopReason: "end_turn" }
        })
        + "\n"
      );
      return;
    }
    const permission = {
      jsonrpc: "2.0",
      id: 700,
      method: "session/request_permission",
      params: {
        sessionId: "permission-flush-session",
        title: "Allow the controlled provider action?",
        toolCall: {
          title: "Controlled provider action",
          kind: "execute",
          locations: [{ path: "/tmp/openbot-permission-flush-host.txt" }]
        },
        options: [
          { optionId: "provider-allow-once", name: "Allow", kind: "allow_once" },
          { optionId: "provider-reject-once", name: "Deny", kind: "reject_once" }
        ]
      }
    };
    if (mode === "stale-detached") {
      process.stdout.write(
        JSON.stringify(permission)
        + "\n"
        + JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "permission-flush-session",
            update: {
              sessionUpdate: "agent_message",
              content: { type: "text", text: "Block the later callback." },
              messageId: "stale-detached-blocker"
            }
          }
        })
        + "\n"
      );
      return;
    }
    if (mode === "preflush") {
      process.stdout.write(JSON.stringify(permission) + "\n", () => {
        input.close();
        fs.closeSync(0);
        fs.writeFileSync(receiptFile + ".closed", "closed");
      });
      return;
    }
    if (mode === "supersede") {
      process.stdout.write(
        JSON.stringify(permission)
        + "\n"
        + JSON.stringify({ ...permission, id: 701 })
        + "\n"
      );
      return;
    }
    send(permission);
    return;
  }
  if (message.id === 700 && message.result?.outcome?.outcome === "selected") {
    fs.appendFileSync(receiptFile, JSON.stringify({
      rpcId: message.id,
      optionId: message.result.outcome.optionId
    }) + "\n");
    if (mode === "later-callback" && promptId !== null) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "permission-flush-session",
            update: {
              sessionUpdate: "agent_message",
              content: { type: "text", text: "LATER-CALLBACK-FAILURE" },
              messageId: "later-callback-failure"
            }
          }
        })
        + "\n"
        + JSON.stringify({
          jsonrpc: "2.0",
          id: 990,
          method: "fixture/later_callback_seen",
          params: {}
        })
        + "\n"
        + JSON.stringify({
          jsonrpc: "2.0",
          id: promptId,
          result: { stopReason: "end_turn" }
        })
        + "\n"
      );
      return;
    }
    if (mode !== "supersede" && mode !== "stale-detached" && promptId !== null) {
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    }
  }
});
`;

type PermissionBot = {
  id: string;
  write: boolean;
  permission: {
    cardId?: string;
    options: Array<{ optionId: string; name: string; kind?: string }>;
    hostGrant?: { path: string; requested: "read" | "read-write" };
  } | null;
  messages: Array<{
    id: string;
    text?: string;
    card?: TranscriptCard;
  }>;
};

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

async function login(box: RunningBox): Promise<string> {
  const response = await fetch(`${box.url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "correct-horse" }),
  });
  assert.equal(response.status, 200);
  return cookieHeader(response);
}

async function createBot(box: RunningBox, cookie: string, name: string): Promise<string> {
  const created = await fetch(`${box.url}/api/bots`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  assert.equal(created.status, 201);
  const botId = ((await created.json()) as { id: string }).id;
  const selected = await fetch(`${box.url}/api/bots/${botId}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ harness: "codex" }),
  });
  assert.equal(selected.status, 200);
  return botId;
}

async function getBot(box: RunningBox, cookie: string, botId: string): Promise<PermissionBot> {
  const response = await fetch(`${box.url}/api/bots/${botId}`, { headers: { cookie } });
  assert.equal(response.status, 200);
  return response.json() as Promise<PermissionBot>;
}

async function waitForBot(
  box: RunningBox,
  cookie: string,
  botId: string,
  predicate: (bot: PermissionBot) => boolean,
  message: string,
): Promise<PermissionBot> {
  const deadline = Date.now() + 2_000;
  let bot = await getBot(box, cookie, botId);
  while (!predicate(bot) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    bot = await getBot(box, cookie, botId);
  }
  assert.equal(predicate(bot), true, `${message}: ${JSON.stringify(bot)}`);
  return bot;
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("timed out waiting for provider receipt");
}

async function within<T>(promise: Promise<T>, milliseconds = 1_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("operation stayed pending")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function processGroupExists(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessGroupGone(groupId: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (processGroupExists(groupId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(processGroupExists(groupId), false, `ACP process group ${groupId} survived`);
}

const TEST_HARNESSES = () => [{ id: "codex" as const, name: "Codex", bin: "codex", talk: true }];

type FixtureBoxOptions = Partial<Pick<
  Parameters<typeof startBox>[0],
  "botStore" | "listHarnesses" | "spawnAcp"
>>;

async function createPermissionFixture(prefix: string) {
  const homeDir = await mkdtemp(join(tmpdir(), `${prefix}-home-`));
  const pwaDir = await mkdtemp(join(tmpdir(), `${prefix}-pwa-`));
  const receiptFile = join(homeDir, "provider-receipts.jsonl");
  await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
  const clients: AcpClient[] = [];
  const pids: number[] = [];
  const boxes = new Set<RunningBox>();

  const spawn = (
    cwd: string,
    handlers: AcpHandlers,
    mode: string,
    healthyText?: string,
  ): AcpClient => {
    const client = new AcpClient({
      command: process.execPath,
      args: ["-e", PERMISSION_ACP, mode, receiptFile, healthyText ?? ""],
      env: { ...process.env },
    }, cwd, handlers, { startDeadlineMs: 1_000, terminateGraceMs: 25 });
    clients.push(client);
    if (client.pid) pids.push(client.pid);
    return client;
  };

  const start = async (options: FixtureBoxOptions = {}): Promise<RunningBox> => {
    const box = await startBox({
      password: "correct-horse",
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      listHarnesses: TEST_HARNESSES,
      ...options,
    });
    boxes.add(box);
    return box;
  };

  const stop = async (box: RunningBox): Promise<void> => {
    boxes.delete(box);
    await box.close();
  };

  const cleanup = async (): Promise<void> => {
    for (const box of boxes) await box.close();
    boxes.clear();
    for (const client of clients) client.close();
    for (const pid of pids) await waitForProcessGroupGone(pid);
    await rm(homeDir, { recursive: true, force: true });
    await rm(pwaDir, { recursive: true, force: true });
  };

  return { homeDir, receiptFile, pids, spawn, start, stop, cleanup };
}

function activateDormantHostGrant(
  store: BotStore,
  botId: string,
  requestedPath = REQUESTED_HOST_PATH,
): { cardId: string; home: HomeStore } {
  type RuntimePermission = PermissionPrompt & {
    cardId?: string;
    hostGrant?: { path: string; requested: "read" | "read-write" };
  };
  const internals = store as unknown as {
    home: HomeStore;
    bots: Map<string, { permission: RuntimePermission | null }>;
  };
  const runtime = internals.bots.get(botId);
  const permission = runtime?.permission;
  assert.ok(permission?.cardId);
  const channelId = internals.home.directChannelId(botId);
  assert.ok(channelId);
  const current = internals.home.getMessage(channelId, permission.cardId);
  assert.equal(current?.card?.kind, "permission");
  internals.home.updateMessageCard(
    permission.cardId,
    hostGrantTranscriptCard(requestedPath, "read-write", permission.options),
  );
  permission.hostGrant = { path: requestedPath, requested: "read-write" };
  return { cardId: permission.cardId, home: internals.home };
}

describe("permission response flush truth", () => {
  test("a flushed generic choice with a failed durable commit becomes one non-actionable Card", async () => {
    const fixture = await createPermissionFixture("openbot-permission-flush");
    const { homeDir, receiptFile, pids } = fixture;
    let spawned = 0;
    const spawnAcp = (
      _spec: SpawnSpec,
      cwd: string,
      handlers: AcpHandlers = {},
    ) => {
      spawned += 1;
      return fixture.spawn(
        cwd,
        handlers,
        spawned === 1 ? "normal" : "healthy",
        "Recovered after the unconfirmed permission commit.",
      );
    };
    const store = new BotStore(homeDir, {
      listHarnesses: TEST_HARNESSES,
      spawnAcp,
    });
    const internals = store as unknown as {
      home: {
        updateMessageCard(messageId: string, card: TranscriptCard, updatedAt?: string): void;
      };
    };
    const updateMessageCard = internals.home.updateMessageCard.bind(internals.home);
    let failResolvedCommit = true;
    internals.home.updateMessageCard = (messageId, card, updatedAt) => {
      if (
        failResolvedCommit
        && card.kind === "permission"
        && card.status.label === "Allowed once"
      ) {
        failResolvedCommit = false;
        throw new Error("PRIVATE-DURABLE-PERMISSION-COMMIT");
      }
      updateMessageCard(messageId, card, updatedAt);
    };

    const box = await fixture.start({ botStore: store });
    try {
      const cookie = await login(box);
      const botId = await createBot(box, cookie, "Ada");
      const sent = await fetch(`${box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Trigger one generic permission." }),
      });
      assert.equal(sent.status, 200);
      const pending = await waitForBot(
        box,
        cookie,
        botId,
        (bot) => Boolean(bot.permission?.cardId),
        "generic permission Card did not appear",
      );
      const cardId = pending.permission?.cardId;
      assert.equal(typeof cardId, "string");

      const answered = await fetch(`${box.url}/api/bots/${botId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cardId, optionId: "provider-allow-once" }),
      });
      assert.equal(answered.status, 409);
      const publicError = await answered.text();
      assert.match(publicError, /sent.*could not confirm/i);
      assert.doesNotMatch(publicError, /PRIVATE-|ACP transport|callback|stack|credential|\/Users\//i);

      await waitForFile(receiptFile);
      const receipts = (await readFile(receiptFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { rpcId: number; optionId: string });
      assert.deepEqual(receipts, [{ rpcId: 700, optionId: "provider-allow-once" }]);

      const unconfirmed = await waitForBot(
        box,
        cookie,
        botId,
        (bot) => (
          bot.permission === null
          && bot.messages.some((message) => (
            message.id === cardId
            && message.card?.status.label === "No longer available"
            && message.card.actions.length === 0
          ))
        ),
        "flushed permission did not become non-actionable history",
      );
      const permissionCards = unconfirmed.messages.filter((message) => message.card?.kind === "permission");
      assert.equal(permissionCards.length, 1);
      assert.equal(permissionCards[0]?.id, cardId);
      assert.equal(unconfirmed.messages.filter((message) => message.card?.kind === "bot-failure").length, 0);
      assert.doesNotMatch(
        JSON.stringify(unconfirmed),
        /PRIVATE-|ACP transport callback failed|ACP_CALLBACK_FAILED|node:|\/Users\//,
      );

      const duplicate = await fetch(`${box.url}/api/bots/${botId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cardId, optionId: "provider-allow-once" }),
      });
      assert.equal(duplicate.status, 409);
      assert.equal(
        (await readFile(receiptFile, "utf8")).trim().split("\n").length,
        1,
      );
      assert.ok(pids[0]);
      await waitForProcessGroupGone(pids[0]);

      const recoverySend = await fetch(`${box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Recover after the unconfirmed permission." }),
      });
      assert.equal(recoverySend.status, 200);
      const recovered = await waitForBot(
        box,
        cookie,
        botId,
        (bot) => (
          bot.write === false
          && bot.messages.some((message) => (
            message.text === "Recovered after the unconfirmed permission commit."
          ))
        ),
        "post-flush failure did not admit a fresh client",
      );
      assert.equal(spawned, 2);
      assert.equal(recovered.messages.filter((message) => message.id === cardId).length, 1);
      assert.equal(
        recovered.messages.filter((message) => (
          message.text === "Recovered after the unconfirmed permission commit."
        )).length,
        1,
      );
      assert.equal((await readFile(receiptFile, "utf8")).trim().split("\n").length, 1);
    } finally {
      await fixture.cleanup();
    }
  });

  test("an external HTTP answer stays serialized when a later callback fails after its commit", async () => {
    const fixture = await createPermissionFixture("openbot-permission-later-callback");
    const spawnCounts = new Map<string, number>();
    let failingCwd: string | null = null;
    let signalCommit!: () => void;
    const committed = new Promise<void>((resolve) => { signalCommit = resolve; });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const spawnAcp = (
      _spec: SpawnSpec,
      cwd: string,
      handlers: AcpHandlers = {},
    ) => {
      if (failingCwd === null) failingCwd = cwd;
      const attempt = (spawnCounts.get(cwd) ?? 0) + 1;
      spawnCounts.set(cwd, attempt);
      const isFirstFailingClient = cwd === failingCwd && attempt === 1;
      const client = fixture.spawn(
        cwd,
        handlers,
        isFirstFailingClient ? "later-callback" : "healthy",
        cwd === failingCwd
          ? "Recovered after the later callback failure."
          : "Unrelated Bot survived the later callback failure.",
      );
      if (isFirstFailingClient) {
        const respondPermission = client.respondPermission.bind(client);
        client.respondPermission = (rpcId, optionId, onFlushed) => respondPermission(
          rpcId,
          optionId,
          async () => {
            await onFlushed?.();
            signalCommit();
            await commitGate;
          },
        );
      }
      return client;
    };
    const store = new BotStore(fixture.homeDir, {
      listHarnesses: TEST_HARNESSES,
      spawnAcp,
    });
    const internals = store as unknown as {
      home: {
        appendMessage(channelId: string, message: { text?: string }): void;
      };
    };
    const appendMessage = internals.home.appendMessage.bind(internals.home);
    let failLaterCallback = true;
    internals.home.appendMessage = (channelId, message) => {
      if (failLaterCallback && message.text === "LATER-CALLBACK-FAILURE") {
        failLaterCallback = false;
        throw new Error("PRIVATE-LATER-CALLBACK-FAILURE");
      }
      appendMessage(channelId, message);
    };

    const box = await fixture.start({ botStore: store });
    try {
      const cookie = await login(box);
      const failingBotId = await createBot(box, cookie, "Ada");
      const healthyBotId = await createBot(box, cookie, "Grace");
      const sent = await fetch(`${box.url}/api/bots/${failingBotId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Commit before the later callback fails." }),
      });
      assert.equal(sent.status, 200);
      const pending = await waitForBot(
        box,
        cookie,
        failingBotId,
        (bot) => Boolean(bot.permission?.cardId),
        "later-callback permission Card did not appear",
      );
      const cardId = pending.permission?.cardId;
      assert.equal(typeof cardId, "string");

      const healthySend = await fetch(`${box.url}/api/bots/${healthyBotId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Stay alive during Ada's later callback failure." }),
      });
      assert.equal(healthySend.status, 200);
      await waitForBot(
        box,
        cookie,
        healthyBotId,
        (bot) => bot.messages.some((message) => (
          message.text === "Unrelated Bot survived the later callback failure."
        )),
        "unrelated Bot did not finish before the contained failure",
      );

      const answerPromise = fetch(`${box.url}/api/bots/${failingBotId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cardId, optionId: "provider-allow-once" }),
      });
      let answerSettled = false;
      void answerPromise.then(
        () => { answerSettled = true; },
        () => { answerSettled = true; },
      );
      await within(committed);
      await waitForFile(fixture.receiptFile);
      await waitForFile(`${fixture.receiptFile}.later-seen`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(answerSettled, false, "HTTP answer escaped its serialized flush callback");
      releaseCommit();

      const answered = await within(answerPromise);
      assert.equal(answered.status, 200, await answered.text());
      const settled = await waitForBot(
        box,
        cookie,
        failingBotId,
        (bot) => (
          bot.write === false
          && bot.permission === null
          && bot.messages.some((message) => (
            message.id === cardId
            && message.card?.status.label === "Allowed once"
            && message.card.actions.length === 0
          ))
        ),
        "later callback failure retroactively unconfirmed the committed Card",
      );
      assert.equal(settled.messages.filter((message) => message.id === cardId).length, 1);
      assert.doesNotMatch(
        JSON.stringify(settled),
        /PRIVATE-LATER-CALLBACK-FAILURE|ACP_CALLBACK_FAILED|ACP transport callback failed/,
      );
      assert.deepEqual(
        (await readFile(fixture.receiptFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
        [{ rpcId: 700, optionId: "provider-allow-once" }],
      );
      assert.ok(fixture.pids[0]);
      await waitForProcessGroupGone(fixture.pids[0]);

      const recovery = await fetch(`${box.url}/api/bots/${failingBotId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Recover after the later callback failure." }),
      });
      assert.equal(recovery.status, 200);
      await waitForBot(
        box,
        cookie,
        failingBotId,
        (bot) => bot.messages.some((message) => (
          message.text === "Recovered after the later callback failure."
        )),
        "contained later callback failure did not admit a fresh client",
      );
      assert.ok(failingCwd);
      assert.equal(spawnCounts.get(failingCwd), 2);
      assert.equal((await readFile(fixture.receiptFile, "utf8")).trim().split("\n").length, 1);
      const healthy = await getBot(box, cookie, healthyBotId);
      assert.equal(
        healthy.messages.filter((message) => (
          message.text === "Unrelated Bot survived the later callback failure."
        )).length,
        1,
      );
    } finally {
      releaseCommit();
      await fixture.cleanup();
    }
  });

  test("a reentrant onPermission supersession flush callback does not deadlock or retry", async () => {
    const fixture = await createPermissionFixture("openbot-permission-supersede-flush");
    let spawned = 0;
    const spawnAcp = (
      _spec: SpawnSpec,
      cwd: string,
      handlers: AcpHandlers = {},
    ) => {
      spawned += 1;
      return fixture.spawn(
        cwd,
        handlers,
        spawned === 1 ? "supersede" : "healthy",
        "Recovered after supersession commit ambiguity.",
      );
    };
    const store = new BotStore(fixture.homeDir, {
      listHarnesses: TEST_HARNESSES,
      spawnAcp,
    });
    const internals = store as unknown as {
      home: {
        updateMessageCard(messageId: string, card: TranscriptCard, updatedAt?: string): void;
      };
    };
    const updateMessageCard = internals.home.updateMessageCard.bind(internals.home);
    let failSupersededExpiry = true;
    internals.home.updateMessageCard = (messageId, card, updatedAt) => {
      if (
        failSupersededExpiry
        && card.kind === "permission"
        && card.status.label === "No longer available"
      ) {
        failSupersededExpiry = false;
        throw new Error("PRIVATE-SUPERSEDED-PERMISSION-COMMIT");
      }
      updateMessageCard(messageId, card, updatedAt);
    };

    const box = await fixture.start({ botStore: store });
    try {
      const cookie = await login(box);
      const botId = await createBot(box, cookie, "Ada");
      const sent = await fetch(`${box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Supersede one live permission with another." }),
      });
      assert.equal(sent.status, 200);
      await waitForFile(fixture.receiptFile);
      assert.deepEqual(
        (await readFile(fixture.receiptFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
        [{ rpcId: 700, optionId: "provider-reject-once" }],
      );

      const settled = await waitForBot(
        box,
        cookie,
        botId,
        (bot) => bot.write === false,
        "supersession failure did not settle the Turn",
      );
      assert.equal(
        settled.permission,
        null,
        `supersession left actionable memory: ${JSON.stringify(settled)}`,
      );
      assert.equal(
        settled.messages.filter((message) => message.card?.kind === "permission").length,
        1,
        `supersession changed Card cardinality: ${JSON.stringify(settled)}`,
      );
      assert.equal(
        settled.messages.some((message) => (
          message.card?.kind === "permission"
          && message.card.status.label === "No longer available"
          && message.card.actions.length === 0
        )),
        true,
        `supersession left the already-used Card actionable: ${JSON.stringify(settled)}`,
      );
      assert.equal(
        settled.messages.every((message) => message.card?.kind !== "bot-failure"),
        true,
        `supersession created an unsafe retry Card: ${JSON.stringify(settled)}`,
      );
      assert.doesNotMatch(
        JSON.stringify(settled),
        /PRIVATE-SUPERSEDED-PERMISSION-COMMIT|ACP_CALLBACK_FAILED|ACP transport callback failed/,
      );
      assert.equal((await readFile(fixture.receiptFile, "utf8")).trim().split("\n").length, 1);
      assert.ok(fixture.pids[0]);
      await waitForProcessGroupGone(fixture.pids[0]);

      const recovery = await fetch(`${box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Recover after supersession ambiguity." }),
      });
      assert.equal(recovery.status, 200);
      await waitForBot(
        box,
        cookie,
        botId,
        (bot) => bot.messages.some((message) => (
          message.text === "Recovered after supersession commit ambiguity."
        )),
        "supersession failure did not recover through a fresh client",
      );
      assert.equal(spawned, 2);
      assert.equal((await readFile(fixture.receiptFile, "utf8")).trim().split("\n").length, 1);
    } finally {
      await fixture.cleanup();
    }
  });

  test("a detached callback continuation stays behind a later active callback", async () => {
    const fixture = await createPermissionFixture("openbot-permission-stale-callback");
    const order: string[] = [];
    let resolveDetached!: () => void;
    const detached = new Promise<void>((resolve) => { resolveDetached = resolve; });
    let resolveActiveStarted!: () => void;
    const activeStarted = new Promise<void>((resolve) => { resolveActiveStarted = resolve; });
    let resolveActive!: () => void;
    const active = new Promise<void>((resolve) => { resolveActive = resolve; });
    let resolveAttempted!: () => void;
    const attempted = new Promise<void>((resolve) => { resolveAttempted = resolve; });
    let response: Promise<void> | null = null;
    let responseSettled = false;
    let acp!: AcpClient;
    try {
      acp = fixture.spawn(process.cwd(), {}, "stale-detached");
      await within(acp.initialize(), 2_000);
      await within(acp.newSession(process.cwd()), 2_000);
      const prompting = acp.prompt("Exercise detached callback ordering.", {
        onPermission(permission) {
          order.push("permission-returned");
          void detached.then(() => {
            order.push("detached-response");
            response = acp.respondPermission(
              permission.rpcId,
              "provider-allow-once",
              () => { order.push("permission-flushed"); },
            );
            void response.then(
              () => { responseSettled = true; },
              () => { responseSettled = true; },
            );
            resolveAttempted();
          });
        },
        onAssistant() {
          order.push("active-started");
          resolveActiveStarted();
          return active.then(() => { order.push("active-finished"); });
        },
      });
      void prompting.catch(() => undefined);

      await within(activeStarted, 2_000);
      resolveDetached();
      await within(attempted, 2_000);
      await waitForFile(fixture.receiptFile);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(responseSettled, false);
      assert.deepEqual(order, [
        "permission-returned",
        "active-started",
        "detached-response",
      ]);

      resolveActive();
      assert.ok(response);
      await within(response, 2_000);
      assert.deepEqual(order, [
        "permission-returned",
        "active-started",
        "detached-response",
        "active-finished",
        "permission-flushed",
      ]);
      assert.deepEqual(
        (await readFile(fixture.receiptFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
        [{ rpcId: 700, optionId: "provider-allow-once" }],
      );
      acp.cancel();
      await assert.rejects(within(prompting, 2_000), /cancelled/);
    } finally {
      resolveActive();
      await fixture.cleanup();
    }
  });

  test("a pre-flush transport failure sends no choice and retries on a fresh client", async () => {
    const fixture = await createPermissionFixture("openbot-permission-preflush");
    const { receiptFile, pids } = fixture;
    let spawned = 0;
    const spawnAcp = (
      _spec: SpawnSpec,
      cwd: string,
      handlers: AcpHandlers = {},
    ) => {
      spawned += 1;
      return fixture.spawn(cwd, handlers, spawned === 1 ? "preflush" : "healthy");
    };
    const box = await fixture.start({ spawnAcp });
    try {
      const cookie = await login(box);
      const botId = await createBot(box, cookie, "Ada");
      const sent = await fetch(`${box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Retry this permission after a pre-flush failure." }),
      });
      assert.equal(sent.status, 200);
      const pending = await waitForBot(
        box,
        cookie,
        botId,
        (bot) => Boolean(bot.permission?.cardId),
        "pre-flush permission Card did not appear",
      );
      const cardId = pending.permission?.cardId;
      assert.equal(typeof cardId, "string");
      await waitForFile(`${receiptFile}.closed`);

      const answered = await fetch(`${box.url}/api/bots/${botId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cardId, optionId: "provider-allow-once" }),
      });
      assert.equal(answered.status, 409);
      assert.doesNotMatch(
        await answered.text(),
        /PRIVATE-|ACP|payload|stack|credential|\/Users\//i,
      );
      await assert.rejects(access(receiptFile), (error: unknown) => (
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ));

      const failed = await waitForBot(
        box,
        cookie,
        botId,
        (bot) => bot.write === false && bot.messages.some((message) => message.card?.kind === "bot-failure"),
        "pre-flush failure did not become a recoverable Card",
      );
      const failureCards = failed.messages.filter((message) => message.card?.kind === "bot-failure");
      assert.equal(failureCards.length, 1);
      assert.equal(failed.messages.filter((message) => message.card?.kind === "permission").length, 0);
      assert.deepEqual(failureCards[0]?.card?.actions.map((action) => action.label), ["Try again"]);
      assert.ok(pids[0]);
      await waitForProcessGroupGone(pids[0]);

      const retried = await fetch(`${box.url}/api/bots/${botId}/cards/${failureCards[0]?.id}/retry`, {
        method: "POST",
        headers: { cookie },
      });
      assert.equal(retried.status, 200, await retried.text());
      const recovered = await waitForBot(
        box,
        cookie,
        botId,
        (bot) => (
          bot.write === false
          && bot.messages.some((message) => message.text === "Recovered on a fresh permission client.")
        ),
        "permission retry did not recover on a fresh client",
      );
      assert.equal(spawned, 2);
      assert.equal(
        recovered.messages.filter((message) => message.text === "Recovered on a fresh permission client.").length,
        1,
      );
      assert.equal(recovered.permission, null);
      await assert.rejects(access(receiptFile), (error: unknown) => (
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ));
    } finally {
      await fixture.cleanup();
    }
  });

  test("wrong, duplicate, stale, and post-flush generic actions cannot answer another request", async () => {
    const fixture = await createPermissionFixture("openbot-permission-correlation");
    const { receiptFile } = fixture;
    const spawnAcp = (
      _spec: SpawnSpec,
      cwd: string,
      handlers: AcpHandlers = {},
    ) => fixture.spawn(cwd, handlers, "normal");
    const box = await fixture.start({ spawnAcp });
    try {
      const cookie = await login(box);
      const botId = await createBot(box, cookie, "Ada");
      const otherBotId = await createBot(box, cookie, "Grace");
      const send = async (text: string) => {
        const response = await fetch(`${box.url}/api/bots/${botId}/messages`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        assert.equal(response.status, 200);
        return waitForBot(
          box,
          cookie,
          botId,
          (bot) => Boolean(bot.permission?.cardId),
          "generic permission Card did not appear",
        );
      };
      const answer = (targetBotId: string, cardId: string, optionId: string) => (
        fetch(`${box.url}/api/bots/${targetBotId}/permissions`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ cardId, optionId }),
        })
      );

      const first = await send("First correlated permission.");
      const firstCardId = first.permission?.cardId;
      assert.equal(typeof firstCardId, "string");
      assert.equal((await answer(botId, "wrong-card-id", "provider-allow-once")).status, 409);
      assert.equal((await answer(botId, firstCardId!, "wrong-provider-option")).status, 409);
      assert.equal((await answer(otherBotId, firstCardId!, "provider-allow-once")).status, 409);
      await assert.rejects(access(receiptFile), (error: unknown) => (
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ));

      const duplicateResponses = await Promise.all([
        answer(botId, firstCardId!, "provider-allow-once"),
        answer(botId, firstCardId!, "provider-allow-once"),
      ]);
      assert.deepEqual(
        duplicateResponses.map((response) => response.status).sort((a, b) => a - b),
        [200, 409],
      );
      const firstResolved = await waitForBot(
        box,
        cookie,
        botId,
        (bot) => (
          bot.write === false
          && bot.permission === null
          && bot.messages.some((message) => (
            message.id === firstCardId
            && message.card?.status.label === "Allowed once"
            && message.card.actions.length === 0
          ))
        ),
        "same-tick provider terminal outran the durable permission commit",
      );
      assert.equal(firstResolved.messages.filter((message) => message.id === firstCardId).length, 1);
      await waitForFile(receiptFile);
      let receipts = (await readFile(receiptFile, "utf8")).trim().split("\n");
      assert.equal(receipts.length, 1);
      assert.equal((await answer(botId, firstCardId!, "provider-allow-once")).status, 409);
      assert.equal((await readFile(receiptFile, "utf8")).trim().split("\n").length, 1);

      const second = await send("Second correlated permission.");
      const secondCardId = second.permission?.cardId;
      assert.equal(typeof secondCardId, "string");
      assert.notEqual(secondCardId, firstCardId);
      assert.equal((await answer(botId, firstCardId!, "provider-reject-once")).status, 409);
      assert.equal((await answer(botId, secondCardId!, "wrong-provider-option")).status, 409);
      const stillSecond = await getBot(box, cookie, botId);
      assert.equal(stillSecond.permission?.cardId, secondCardId);
      assert.equal((await answer(botId, secondCardId!, "provider-reject-once")).status, 200);
      await waitForBot(
        box,
        cookie,
        botId,
        (bot) => (
          bot.write === false
          && bot.permission === null
          && bot.messages.some((message) => (
            message.id === secondCardId
            && message.card?.status.label === "Denied"
            && message.card.actions.length === 0
          ))
        ),
        "second exact permission was not durably denied",
      );
      receipts = (await readFile(receiptFile, "utf8")).trim().split("\n");
      assert.deepEqual(receipts.map((line) => JSON.parse(line)), [
        { rpcId: 700, optionId: "provider-allow-once" },
        { rpcId: 700, optionId: "provider-reject-once" },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  test("a Host-grant choice flushes before its Card and compatibility row commit atomically", async () => {
    const fixture = await createPermissionFixture("openbot-host-flush");
    const { homeDir, receiptFile } = fixture;
    const spawnAcp = (
      _spec: SpawnSpec,
      cwd: string,
      handlers: AcpHandlers = {},
    ) => fixture.spawn(cwd, handlers, "normal");
    const store = new BotStore(homeDir, {
      listHarnesses: TEST_HARNESSES,
      spawnAcp,
    });
    const box = await fixture.start({ botStore: store });
    try {
      const cookie = await login(box);
      const botId = await createBot(box, cookie, "Ada");
      const sent = await fetch(`${box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Exercise dormant Host-grant compatibility." }),
      });
      assert.equal(sent.status, 200);
      const generic = await waitForBot(
        box,
        cookie,
        botId,
        (bot) => Boolean(bot.permission?.cardId),
        "path-bearing provider permission did not appear",
      );
      assert.equal(generic.permission?.hostGrant, undefined);
      const genericCardId = generic.permission?.cardId;
      assert.equal(generic.messages.find((message) => message.id === genericCardId)?.card?.kind, "permission");

      const { cardId } = activateDormantHostGrant(store, botId);
      const hostPending = await getBot(box, cookie, botId);
      assert.deepEqual(hostPending.permission?.hostGrant, {
        path: REQUESTED_HOST_PATH,
        requested: "read-write",
      });
      assert.equal(hostPending.messages.find((message) => message.id === cardId)?.card?.kind, "host-grant");

      const answered = await fetch(`${box.url}/api/bots/${botId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cardId, access: "read-write", duration: "until-revoked" }),
      });
      assert.equal(answered.status, 200, await answered.text());
      const resolved = await waitForBot(
        box,
        cookie,
        botId,
        (bot) => (
          bot.write === false
          && bot.permission === null
          && bot.messages.some((message) => (
            message.id === cardId
            && message.card?.status.label === "Read and write · until revoked"
            && message.card.actions.length === 0
          ))
        ),
        "same-tick terminal response outran the Host-grant transaction",
      );
      assert.equal(resolved.messages.filter((message) => message.id === cardId).length, 1);
      const grantsResponse = await fetch(`${box.url}/api/host-grants`, { headers: { cookie } });
      assert.equal(grantsResponse.status, 200);
      const grants = (await grantsResponse.json()) as {
        grants: Array<{ path: string; access: string; duration: string }>;
      };
      assert.deepEqual(grants.grants.map(({ path, access, duration }) => ({ path, access, duration })), [{
        path: REQUESTED_HOST_PATH,
        access: "read-write",
        duration: "until-revoked",
      }]);
      await waitForFile(receiptFile);
      assert.deepEqual(
        (await readFile(receiptFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
        [{ rpcId: 700, optionId: "provider-allow-once" }],
      );
      const duplicate = await fetch(`${box.url}/api/bots/${botId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cardId, access: "read-write", duration: "until-revoked" }),
      });
      assert.equal(duplicate.status, 409);
      assert.equal((await readFile(receiptFile, "utf8")).trim().split("\n").length, 1);

      await fixture.stop(box);
      const restarted = await fixture.start();
      try {
        const restartedCookie = await login(restarted);
        const afterRestart = await getBot(restarted, restartedCookie, botId);
        const persistedCard = afterRestart.messages.find((message) => message.id === cardId)?.card;
        assert.deepEqual(persistedCard?.status, {
          tone: "success",
          label: "Read and write · until revoked",
        });
        assert.deepEqual(persistedCard?.actions, []);
        const persistedGrantsResponse = await fetch(`${restarted.url}/api/host-grants`, {
          headers: { cookie: restartedCookie },
        });
        const persistedGrants = (await persistedGrantsResponse.json()) as {
          grants: Array<{ path: string; access: string; duration: string }>;
        };
        assert.deepEqual(
          persistedGrants.grants.map(({ path, access, duration }) => ({ path, access, duration })),
          [{ path: REQUESTED_HOST_PATH, access: "read-write", duration: "until-revoked" }],
        );
      } finally {
        await fixture.stop(restarted);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("a flushed Host-grant transaction failure leaves neither a row nor an actionable Card", async () => {
    const fixture = await createPermissionFixture("openbot-host-flush-failure");
    const { homeDir, receiptFile, pids } = fixture;
    const spawnAcp = (
      _spec: SpawnSpec,
      cwd: string,
      handlers: AcpHandlers = {},
    ) => fixture.spawn(cwd, handlers, "normal");
    const store = new BotStore(homeDir, {
      listHarnesses: TEST_HARNESSES,
      spawnAcp,
    });
    const box = await fixture.start({ botStore: store });
    try {
      const cookie = await login(box);
      const botId = await createBot(box, cookie, "Ada");
      const sent = await fetch(`${box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Fail the dormant Host transaction after provider flush." }),
      });
      assert.equal(sent.status, 200);
      await waitForBot(
        box,
        cookie,
        botId,
        (bot) => Boolean(bot.permission?.cardId),
        "Host failure permission Card did not appear",
      );
      const { cardId, home } = activateDormantHostGrant(store, botId);
      const database = (home as unknown as { db: { exec(sql: string): void } }).db;
      database.exec(`
        CREATE TEMP TRIGGER fail_resolved_host_grant_card
        BEFORE UPDATE OF card_json ON messages
        WHEN NEW.id = '${cardId}' AND NEW.card_json LIKE '%"tone":"success"%'
        BEGIN
          SELECT RAISE(ABORT, 'PRIVATE-HOST-GRANT-COMMIT');
        END;
      `);

      const answered = await fetch(`${box.url}/api/bots/${botId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cardId, access: "read-write", duration: "until-revoked" }),
      });
      assert.equal(answered.status, 409);
      const publicError = await answered.text();
      assert.match(publicError, /sent.*could not confirm/i);
      assert.doesNotMatch(
        publicError,
        /PRIVATE-|ACP|SQL|trigger|payload|stack|credential|\/Users\//i,
      );
      await waitForFile(receiptFile);
      assert.deepEqual(
        (await readFile(receiptFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
        [{ rpcId: 700, optionId: "provider-allow-once" }],
      );

      const unconfirmed = await waitForBot(
        box,
        cookie,
        botId,
        (bot) => (
          bot.write === false
          && bot.permission === null
          && bot.messages.some((message) => (
            message.id === cardId
            && message.card?.kind === "host-grant"
            && message.card.status.label === "No longer available"
            && message.card.actions.length === 0
          ))
        ),
        "failed Host transaction left an actionable Card",
      );
      assert.equal(unconfirmed.messages.filter((message) => message.id === cardId).length, 1);
      assert.equal(unconfirmed.messages.filter((message) => message.card?.kind === "bot-failure").length, 0);
      assert.doesNotMatch(
        JSON.stringify(unconfirmed),
        /PRIVATE-|ACP transport callback failed|ACP_CALLBACK_FAILED|node:|\/Users\//,
      );
      const grantsResponse = await fetch(`${box.url}/api/host-grants`, { headers: { cookie } });
      const grants = (await grantsResponse.json()) as { grants: unknown[] };
      assert.deepEqual(grants.grants, []);
      const duplicate = await fetch(`${box.url}/api/bots/${botId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cardId, access: "read-write", duration: "until-revoked" }),
      });
      assert.equal(duplicate.status, 409);
      assert.equal((await readFile(receiptFile, "utf8")).trim().split("\n").length, 1);
      assert.ok(pids[0]);
      await waitForProcessGroupGone(pids[0]);

      await fixture.stop(box);
      const restarted = await fixture.start();
      try {
        const restartedCookie = await login(restarted);
        const afterRestart = await getBot(restarted, restartedCookie, botId);
        const card = afterRestart.messages.find((message) => message.id === cardId)?.card;
        assert.deepEqual(card?.status, { tone: "neutral", label: "No longer available" });
        assert.deepEqual(card?.actions, []);
        const afterRestartGrants = await fetch(`${restarted.url}/api/host-grants`, {
          headers: { cookie: restartedCookie },
        });
        assert.deepEqual((await afterRestartGrants.json()) as { grants: unknown[] }, { grants: [] });
      } finally {
        await fixture.stop(restarted);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("restart reconciliation expires an unflushed pending permission without a provider choice", async () => {
    const fixture = await createPermissionFixture("openbot-permission-restart");
    const { receiptFile, pids } = fixture;
    const spawnAcp = (
      _spec: SpawnSpec,
      cwd: string,
      handlers: AcpHandlers = {},
    ) => fixture.spawn(cwd, handlers, "normal");
    const first = await fixture.start({ spawnAcp });
    try {
      const cookie = await login(first);
      const botId = await createBot(first, cookie, "Ada");
      const sent = await fetch(`${first.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Leave this permission pending across restart." }),
      });
      assert.equal(sent.status, 200);
      const pending = await waitForBot(
        first,
        cookie,
        botId,
        (bot) => Boolean(bot.permission?.cardId),
        "restart permission Card did not appear",
      );
      const cardId = pending.permission?.cardId;
      assert.equal(typeof cardId, "string");

      await fixture.stop(first);
      assert.ok(pids[0]);
      await waitForProcessGroupGone(pids[0]);
      await assert.rejects(access(receiptFile), (error: unknown) => (
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ));

      const restarted = await fixture.start();
      try {
        const restartedCookie = await login(restarted);
        const reconciled = await getBot(restarted, restartedCookie, botId);
        assert.equal(reconciled.permission, null);
        const card = reconciled.messages.find((message) => message.id === cardId)?.card;
        assert.deepEqual(card?.status, { tone: "neutral", label: "No longer available" });
        assert.deepEqual(card?.actions, []);
        const stale = await fetch(`${restarted.url}/api/bots/${botId}/permissions`, {
          method: "POST",
          headers: { cookie: restartedCookie, "content-type": "application/json" },
          body: JSON.stringify({ cardId, optionId: "provider-allow-once" }),
        });
        assert.equal(stale.status, 409);
        await assert.rejects(access(receiptFile), (error: unknown) => (
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ));
      } finally {
        await fixture.stop(restarted);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("concurrent replacement cancels one flushed action, contains its Bot, and admits a fresh client", async () => {
    const fixture = await createPermissionFixture("openbot-permission-replacement");
    const { receiptFile, pids } = fixture;
    const spawnCounts = new Map<string, number>();
    let failingCwd: string | null = null;
    let signalFlushStarted!: () => void;
    const flushStarted = new Promise<void>((resolve) => { signalFlushStarted = resolve; });
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => { releaseFlush = resolve; });
    const spawnAcp = (
      _spec: SpawnSpec,
      cwd: string,
      handlers: AcpHandlers = {},
    ) => {
      if (failingCwd === null) failingCwd = cwd;
      const attempt = (spawnCounts.get(cwd) ?? 0) + 1;
      spawnCounts.set(cwd, attempt);
      const isFirstFailingClient = cwd === failingCwd && attempt === 1;
      const client = fixture.spawn(
        cwd,
        handlers,
        isFirstFailingClient ? "normal" : "healthy",
        cwd === failingCwd
          ? "Recovered after replacing the flushed permission."
          : "Unrelated Bot stayed alive during permission replacement.",
      );
      if (isFirstFailingClient) {
        const respondPermission = client.respondPermission.bind(client);
        client.respondPermission = (rpcId, optionId, onFlushed) => respondPermission(
          rpcId,
          optionId,
          async () => {
            signalFlushStarted();
            await flushGate;
            await onFlushed?.();
          },
        );
      }
      return client;
    };
    const box = await fixture.start({ spawnAcp });
    try {
      const cookie = await login(box);
      const failingBotId = await createBot(box, cookie, "Ada");
      const healthyBotId = await createBot(box, cookie, "Grace");
      const firstSend = await fetch(`${box.url}/api/bots/${failingBotId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Hold this permission commit at the flush boundary." }),
      });
      assert.equal(firstSend.status, 200);
      const pending = await waitForBot(
        box,
        cookie,
        failingBotId,
        (bot) => Boolean(bot.permission?.cardId),
        "replacement permission Card did not appear",
      );
      const cardId = pending.permission?.cardId;
      assert.equal(typeof cardId, "string");

      const healthySend = await fetch(`${box.url}/api/bots/${healthyBotId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Stay alive while Ada is replaced." }),
      });
      assert.equal(healthySend.status, 200);
      await waitForBot(
        box,
        cookie,
        healthyBotId,
        (bot) => (
          bot.write === false
          && bot.messages.some((message) => (
            message.text === "Unrelated Bot stayed alive during permission replacement."
          ))
        ),
        "unrelated Bot did not remain available",
      );

      const answerPromise = fetch(`${box.url}/api/bots/${failingBotId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cardId, optionId: "provider-allow-once" }),
      });
      await within(flushStarted);
      await waitForFile(receiptFile);
      const replacement = await fetch(`${box.url}/api/bots/${failingBotId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Replace the old permission Turn." }),
      });
      assert.equal(replacement.status, 200, await replacement.text());
      releaseFlush();

      const answer = await within(answerPromise);
      assert.equal(answer.status, 409);
      assert.doesNotMatch(
        await answer.text(),
        /PRIVATE-|ACP|payload|stack|credential|\/Users\//i,
      );
      const recovered = await waitForBot(
        box,
        cookie,
        failingBotId,
        (bot) => (
          bot.write === false
          && bot.permission === null
          && bot.messages.some((message) => (
            message.text === "Recovered after replacing the flushed permission."
          ))
        ),
        "replacement did not recover through a fresh client",
      );
      assert.ok(failingCwd);
      assert.equal(spawnCounts.get(failingCwd), 2);
      const oldCard = recovered.messages.find((message) => message.id === cardId)?.card;
      assert.deepEqual(oldCard?.status, { tone: "neutral", label: "No longer available" });
      assert.deepEqual(oldCard?.actions, []);
      assert.equal(recovered.messages.filter((message) => message.card?.kind === "bot-failure").length, 0);
      assert.equal(
        recovered.messages.filter((message) => (
          message.text === "Recovered after replacing the flushed permission."
        )).length,
        1,
      );
      assert.deepEqual(
        (await readFile(receiptFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
        [{ rpcId: 700, optionId: "provider-allow-once" }],
      );
      assert.ok(pids[0]);
      await waitForProcessGroupGone(pids[0]);
      const healthy = await getBot(box, cookie, healthyBotId);
      assert.equal(
        healthy.messages.filter((message) => (
          message.text === "Unrelated Bot stayed alive during permission replacement."
        )).length,
        1,
      );
      assert.equal(healthy.messages.filter((message) => message.card?.kind === "bot-failure").length, 0);
    } finally {
      releaseFlush();
      await fixture.cleanup();
    }
  });
});
