import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { AcpHandlers, PermissionPrompt } from "../src/acp.ts";
import { BotStore, type AcpSession } from "../src/bots.ts";
import { startBox, type RunningBox } from "../src/box.ts";
import type { SpawnSpec } from "../src/harness.ts";
import { HUMAN_MEMBER_ID, HomeStore } from "../src/home.ts";
import {
  hostGrantTranscriptCard,
  permissionTranscriptCard,
  resolvedHostGrantCard,
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
    needsYou?: { id: string; reason: string };
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
  let transportGate: Promise<void> | null = null;
  let releaseTransport: (() => void) | null = null;
  let initializeGate: Promise<void> | null = null;
  let releaseInitialize: (() => void) | null = null;
  let initializeError: Error | null = null;
  let spawned = 0;
  let closed = 0;
  let cancelled = 0;
  const spawnAcp = (_spec: SpawnSpec, _cwd: string, next?: AcpHandlers): AcpSession => {
    spawned += 1;
    handlers = next;
    return {
      close() {
        closed += 1;
      },
      async initialize() {
        if (initializeError) {
          const error = initializeError;
          initializeError = null;
          throw error;
        }
        if (initializeGate) await initializeGate;
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
      cancel() {
        cancelled += 1;
      },
      async respondPermission(_rpcId, optionId) {
        answered.push(optionId);
        if (responseError) throw responseError;
        if (transportGate) await transportGate;
        if (responseError) throw responseError;
        if (settleAnswers) setImmediate(() => settlePrompt?.("done"));
      },
    };
  };
  return {
    spawnAcp,
    answered,
    get closed() {
      return closed;
    },
    get cancelled() {
      return cancelled;
    },
    get spawned() {
      return spawned;
    },
    failNextInitialize(error = new Error("initialize failed")) {
      initializeError = error;
    },
    holdInitialize() {
      initializeGate = new Promise((resolve) => {
        releaseInitialize = resolve;
      });
    },
    releaseInitialize() {
      releaseInitialize?.();
      initializeGate = null;
      releaseInitialize = null;
    },
    failResponses(error = new Error("permission transport closed")) {
      responseError = error;
    },
    holdResponses() {
      settleAnswers = false;
    },
    holdTransport() {
      transportGate = new Promise((resolve) => {
        releaseTransport = resolve;
      });
    },
    releaseTransport() {
      releaseTransport?.();
      transportGate = null;
      releaseTransport = null;
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

function configSwitchDuringStartupFake() {
  let initializeGate = new Promise<void>(() => undefined);
  let releaseInitialize: (() => void) | null = null;
  initializeGate = new Promise((resolve) => {
    releaseInitialize = resolve;
  });
  let spawned = 0;
  const createdSessions: string[] = [];
  const loadedSessions: string[] = [];
  const spawnAcp = (_spec: SpawnSpec, _cwd: string, _handlers?: AcpHandlers): AcpSession => {
    spawned += 1;
    const ordinal = spawned;
    return {
      close() {},
      async initialize() {
        if (ordinal === 1) await initializeGate;
        return {};
      },
      async newSession() {
        const sessionId = ordinal === 1 ? "isolated-stale" : "host-fresh";
        createdSessions.push(sessionId);
        return sessionId;
      },
      async loadSession(sessionId) {
        loadedSessions.push(sessionId);
        return sessionId;
      },
      prompt() {
        return new Promise<string>(() => undefined);
      },
      cancel() {},
      respondPermission() {},
    };
  };
  return {
    spawnAcp,
    createdSessions,
    loadedSessions,
    get spawned() {
      return spawned;
    },
    releaseInitialize() {
      releaseInitialize?.();
      releaseInitialize = null;
    },
  };
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
          { optionId: "allow-always", name: "TOKEN-71", kind: "provider-private-TOKEN-71" },
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
      const publicBot = JSON.parse(publicBotJson) as {
        permission: { options: Array<{ optionId: string; name: string; kind?: string }> } | null;
      };
      assert.deepEqual(publicBot.permission?.options, [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Deny", kind: "reject_once" },
      ]);
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

      const invalidChoice = await fetch(`${first.box.url}/api/bots/${botId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cardId: pending.id, optionId: "invented-choice" }),
      });
      assert.equal(invalidChoice.status, 409);
      assert.deepEqual(first.fake.answered, []);
      const stillPendingResponse = await fetch(`${first.box.url}/api/bots/${botId}`, { headers: { cookie } });
      const stillPending = (await stillPendingResponse.json()) as {
        permission: { cardId?: string; options: Array<{ optionId: string }> } | null;
        messages: CardMessage[];
      };
      assert.equal(stillPending.permission?.cardId, pending.id);
      assert.deepEqual(stillPending.permission?.options.map((option) => option.optionId), [
        "allow-once",
        "reject-once",
      ]);
      assert.deepEqual(stillPending.messages.find((message) => message.id === pending.id)?.card?.status, {
        tone: "waiting",
        label: "Waiting for you",
      });

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

  test("fails closed instead of persisting an unresolvable permission Card", async () => {
    const homeDir = await tempHome();
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-unsupported-permission-pwa-"));
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
        body: JSON.stringify({ text: "Continue safely." }),
      });

      running.fake.fire({
        rpcId: 79,
        title: "Raw provider prompt SECRET-79",
        description: "stack SECRET-79",
        toolKind: "provider-specific",
        options: [
          { optionId: "provider-allow-project", name: "Allow for project", kind: "allow_always" },
          { optionId: "provider-reject-project", name: "Reject for project", kind: "reject_always" },
        ],
      });

      const card = await waitForCard(running.box, cookie, botId);
      const botResponse = await fetch(`${running.box.url}/api/bots/${botId}`, { headers: { cookie } });
      const bot = (await botResponse.json()) as { permission: unknown; messages: CardMessage[] };
      assert.equal(bot.permission, null);
      assert.equal(running.fake.cancelled, 1);
      assert.deepEqual(running.fake.answered, []);
      assert.deepEqual(card.card, {
        kind: "permission",
        title: "Permission not available",
        body: "This Bot requested a choice OpenBot cannot safely show. The request was not approved.",
        status: { tone: "neutral", label: "Not approved" },
        actions: [],
      });
      assert.doesNotMatch(JSON.stringify(bot), /SECRET-79|Raw provider|stack|provider-(allow|reject)-project/);
    } finally {
      await running.box.close();
    }
  });

  test("keeps path and command heuristics out of the normal v1 permission flow", async () => {
    const homeDir = await tempHome();
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-generic-permission-pwa-"));
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
        body: JSON.stringify({ text: "Continue." }),
      });
      running.fake.fire({
        rpcId: 80,
        title: "Write SECRET-80",
        description: "private path prompt SECRET-80",
        rawInput: { command: "printf SECRET-80 > /tmp/openbot-secret.txt" },
        locations: [{ path: "/tmp/openbot-secret.txt" }],
        toolKind: "edit",
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });

      const pending = await waitForCard(running.box, cookie, botId);
      assert.equal(pending.card?.kind, "permission");
      assert.equal(pending.card?.preview, undefined);
      assert.doesNotMatch(JSON.stringify(pending), /SECRET-80|openbot-secret|printf|private path/);
      const grantsResponse = await fetch(`${running.box.url}/api/host-grants`, { headers: { cookie } });
      assert.deepEqual((await grantsResponse.json()) as { grants: unknown[] }, { grants: [] });

      const answered = await fetch(`${running.box.url}/api/bots/${botId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cardId: pending.id, optionId: "reject-once" }),
      });
      assert.equal(answered.status, 200);
      assert.deepEqual(running.fake.answered, ["reject-once"]);
    } finally {
      await running.box.close();
    }
  });

  test("preserves dormant Host-grant Card, row, persistence, and evaluator compatibility", async () => {
    const homeDir = await tempHome();
    const botId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const cardId = crypto.randomUUID();
    const requestedPath = "/tmp/openbot-card-host.txt";
    const options = [
      { optionId: "provider-allow-project", name: "Allow for this project", kind: "allow_always" },
      { optionId: "provider-reject-project", name: "Reject for this project", kind: "reject_always" },
    ];
    const pending = hostGrantTranscriptCard(requestedPath, "read-write", options);
    const resolved = resolvedHostGrantCard(pending, "read-write", "until-revoked");
    const first = new HomeStore(homeDir);
    try {
      first.createBot({
        id: botId,
        name: "Ada",
        color: "#ff3b5c",
        shape: "capsule",
        harness: "codex",
        createdAt: "2026-08-27T10:00:00.000Z",
      }, channelId);
      first.appendMessage(channelId, {
        id: cardId,
        role: "assistant",
        senderId: botId,
        kind: "card",
        card: pending,
        text: "Host access requested: Waiting for you",
        createdAt: "2026-08-27T10:01:00.000Z",
      });
      first.resolveHostGrantCard(cardId, resolved, {
        path: requestedPath,
        access: "read-write",
        duration: "until-revoked",
      });
      assert.equal(first.matchHostGrant(requestedPath, "read-write")?.duration, "until-revoked");
    } finally {
      first.close();
    }

    const restarted = new HomeStore(homeDir);
    try {
      const persisted = restarted.getMessage(channelId, cardId);
      assert.deepEqual(persisted?.card?.status, {
        tone: "success",
        label: "Read and write · until revoked",
      });
      assert.deepEqual(persisted?.card?.actions, []);
      assert.equal(restarted.matchHostGrant(requestedPath, "read-write")?.duration, "until-revoked");
    } finally {
      restarted.close();
    }
  });

  test("preserves the dormant Host-grant HTTP answer flow without enabling normal classification", async () => {
    const homeDir = await tempHome();
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-host-compat-http-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const answered: string[] = [];
    const client: AcpSession = {
      close() {},
      async initialize() { return {}; },
      async newSession() { return "dormant-host-session"; },
      async prompt() { return "unused"; },
      cancel() {},
      respondPermission(_rpcId, optionId) { answered.push(optionId); },
    };
    const store = new BotStore(homeDir, {
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: () => client,
    });
    const created = await store.create("Ada");
    await store.pickHarness(created.id, "codex");
    const requestedPath = "/tmp/openbot-dormant-http.txt";
    const options = [
      { optionId: "provider-allow-project", name: "Allow for this project", kind: "allow_always" },
      { optionId: "provider-reject-project", name: "Reject for this project", kind: "reject_always" },
    ];
    const cardId = crypto.randomUUID();
    const card = hostGrantTranscriptCard(requestedPath, "read-write", options);
    type DormantRuntimeBot = {
      permission: (PermissionPrompt & {
        cardId: string;
        title: string;
        description: string;
        hostGrant: { path: string; requested: "read-write" };
      }) | null;
      client: AcpSession | null;
      write: boolean;
      eyesMode: string;
    };
    const internals = store as unknown as {
      home: HomeStore;
      bots: Map<string, DormantRuntimeBot>;
    };
    const channelId = internals.home.directChannelId(created.id);
    assert.ok(channelId);
    internals.home.appendMessage(channelId, {
      id: cardId,
      role: "assistant",
      senderId: created.id,
      kind: "card",
      card,
      text: "Host access requested: Waiting for you",
      createdAt: "2026-08-27T10:02:00.000Z",
    });
    const runtime = internals.bots.get(created.id);
    assert.ok(runtime);
    runtime.permission = {
      rpcId: 801,
      title: "Dormant Host compatibility",
      description: card.body,
      toolKind: "edit",
      options,
      cardId,
      hostGrant: { path: requestedPath, requested: "read-write" },
    };
    runtime.client = client;
    runtime.write = true;
    runtime.eyesMode = "needs-you";

    const box = await startBox({
      password: "correct-horse",
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      botStore: store,
    });
    let boxClosed = false;
    try {
      const cookie = await login(box);
      const polledBotResponse = await fetch(`${box.url}/api/bots/${created.id}`, {
        headers: { cookie },
      });
      const polledBot = (await polledBotResponse.json()) as {
        permission: { options: Array<{ optionId: string; name: string; kind?: string }> } | null;
      };
      assert.deepEqual(polledBot.permission?.options, [
        { optionId: "provider-allow-project", name: "Allow", kind: "allow_always" },
        { optionId: "provider-reject-project", name: "Deny", kind: "reject_always" },
      ]);
      assert.doesNotMatch(JSON.stringify(polledBot.permission), /this project/);
      const response = await fetch(`${box.url}/api/bots/${created.id}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cardId, access: "read-write", duration: "until-revoked" }),
      });
      assert.equal(response.status, 200, await response.text());
      assert.deepEqual(answered, ["provider-allow-project"]);
      await box.close();
      boxClosed = true;

      const restarted = await startBox({
        password: "correct-horse",
        pwaDir,
        host: "127.0.0.1",
        port: 0,
        homeDir,
      });
      try {
        const restartedCookie = await login(restarted);
        const botResponse = await fetch(`${restarted.url}/api/bots/${created.id}`, {
          headers: { cookie: restartedCookie },
        });
        const persisted = (await botResponse.json()) as { messages: CardMessage[] };
        const resolved = persisted.messages.find((message) => message.id === cardId)?.card;
        assert.deepEqual(resolved?.status, { tone: "success", label: "Read and write · until revoked" });
        assert.deepEqual(resolved?.actions, []);
        const grantsResponse = await fetch(`${restarted.url}/api/host-grants`, {
          headers: { cookie: restartedCookie },
        });
        const grants = (await grantsResponse.json()) as { grants: Array<{ path: string; duration: string }> };
        assert.equal(grants.grants.some((grant) =>
          grant.path === requestedPath && grant.duration === "until-revoked"), true);
      } finally {
        await restarted.close();
      }
    } finally {
      if (!boxClosed) await box.close();
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

  test("serializes duplicate Card actions so one exact pending permission is consumed once", async () => {
    const homeDir = await tempHome();
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-duplicate-card-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const running = await startCardBox(homeDir, pwaDir);
    running.fake.holdResponses();
    running.fake.holdTransport();
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
        body: JSON.stringify({ text: "Run once." }),
      });
      running.fake.fire({
        rpcId: 77,
        title: "Permission",
        toolKind: "execute",
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
      const pending = await waitForCard(running.box, cookie, botId);
      const answer = () => fetch(`${running.box.url}/api/bots/${botId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cardId: pending.id, optionId: "allow-once" }),
      });
      const first = answer();
      const second = answer();
      const duplicateDeadline = Date.now() + 100;
      while (running.fake.answered.length < 2 && Date.now() < duplicateDeadline) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      running.fake.releaseTransport();
      const responses = await Promise.all([first, second]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
      assert.deepEqual(running.fake.answered, ["allow-once"]);
    } finally {
      running.fake.releaseTransport();
      await running.box.close();
    }
  });

  test("does not revive a queued prompt or resolve an expired Card after Turn replacement", async () => {
    const homeDir = await tempHome();
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-replaced-permission-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const running = await startCardBox(homeDir, pwaDir);
    running.fake.holdResponses();
    running.fake.holdTransport();
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
        body: JSON.stringify({ text: "First Turn." }),
      });
      const options = [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ];
      running.fake.fire({ rpcId: 81, title: "First", toolKind: "execute", options });
      const firstCard = await waitForCard(running.box, cookie, botId);
      const answer = fetch(`${running.box.url}/api/bots/${botId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cardId: firstCard.id, optionId: "allow-once" }),
      });
      const answerDeadline = Date.now() + 500;
      while (running.fake.answered.length === 0 && Date.now() < answerDeadline) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.deepEqual(running.fake.answered, ["allow-once"]);

      running.fake.fire({ rpcId: 82, title: "Queued stale prompt", toolKind: "read", options });
      const replacement = await fetch(`${running.box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Replacement Turn." }),
      });
      assert.equal(replacement.status, 200);
      running.fake.releaseTransport();
      assert.equal((await answer).status, 409);
      await new Promise((resolve) => setImmediate(resolve));

      const currentResponse = await fetch(`${running.box.url}/api/bots/${botId}`, { headers: { cookie } });
      const current = (await currentResponse.json()) as { permission: unknown; messages: CardMessage[] };
      assert.equal(current.permission, null);
      const cards = current.messages.filter((message) => message.kind === "card");
      assert.equal(cards.length, 1);
      assert.deepEqual(cards[0]?.card?.status, { tone: "neutral", label: "No longer available" });
    } finally {
      running.fake.releaseTransport();
      await running.box.close();
    }
  });

  test("does not append a superseding prompt after its Turn is replaced mid-delivery", async () => {
    const homeDir = await tempHome();
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-supersede-replaced-pwa-"));
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
        body: JSON.stringify({ text: "First Turn." }),
      });
      const options = [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ];
      running.fake.fire({ rpcId: 83, title: "First", toolKind: "execute", options });
      const firstCard = await waitForCard(running.box, cookie, botId);
      running.fake.holdTransport();
      running.fake.fire({ rpcId: 84, title: "Superseding", toolKind: "read", options });
      const rejectDeadline = Date.now() + 500;
      while (running.fake.answered.length === 0 && Date.now() < rejectDeadline) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.deepEqual(running.fake.answered, ["reject-once"]);

      const replacement = await fetch(`${running.box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Replacement Turn." }),
      });
      assert.equal(replacement.status, 200);
      running.fake.releaseTransport();
      await new Promise((resolve) => setImmediate(resolve));

      const currentResponse = await fetch(`${running.box.url}/api/bots/${botId}`, { headers: { cookie } });
      const current = (await currentResponse.json()) as { permission: unknown; messages: CardMessage[] };
      assert.equal(current.permission, null);
      const cards = current.messages.filter((message) => message.kind === "card");
      assert.equal(cards.length, 1);
      assert.equal(cards[0]?.id, firstCard.id);
      assert.deepEqual(cards[0]?.card?.status, { tone: "neutral", label: "No longer available" });
    } finally {
      running.fake.releaseTransport();
      await running.box.close();
    }
  });

  test("does not let a rejected stale answer fail its replacement Turn", async () => {
    const homeDir = await tempHome();
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-stale-rejection-pwa-"));
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
        body: JSON.stringify({ text: "Original Turn." }),
      });
      running.fake.fire({
        rpcId: 85,
        title: "Original",
        toolKind: "execute",
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
      const pending = await waitForCard(running.box, cookie, botId);
      running.fake.holdTransport();
      const answer = fetch(`${running.box.url}/api/bots/${botId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cardId: pending.id, optionId: "allow-once" }),
      });
      while (running.fake.answered.length === 0) await new Promise((resolve) => setImmediate(resolve));

      const replacement = await fetch(`${running.box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Replacement Turn." }),
      });
      assert.equal(replacement.status, 200);
      running.fake.failResponses();
      running.fake.releaseTransport();
      assert.equal((await answer).status, 409);

      const currentResponse = await fetch(`${running.box.url}/api/bots/${botId}`, { headers: { cookie } });
      const current = (await currentResponse.json()) as { write: boolean; messages: CardMessage[] };
      assert.equal(current.write, true);
      const card = current.messages.find((message) => message.id === pending.id)?.card;
      assert.deepEqual(card?.status, { tone: "neutral", label: "No longer available" });
      assert.equal(card?.kind, "permission");
      assert.equal(
        current.messages.filter((message) => message.role === "user" && message.text === "Replacement Turn.").length,
        1,
      );
    } finally {
      running.fake.releaseTransport();
      await running.box.close();
    }
  });

  test("keeps a permission pending until transport succeeds and turns delivery failure into a retry Card", async () => {
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
        write: boolean;
        messages: CardMessage[];
      };
      assert.equal(bot.permission, null);
      const failedCard = bot.messages.find((message) => message.id === pending.id)?.card;
      assert.deepEqual(failedCard && { ...failedCard, actions: [] }, {
        kind: "bot-failure",
        title: "Bot stopped",
        body: "The Bot could not finish this message. Try again.",
        status: { tone: "danger", label: "Failed" },
        actions: [],
      });
      const retryAction = failedCard?.actions[0];
      assert.equal(retryAction?.command.kind, "retry-message");
      assert.equal(retryAction?.command.messageId, bot.messages.find((message) => message.role === "user")?.id);
      assert.equal(bot.write, false);
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

  test("retries through the Card contract and durably removes the stale retry action", async () => {
    const homeDir = await tempHome();
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-retry-card-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const box = await startBox({
      password: "correct-horse",
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: failureFake("RETRY-SECRET").spawnAcp,
    });
    let boxClosed = false;
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
        body: JSON.stringify({ text: "Parent message." }),
      });
      const parentFailure = await waitForCard(box, cookie, botId);
      const parentResponse = await fetch(`${box.url}/api/bots/${botId}`, { headers: { cookie } });
      const parentBot = (await parentResponse.json()) as { messages: CardMessage[] };
      const parent = parentBot.messages.find(
        (message) => message.role === "user" && message.text === "Parent message.",
      );
      assert.ok(parent);

      await fetch(`${box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Retry this exact request.", replyTo: parent.id }),
      });
      let failure: CardMessage | undefined;
      const failureDeadline = Date.now() + 2_000;
      while (!failure && Date.now() < failureDeadline) {
        const response = await fetch(`${box.url}/api/bots/${botId}`, { headers: { cookie } });
        const current = (await response.json()) as { messages: CardMessage[] };
        failure = current.messages.find(
          (message) => message.card?.kind === "bot-failure" && message.id !== parentFailure.id,
        );
        if (!failure) await new Promise((resolve) => setImmediate(resolve));
      }
      assert.ok(failure);

      const retried = await fetch(
        `${box.url}/api/bots/${botId}/cards/${failure.id}/retry`,
        { method: "POST", headers: { cookie } },
      );
      const retriedBody = await retried.text();
      assert.equal(retried.status, 200, retriedBody);
      const bot = JSON.parse(retriedBody) as { messages: CardMessage[] };
      const resolved = bot.messages.find((message) => message.id === failure.id);
      assert.deepEqual(resolved?.card?.status, { tone: "success", label: "Retried" });
      assert.deepEqual(resolved?.card?.actions, []);
      const retriedMessages = bot.messages.filter(
        (message) => message.role === "user" && message.text === "Retry this exact request.",
      );
      assert.equal(retriedMessages.length, 2);
      assert.deepEqual(retriedMessages.map((message) => message.replyTo), [parent.id, parent.id]);

      const stale = await fetch(
        `${box.url}/api/bots/${botId}/cards/${failure.id}/retry`,
        { method: "POST", headers: { cookie } },
      );
      assert.equal(stale.status, 409);

      await box.close();
      boxClosed = true;
      const restarted = await startBox({
        password: "correct-horse",
        pwaDir,
        host: "127.0.0.1",
        port: 0,
        homeDir,
        listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
        spawnAcp: failureFake("RESTART-SECRET").spawnAcp,
      });
      try {
        const restartedCookie = await login(restarted);
        const response = await fetch(`${restarted.url}/api/bots/${botId}`, {
          headers: { cookie: restartedCookie },
        });
        const persisted = (await response.json()) as { messages: CardMessage[] };
        const persistedCard = persisted.messages.find((message) => message.id === failure.id);
        assert.deepEqual(persistedCard?.card?.status, { tone: "success", label: "Retried" });
        assert.deepEqual(persistedCard?.card?.actions, []);
      } finally {
        await restarted.close();
      }
    } finally {
      if (!boxClosed) await box.close();
    }
  });

  test("reserves client startup so retry and Send cannot spawn concurrent Sessions", async () => {
    const homeDir = await tempHome();
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-retry-send-race-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const fake = permissionFake();
    fake.failNextInitialize();
    const running = await startCardBox(homeDir, pwaDir, fake);
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
      const failed = await fetch(`${running.box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Retry me." }),
      });
      const failedBody = (await failed.json()) as { messages: CardMessage[] };
      const failure = failedBody.messages.find((message) => message.card?.kind === "bot-failure");
      assert.ok(failure);

      fake.holdInitialize();
      const retry = fetch(`${running.box.url}/api/bots/${botId}/cards/${failure.id}/retry`, {
        method: "POST",
        headers: { cookie },
      });
      while (fake.spawned < 2) await new Promise((resolve) => setImmediate(resolve));
      const competing = await fetch(`${running.box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Competing Send." }),
      });
      assert.equal(competing.status, 409);
      assert.equal(fake.spawned, 2);

      fake.releaseInitialize();
      assert.equal((await retry).status, 200);
      assert.equal(fake.spawned, 2);
    } finally {
      fake.releaseInitialize();
      await running.box.close();
    }
  });

  test("does not restore an Isolated Session after switching to Host during startup", async () => {
    const homeDir = await tempHome();
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-startup-mode-switch-pwa-"));
    await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
    const fake = configSwitchDuringStartupFake();
    const box = await startBox({
      password: "correct-horse",
      pwaDir,
      host: "127.0.0.1",
      port: 0,
      homeDir,
      listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      spawnAcp: fake.spawnAcp,
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

      const staleSend = fetch(`${box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Start Isolated." }),
      });
      while (fake.spawned < 1) await new Promise((resolve) => setImmediate(resolve));
      const switched = await fetch(`${box.url}/api/bots/${botId}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ configMode: "host" }),
      });
      assert.equal(switched.status, 200);
      fake.releaseInitialize();
      assert.equal((await staleSend).status, 409);
      assert.deepEqual(fake.createdSessions, ["isolated-stale"]);

      const hostSend = await fetch(`${box.url}/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "Start Host." }),
      });
      assert.equal(hostSend.status, 200);
      assert.deepEqual(fake.loadedSessions, []);
      assert.deepEqual(fake.createdSessions, ["isolated-stale", "host-fresh"]);
    } finally {
      fake.releaseInitialize();
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
        assert.equal(failure?.card?.kind, "bot-failure");
        assert.equal(failure?.card?.title, phase === "initialize" ? "Codex needs sign-in" : "Bot stopped");
        if (phase === "initialize") {
          assert.equal(
            failure?.card?.body,
            "Sign in to Codex on the host with `codex login` (device code), then try this message again.",
          );
        }
        assert.equal(failure?.card?.needsYou, undefined);
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
  test("treats a recognized ACP kind as authoritative over a conflicting optionId", () => {
    const card = permissionTranscriptCard("execute", [
      { optionId: "allow-once", name: "Reject this request", kind: "reject_once" },
      { optionId: "reject-once", name: "Allow this request", kind: "allow_once" },
    ]);

    assert.deepEqual(card.actions, [
      {
        id: "allow-once",
        label: "Deny",
        intent: "secondary",
        command: { kind: "permission", optionId: "allow-once" },
      },
      {
        id: "reject-once",
        label: "Allow once",
        intent: "primary",
        command: { kind: "permission", optionId: "reject-once" },
      },
    ]);
    assert.deepEqual(resolvedPermissionCard(card, "allow-once").status, {
      tone: "neutral",
      label: "Denied",
    });
    assert.deepEqual(resolvedPermissionCard(card, "reject-once").status, {
      tone: "success",
      label: "Allowed once",
    });
  });

  test("fails closed when a present ACP kind is unknown instead of falling back to optionId", () => {
    const card = permissionTranscriptCard("execute", [
      { optionId: "allow-once", name: "Provider-specific choice", kind: "provider_allow" },
    ]);

    assert.deepEqual(card.actions, []);
  });

  test("fails closed for malformed choices and duplicate optionIds", () => {
    const malformed = permissionTranscriptCard("execute", [
      null,
      { optionId: "allow-once", name: "Allow", kind: "allow_once" },
    ] as unknown as Array<{ optionId: string; name: string; kind?: string }>);
    assert.deepEqual(malformed.actions, []);

    const duplicate = permissionTranscriptCard("execute", [
      { optionId: "same-choice", name: "Allow", kind: "allow_once" },
      { optionId: "same-choice", name: "Reject", kind: "reject_once" },
    ]);
    assert.deepEqual(duplicate.actions, []);
  });

  test("uses canonical safe choices when ACP omits option kinds", () => {
    const card = permissionTranscriptCard("execute", [
      { optionId: "allow-once", name: "raw allow label" },
      { optionId: "always", name: "raw always label" },
      { optionId: "deny", name: "raw deny label" },
      { optionId: "reject-always", name: "raw reject label" },
      { optionId: "provider-specific", name: "raw provider label" },
    ]);

    assert.deepEqual(card.actions.map((action) => action.label), ["Allow once", "Deny"]);
    assert.doesNotMatch(JSON.stringify(card), /raw |provider-specific/);
    assert.throws(() => resolvedPermissionCard(card, "always"), /permission choice is not available/);
    assert.throws(() => resolvedPermissionCard(card, "reject-always"), /permission choice is not available/);
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
    const durable = [
      { optionId: "provider-allow", name: "Allow for this project", kind: "allow_always" },
      { optionId: "provider-reject", name: "Reject for this project", kind: "reject_always" },
    ];
    assert.deepEqual(
      hostGrantTranscriptCard("/tmp/read.txt", "read", durable).actions.map((action) => action.label),
      ["Read", "Read and write", "Deny"],
    );
    assert.deepEqual(
      hostGrantTranscriptCard("/tmp/write.txt", "read-write", durable).actions.map((action) => action.label),
      ["Read and write", "Deny"],
    );
  });
});
