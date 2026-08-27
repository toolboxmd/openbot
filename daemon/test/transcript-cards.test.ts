import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { AcpHandlers, PermissionPrompt } from "../src/acp.ts";
import type { AcpSession } from "../src/bots.ts";
import { startBox, type RunningBox } from "../src/box.ts";
import type { SpawnSpec } from "../src/harness.ts";
import { HUMAN_MEMBER_ID, HomeStore } from "../src/home.ts";
import {
  hostGrantTranscriptCard,
  permissionTranscriptCard,
  resolvedPermissionCard,
} from "../src/transcript-card.ts";

type CardMessage = {
  id: string;
  role?: "user" | "assistant";
  text?: string;
  replyTo?: string;
  kind?: string;
  card?: {
    kind: string;
    title: string;
    body: string;
    preview?: string;
    status: { tone: string; label: string };
    actions: Array<{
      id: string;
      label: string;
      intent: string;
      command: Record<string, string>;
    }>;
  };
};

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "openbot-cards-home-"));
}

function cookieHeader(res: Response): string {
  return res.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
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

async function waitForCard(box: RunningBox, cookie: string, botId: string): Promise<CardMessage> {
  const started = Date.now();
  while (Date.now() - started < 2_000) {
    const response = await fetch(`${box.url}/api/bots/${botId}`, { headers: { cookie } });
    const bot = (await response.json()) as { messages?: CardMessage[] };
    const card = bot.messages?.find((message) => message.kind === "card");
    if (card?.card) return card;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for Transcript Card");
}

function permissionFake() {
  let handlers: AcpHandlers | undefined;
  let settlePrompt: ((value: string) => void) | undefined;
  const answered: string[] = [];
  let settleAnswers = true;
  let responseError: Error | null = null;
  let closed = 0;
  const spawnAcp = (_spec: SpawnSpec, _cwd: string, next?: AcpHandlers): AcpSession => {
    handlers = next;
    return {
      close() {
        closed += 1;
      },
      async initialize() {
        return {};
      },
      async newSession() {
        return "card-session";
      },
      prompt() {
        return new Promise<string>((resolve) => {
          settlePrompt = resolve;
        });
      },
      cancel() {},
      respondPermission(_rpcId, optionId) {
        answered.push(optionId);
        if (responseError) throw responseError;
        if (settleAnswers) settlePrompt?.("done");
      },
    };
  };
  return {
    spawnAcp,
    answered,
    get closed() {
      return closed;
    },
    failResponses(error = new Error("permission transport closed")) {
      responseError = error;
    },
    holdResponses() {
      settleAnswers = false;
    },
    fire(prompt: PermissionPrompt) {
      handlers?.onPermission?.(prompt);
    },
  };
}

function clientFailureFake(phase: "initialize" | "new-session", secret: string) {
  const spawnAcp = (_spec: SpawnSpec, _cwd: string, _handlers?: AcpHandlers): AcpSession => ({
    close() {},
    async initialize() {
      if (phase === "initialize") {
        throw Object.assign(new Error(`not signed in stack ${secret}`), { code: -32000 });
      }
      return {};
    },
    async newSession() {
      if (phase === "new-session") throw new Error(`session/new stack credential ${secret}`);
      return "unused-session";
    },
    async prompt() {
      return "unused";
    },
    cancel() {},
    respondPermission() {},
  });
  return { spawnAcp };
}

function failureFake(secret: string) {
  const spawnAcp = (_spec: SpawnSpec, _cwd: string, _handlers?: AcpHandlers): AcpSession => ({
    close() {},
    async initialize() {
      return {};
    },
    async newSession() {
      return "failure-session";
    },
    async prompt() {
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error(`ACP child exited with stack and credential ${secret}`);
    },
    cancel() {},
    respondPermission() {},
  });
  return { spawnAcp };
}

async function startCardBox(homeDir: string, pwaDir: string, fake = permissionFake()) {
  const box = await startBox({
    password: "correct-horse",
    pwaDir,
    host: "127.0.0.1",
    port: 0,
    homeDir,
    listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
    spawnAcp: fake.spawnAcp,
  });
  return { box, fake };
}

describe("Talk HTTP Transcript Cards", () => {
  test("migrates legacy Host-grant history into the typed Card seam", async () => {
    const homeDir = await tempHome();
    const botId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const current = new HomeStore(homeDir);
    current.createBot({
      id: botId,
      name: "Ada",
      color: "#ff3b5c",
      shape: "capsule",
      harness: null,
      createdAt: "2026-08-27T10:00:00.000Z",
    }, channelId);
    current.appendMessage(channelId, {
      id: messageId,
      role: "user",
      kind: "host-grant",
      text: "Read and write · this Session\n/tmp/legacy-report.txt",
      createdAt: "2026-08-27T10:01:00.000Z",
      senderId: HUMAN_MEMBER_ID,
    });
    current.close();

    const seed = new (await import("node:sqlite")).DatabaseSync(join(homeDir, "talk.sqlite"));
    seed.exec("ALTER TABLE messages DROP COLUMN card_json; PRAGMA user_version = 4;");
    seed.close();

    const migrated = new HomeStore(homeDir);
    try {
      const message = migrated.listMessages(channelId).find((candidate) => candidate.id === messageId);
      assert.equal(message?.kind, "card");
      assert.deepEqual(message?.card, {
        kind: "host-grant",
        title: "Host access",
        body: "A Host access choice was recorded.",
        preview: "/tmp/legacy-report.txt",
        status: { tone: "success", label: "Read and write · this Session" },
        actions: [],
      });
    } finally {
      migrated.close();
    }
  });

  test("maps a permission to safe Card copy and keeps its resolution across Talk restart", async () => {
    const homeDir = await tempHome();
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-cards-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const first = await startCardBox(homeDir, pwaDir);
    let botId = "";
    let resolvedCardId = "";
    try {
      const cookie = await login(first.box);
      const created = await fetch(`${first.box.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      });
      botId = ((await created.json()) as { id: string }).id;
      await fetch(`${first.box.url}/api/bots/${botId}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ harness: "codex" }),
      });
      await fetch(`${first.box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Please continue." }),
      });

      first.fake.fire({
        rpcId: 71,
        title: "Run raw command TOKEN-71",
        description: "{\"secret\":\"TOKEN-71\",\"stack\":\"private\"}",
        rawInput: { command: "curl -H 'Authorization: TOKEN-71'" },
        toolKind: "execute",
        options: [
          { optionId: "allow-once", name: "TOKEN-71", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });

      const pending = await waitForCard(first.box, cookie, botId);
      resolvedCardId = pending.id;
      assert.deepEqual(pending.card, {
        kind: "permission",
        title: "Permission requested",
        body: "This Bot wants to run a command that needs your approval.",
        status: { tone: "waiting", label: "Waiting for you" },
        actions: [
          {
            id: "allow-once",
            label: "Allow once",
            intent: "primary",
            command: { kind: "permission", optionId: "allow-once" },
          },
          {
            id: "reject-once",
            label: "Deny",
            intent: "secondary",
            command: { kind: "permission", optionId: "reject-once" },
          },
        ],
      });
      assert.doesNotMatch(JSON.stringify(pending), /TOKEN-71|raw command|Authorization|stack|private/);

      const publicBotResponse = await fetch(`${first.box.url}/api/bots/${botId}`, { headers: { cookie } });
      const publicBotJson = await publicBotResponse.text();
      assert.doesNotMatch(publicBotJson, /TOKEN-71|raw command|Authorization|stack|private/);
      const inboxResponse = await fetch(`${first.box.url}/api/inbox`, { headers: { cookie } });
      const inboxJson = await inboxResponse.text();
      assert.doesNotMatch(inboxJson, /TOKEN-71|raw command|Authorization|stack|private/);

      const missingIdentity = await fetch(`${first.box.url}/api/bots/${botId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ optionId: "allow-once" }),
      });
      assert.equal(missingIdentity.status, 400);
      assert.deepEqual(first.fake.answered, []);

      const answered = await fetch(`${first.box.url}/api/bots/${botId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cardId: pending.id, optionId: "allow-once" }),
      });
      assert.equal(answered.status, 200);
      const resolved = (await answered.json()) as { messages: CardMessage[] };
      const resolvedCard = resolved.messages.find((message) => message.id === pending.id);
      assert.deepEqual(resolvedCard?.card?.status, { tone: "success", label: "Allowed once" });
      assert.deepEqual(resolvedCard?.card?.actions, []);
      assert.deepEqual(first.fake.answered, ["allow-once"]);
    } finally {
      await first.box.close();
    }

    const restarted = await startCardBox(homeDir, pwaDir);
    try {
      const cookie = await login(restarted.box);
      const response = await fetch(`${restarted.box.url}/api/bots/${botId}`, { headers: { cookie } });
      const bot = (await response.json()) as { messages: CardMessage[] };
      const persisted = bot.messages.find((message) => message.id === resolvedCardId);
      assert.deepEqual(persisted?.card?.status, { tone: "success", label: "Allowed once" });
      assert.deepEqual(persisted?.card?.actions, []);
    } finally {
      await restarted.box.close();
    }
  });

  test("maps a Host grant to a path Card and persists its durable choice", async () => {
    const homeDir = await tempHome();
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-host-card-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const first = await startCardBox(homeDir, pwaDir);
    let botId = "";
    let cardId = "";
    const requestedPath = "/tmp/openbot-card-host.txt";
    try {
      const cookie = await login(first.box);
      const created = await fetch(`${first.box.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      });
      botId = ((await created.json()) as { id: string }).id;
      await fetch(`${first.box.url}/api/bots/${botId}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ harness: "codex" }),
      });
      await fetch(`${first.box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Write the file." }),
      });

      first.fake.fire({
        rpcId: 72,
        title: "Write TOKEN-72 with raw shell",
        description: "private stack TOKEN-72",
        rawInput: { command: `printf TOKEN-72 > ${requestedPath}` },
        locations: [{ path: requestedPath }],
        toolKind: "edit",
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });

      const pending = await waitForCard(first.box, cookie, botId);
      cardId = pending.id;
      assert.deepEqual(pending.card, {
        kind: "host-grant",
        title: "Host access requested",
        body: "This Bot wants to read and change a path on this Computer outside Workspace.",
        preview: requestedPath,
        status: { tone: "waiting", label: "Waiting for you" },
        actions: [
          {
            id: "read-write",
            label: "Read and write",
            intent: "primary",
            command: { kind: "host-grant", access: "read-write" },
          },
          {
            id: "deny",
            label: "Deny",
            intent: "secondary",
            command: { kind: "host-grant", access: "deny" },
          },
        ],
      });
      assert.doesNotMatch(JSON.stringify(pending), /TOKEN-72|raw shell|private stack|printf/);

      const answered = await fetch(`${first.box.url}/api/bots/${botId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          cardId: pending.id,
          access: "read-write",
          duration: "until-revoked",
        }),
      });
      assert.equal(answered.status, 200);
      const resolved = (await answered.json()) as { messages: CardMessage[] };
      const resolvedCard = resolved.messages.find((message) => message.id === pending.id);
      assert.deepEqual(resolvedCard?.card?.status, {
        tone: "success",
        label: "Read and write · until revoked",
      });
      assert.deepEqual(resolvedCard?.card?.actions, []);
      assert.deepEqual(first.fake.answered, ["allow-once"]);
    } finally {
      await first.box.close();
    }

    const restarted = await startCardBox(homeDir, pwaDir);
    try {
      const cookie = await login(restarted.box);
      const botResponse = await fetch(`${restarted.box.url}/api/bots/${botId}`, { headers: { cookie } });
      const bot = (await botResponse.json()) as { messages: CardMessage[] };
      const persisted = bot.messages.find((message) => message.id === cardId);
      assert.deepEqual(persisted?.card?.status, {
        tone: "success",
        label: "Read and write · until revoked",
      });
      assert.deepEqual(persisted?.card?.actions, []);

      const grantsResponse = await fetch(`${restarted.box.url}/api/host-grants`, { headers: { cookie } });
      const grants = (await grantsResponse.json()) as {
        grants: Array<{ path: string; access: string; duration: string }>;
      };
      assert.equal(
        grants.grants.some((grant) =>
          grant.path === requestedPath
          && grant.access === "read-write"
          && grant.duration === "until-revoked"),
        true,
      );
    } finally {
      await restarted.box.close();
    }
  });

  test("expires a pending Card when Talk restarts without the live ACP request", async () => {
    const homeDir = await tempHome();
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-expired-card-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const first = await startCardBox(homeDir, pwaDir);
    let botId = "";
    let cardId = "";
    try {
      const cookie = await login(first.box);
      const created = await fetch(`${first.box.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      });
      botId = ((await created.json()) as { id: string }).id;
      await fetch(`${first.box.url}/api/bots/${botId}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ harness: "codex" }),
      });
      await fetch(`${first.box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Please continue." }),
      });
      first.fake.fire({
        rpcId: 73,
        title: "Permission",
        toolKind: "read",
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
      cardId = (await waitForCard(first.box, cookie, botId)).id;
    } finally {
      await first.box.close();
    }

    const restarted = await startCardBox(homeDir, pwaDir);
    try {
      const cookie = await login(restarted.box);
      const response = await fetch(`${restarted.box.url}/api/bots/${botId}`, { headers: { cookie } });
      const bot = (await response.json()) as {
        permission: unknown;
        messages: CardMessage[];
      };
      const expired = bot.messages.find((message) => message.id === cardId);
      assert.equal(bot.permission, null);
      assert.deepEqual(expired?.card?.status, { tone: "neutral", label: "No longer available" });
      assert.deepEqual(expired?.card?.actions, []);
    } finally {
      await restarted.box.close();
    }
  });

  test("expires a pending Card when a new message interrupts its live ACP request", async () => {
    const homeDir = await tempHome();
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-interrupted-card-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const running = await startCardBox(homeDir, pwaDir);
    try {
      const cookie = await login(running.box);
      const created = await fetch(`${running.box.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      });
      const botId = ((await created.json()) as { id: string }).id;
      await fetch(`${running.box.url}/api/bots/${botId}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ harness: "codex" }),
      });
      await fetch(`${running.box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Start the first task." }),
      });
      running.fake.fire({
        rpcId: 74,
        title: "Permission",
        toolKind: "execute",
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
      const pending = await waitForCard(running.box, cookie, botId);

      const interrupted = await fetch(`${running.box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Do this instead." }),
      });
      assert.equal(interrupted.status, 200);
      const bot = (await interrupted.json()) as { permission: unknown; messages: CardMessage[] };
      const expired = bot.messages.find((message) => message.id === pending.id);
      assert.equal(bot.permission, null);
      assert.deepEqual(expired?.card?.status, { tone: "neutral", label: "No longer available" });
      assert.deepEqual(expired?.card?.actions, []);
    } finally {
      await running.box.close();
    }
  });

  test("supersedes a concurrent permission and rejects a delayed Card action", async () => {
    const homeDir = await tempHome();
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-concurrent-card-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const running = await startCardBox(homeDir, pwaDir);
    running.fake.holdResponses();
    try {
      const cookie = await login(running.box);
      const created = await fetch(`${running.box.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      });
      const botId = ((await created.json()) as { id: string }).id;
      await fetch(`${running.box.url}/api/bots/${botId}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ harness: "codex" }),
      });
      await fetch(`${running.box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Run both checks." }),
      });
      const options = [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ];
      running.fake.fire({ rpcId: 75, title: "First raw request", toolKind: "execute", options });
      const first = await waitForCard(running.box, cookie, botId);
      running.fake.fire({ rpcId: 76, title: "Second raw request", toolKind: "read", options });

      const currentResponse = await fetch(`${running.box.url}/api/bots/${botId}`, { headers: { cookie } });
      const current = (await currentResponse.json()) as {
        permission: { cardId?: string } | null;
        messages: CardMessage[];
      };
      const cards = current.messages.filter((message) => message.kind === "card");
      const second = cards.find((message) => message.id !== first.id);
      assert.ok(second?.card);
      assert.equal(current.permission?.cardId, second.id);
      assert.deepEqual(cards.find((message) => message.id === first.id)?.card?.status, {
        tone: "neutral",
        label: "No longer available",
      });
      assert.deepEqual(running.fake.answered, ["reject-once"]);

      const delayed = await fetch(`${running.box.url}/api/bots/${botId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cardId: first.id, optionId: "allow-once" }),
      });
      assert.equal(delayed.status, 409);
      assert.deepEqual(running.fake.answered, ["reject-once"]);

      const active = await fetch(`${running.box.url}/api/bots/${botId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cardId: second.id, optionId: "allow-once" }),
      });
      assert.equal(active.status, 200);
      assert.deepEqual(running.fake.answered, ["reject-once", "allow-once"]);
    } finally {
      await running.box.close();
    }
  });

  test("stores a permission choice before acknowledging it and closes a failed ACP transport", async () => {
    const homeDir = await tempHome();
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-card-ack-failure-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const running = await startCardBox(homeDir, pwaDir);
    running.fake.holdResponses();
    try {
      const cookie = await login(running.box);
      const created = await fetch(`${running.box.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      });
      const botId = ((await created.json()) as { id: string }).id;
      await fetch(`${running.box.url}/api/bots/${botId}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ harness: "codex" }),
      });
      await fetch(`${running.box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Run the check." }),
      });
      running.fake.fire({
        rpcId: 78,
        title: "Raw request",
        toolKind: "execute",
        options: [
          { optionId: "allow-once", name: "Raw allow", kind: "allow_once" },
          { optionId: "reject-once", name: "Raw reject", kind: "reject_once" },
        ],
      });
      const pending = await waitForCard(running.box, cookie, botId);
      running.fake.failResponses();

      const answer = await fetch(`${running.box.url}/api/bots/${botId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cardId: pending.id, optionId: "allow-once" }),
      });
      assert.equal(answer.status, 409);
      assert.deepEqual(running.fake.answered, ["allow-once"]);
      assert.equal(running.fake.closed, 1);

      const botResponse = await fetch(`${running.box.url}/api/bots/${botId}`, { headers: { cookie } });
      const bot = (await botResponse.json()) as {
        permission: unknown;
        messages: CardMessage[];
      };
      assert.equal(bot.permission, null);
      assert.deepEqual(bot.messages.find((message) => message.id === pending.id)?.card?.status, {
        tone: "success",
        label: "Allowed once",
      });
      assert.deepEqual(bot.messages.find((message) => message.id === pending.id)?.card?.actions, []);
    } finally {
      await running.box.close();
    }
  });

  test("maps an actionable Harness failure without exposing technical detail", async () => {
    const homeDir = await tempHome();
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-failure-card-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const secret = "TOKEN-74";
    const box = await startBox({
      password: "correct-horse",
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: failureFake(secret).spawnAcp,
    });
    try {
      const cookie = await login(box);
      const created = await fetch(`${box.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      });
      const botId = ((await created.json()) as { id: string }).id;
      await fetch(`${box.url}/api/bots/${botId}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ harness: "codex" }),
      });
      await fetch(`${box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Please finish this task." }),
      });

      const failure = await waitForCard(box, cookie, botId);
      const botResponse = await fetch(`${box.url}/api/bots/${botId}`, { headers: { cookie } });
      const bot = (await botResponse.json()) as {
        messages: CardMessage[];
        write: boolean;
        activity: { latestText: string | null; unread: boolean };
      };
      const source = bot.messages.find((message) => message.kind !== "card");
      assert.equal(bot.write, false);
      assert.equal(bot.activity.latestText, "Bot stopped: Failed");
      assert.equal(bot.activity.unread, true);
      assert.deepEqual(failure.card, {
        kind: "bot-failure",
        title: "Bot stopped",
        body: "The Bot could not finish this message. Try again.",
        status: { tone: "danger", label: "Failed" },
        actions: [
          {
            id: "retry",
            label: "Try again",
            intent: "primary",
            command: { kind: "retry-message", messageId: source?.id },
          },
        ],
      });
      assert.doesNotMatch(JSON.stringify(bot), new RegExp(`${secret}|ACP child|stack|credential`, "i"));
    } finally {
      await box.close();
    }
  });

  test("persists safe actionable Cards for initialization and session startup failures", async () => {
    for (const phase of ["initialize", "new-session"] as const) {
      const homeDir = await tempHome();
      const pwaDir = await mkdtemp(join(tmpdir(), `openbot-${phase}-failure-pwa-`));
      await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
      const secret = `TOKEN-START-${phase}`;
      const box = await startBox({
        password: "correct-horse",
        pwaDir,
        host: "127.0.0.1",
        port: 0,
        homeDir,
        listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
        spawnAcp: clientFailureFake(phase, secret).spawnAcp,
      });
      try {
        const cookie = await login(box);
        const created = await fetch(`${box.url}/api/bots`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ name: phase }),
        });
        const botId = ((await created.json()) as { id: string }).id;
        await fetch(`${box.url}/api/bots/${botId}`, {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ harness: "codex" }),
        });
        const sent = await fetch(`${box.url}/api/bots/${botId}/messages`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ text: `Retry ${phase}.` }),
        });
        assert.equal(sent.status, 200);
        const raw = await sent.text();
        assert.doesNotMatch(raw, new RegExp(`${secret}|stack|credential`, "i"));
        const bot = JSON.parse(raw) as { messages: CardMessage[] };
        const source = bot.messages.find((message) => message.role === "user");
        const failure = bot.messages.find((message) => message.kind === "card");
        assert.equal(failure?.card?.title, phase === "initialize" ? "Codex needs sign-in" : "Bot stopped");
        assert.deepEqual(failure?.card?.actions, [{
          id: "retry",
          label: "Try again",
          intent: "primary",
          command: { kind: "retry-message", messageId: source?.id },
        }]);

        const inbox = await fetch(`${box.url}/api/inbox`, { headers: { cookie } });
        assert.doesNotMatch(await inbox.text(), new RegExp(`${secret}|stack|credential`, "i"));
      } finally {
        await box.close();
      }
    }
  });
});

describe("Transcript Card permission choices", () => {
  test("uses canonical safe choices when ACP omits option kinds", () => {
    const card = permissionTranscriptCard("execute", [
      { optionId: "allow-once", name: "raw allow label" },
      { optionId: "always", name: "raw always label" },
      { optionId: "deny", name: "raw deny label" },
      { optionId: "reject-always", name: "raw reject label" },
      { optionId: "provider-specific", name: "raw provider label" },
    ]);

    assert.deepEqual(card.actions.map((action) => action.label), [
      "Allow once",
      "Always allow",
      "Deny",
      "Always deny",
    ]);
    assert.doesNotMatch(JSON.stringify(card), /raw |provider-specific/);
    assert.deepEqual(resolvedPermissionCard(card, "always").status, {
      tone: "success",
      label: "Always allowed",
    });
    assert.deepEqual(resolvedPermissionCard(card, "reject-always").status, {
      tone: "neutral",
      label: "Always denied",
    });
  });

  test("never labels a write approval as read-only and respects ACP allow or reject support", () => {
    const options = [
      { optionId: "allow-once", name: "raw allow", kind: "allow_once" },
      { optionId: "reject-once", name: "raw reject", kind: "reject_once" },
    ];
    assert.deepEqual(
      hostGrantTranscriptCard("/tmp/read.txt", "read", options).actions.map((action) => action.label),
      ["Read", "Read and write", "Deny"],
    );
    assert.deepEqual(
      hostGrantTranscriptCard("/tmp/write.txt", "read-write", options).actions.map((action) => action.label),
      ["Read and write", "Deny"],
    );
    assert.deepEqual(
      hostGrantTranscriptCard("/tmp/write.txt", "read-write", [options[1]]).actions.map((action) => action.label),
      ["Deny"],
    );
  });
});
