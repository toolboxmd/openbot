import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { AcpClient, type AcpHandlers } from "../src/acp.ts";
import type { AcpSession } from "../src/bots.ts";
import { startBox, type RunningBox } from "../src/box.ts";
import type { SpawnSpec } from "../src/harness.ts";

type CardMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  kind?: "text" | "card";
  card?: {
    kind: string;
    title: string;
    body: string;
    status: { tone: string; label: string };
    needsYou?: { id: string; reason: "computer-help" };
    actions: Array<{
      id: string;
      label: string;
      intent: string;
      command: Record<string, string>;
    }>;
  };
};

type NeedsYouBot = {
  id: string;
  write: boolean;
  needsYou:
    | { reason: "login"; hint: string }
    | { reason: "computer-help"; hint: string; eventId: string; cardId: string }
    | null;
  permission: { cardId?: string; options: Array<{ optionId: string }> } | null;
  messages: CardMessage[];
};

const FAKE_ACP = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let identity = null;
let generationFile = null;
let promptId = null;
let scenario = "";
const helpId = 700;
const currentGeneration = () => fs.readFileSync(generationFile, "utf8").trim();
const completionSchema = {
  type: "object",
  properties: { completed: { type: "string", enum: ["done"], title: "Completion" } },
  required: ["completed"],
  additionalProperties: false
};
const help = () => send({
  jsonrpc: "2.0",
  id: helpId,
  method: "elicitation/create",
  params: {
    sessionId: "session-1",
    mode: "form",
    message: "Complete the visual step on this Computer, then choose I'm done.",
    requestedSchema: completionSchema,
    _meta: {
      "openbot/computer-help": {
        kind: "computer-help",
        version: 1,
        identity,
        generation: currentGeneration()
      }
    }
  }
});
const update = (text, messageId = "assistant-1") => send({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "session-1",
    update: { sessionUpdate: "agent_message", messageId, content: { type: "text", text } }
  }
});
const finish = (text) => {
  if (text) update(text);
  send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
};
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { authMethods: [] } });
    return;
  }
  if (message.method === "session/new" || message.method === "session/load" || message.method === "session/resume") {
    const server = message.params?.mcpServers?.find((candidate) => candidate.name === "openbot-computer-help");
    identity = server?.env?.find((entry) => entry.name === "OPENBOT_COMPUTER_HELP_IDENTITY")?.value ?? identity;
    generationFile = server?.env?.find((entry) => entry.name === "OPENBOT_COMPUTER_HELP_GENERATION_FILE")?.value ?? generationFile;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    const text = message.params?.prompt?.[0]?.text ?? "";
    scenario = [
      "FLOW_DUPLICATE", "FLOW_PENDING", "FLOW_SKIP", "FLOW_DONE", "FLOW_PERMISSION",
      "FLOW_RACE", "FLOW_SETTLE", "FLOW_EXIT", "FLOW_ORDINARY", "FLOW_AUTH_FAIL"
    ].find((name) => text.includes(name)) ?? "FLOW_DONE";
    if (scenario === "FLOW_AUTH_FAIL") {
      send({
        jsonrpc: "2.0",
        id: promptId,
        error: { code: -32000, message: "not signed in PRIVATE-CLI-AUTH" }
      });
      return;
    }
    if (scenario === "FLOW_ORDINARY") {
      send({
        jsonrpc: "2.0",
        id: 710,
        method: "elicitation/create",
        params: {
          sessionId: "session-1",
          toolCallId: "request-user-input",
          mode: "form",
          message: "PRIVATE ordinary question",
          requestedSchema: {
            type: "object",
            properties: { answer: { type: "string", enum: ["yes", "no"] } },
            required: ["answer"]
          },
          _meta: { codex: { autoResolutionMs: null } }
        }
      });
      return;
    }
    help();
    if (scenario === "FLOW_DUPLICATE") help();
    if (scenario === "FLOW_SETTLE") setImmediate(() => finish("The request ended."));
    if (scenario === "FLOW_EXIT") setTimeout(() => process.exit(0), 20);
    return;
  }
  if (message.id === 710 && message.result) {
    finish("Ordinary input was cancelled.");
    return;
  }
  if (message.id === helpId && message.result) {
    if (scenario === "FLOW_RACE") {
      send({
        jsonrpc: "2.0",
        id: promptId,
        error: { code: -32000, message: "auth failed PRIVATE-SAME-TICK" }
      });
      return;
    }
    if (scenario === "FLOW_PERMISSION") {
      send({
        jsonrpc: "2.0",
        id: 800,
        method: "session/request_permission",
        params: {
          title: "Permission after Computer help",
          options: [
            { optionId: "allow-once", name: "Allow", kind: "allow_once" },
            { optionId: "reject-once", name: "Deny", kind: "reject_once" }
          ]
        }
      });
      return;
    }
    if (message.result.action === "decline") {
      finish("The visual blocker was skipped.");
      return;
    }
    finish("The exact pending tool resumed.");
    return;
  }
  if (message.id === 800 && message.result) {
    finish("Permission answered after resume.");
  }
});
`;

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

function standardAcp(
  _spec: SpawnSpec,
  cwd: string,
  handlers: AcpHandlers = {},
): AcpSession {
  return new AcpClient({
    command: process.execPath,
    args: ["-e", FAKE_ACP],
    env: { ...process.env },
  }, cwd, handlers);
}

function failFirstDoneAcp(
  spec: SpawnSpec,
  cwd: string,
  handlers: AcpHandlers = {},
): AcpSession {
  const real = standardAcp(spec, cwd, handlers) as AcpClient;
  let failDone = true;
  return {
    close: () => real.close(),
    initialize: () => real.initialize(),
    newSession: (sessionCwd) => real.newSession(sessionCwd),
    loadSession: (sessionId) => real.loadSession(sessionId),
    resumeSession: (sessionId) => real.resumeSession(sessionId),
    prompt: (text, promptHandlers) => real.prompt(text, promptHandlers),
    cancel: () => real.cancel(),
    respondPermission: (rpcId, optionId) => real.respondPermission(rpcId, optionId),
    respondComputerHelp: (rpcId, resolution, onFlushed) => {
      if (resolution === "done" && failDone) {
        failDone = false;
        return Promise.reject(new Error("response was not flushed"));
      }
      return real.respondComputerHelp(rpcId, resolution, onFlushed);
    },
  };
}

function failAfterFlushAcp(
  spec: SpawnSpec,
  cwd: string,
  handlers: AcpHandlers = {},
): AcpSession {
  const real = standardAcp(spec, cwd, handlers) as AcpClient;
  return {
    close: () => real.close(),
    initialize: () => real.initialize(),
    newSession: (sessionCwd) => real.newSession(sessionCwd),
    loadSession: (sessionId) => real.loadSession(sessionId),
    resumeSession: (sessionId) => real.resumeSession(sessionId),
    prompt: (text, promptHandlers) => real.prompt(text, promptHandlers),
    cancel: () => real.cancel(),
    respondPermission: (rpcId, optionId) => real.respondPermission(rpcId, optionId),
    respondComputerHelp: (rpcId, resolution) => real.respondComputerHelp(
      rpcId,
      resolution,
      () => { throw new Error("durable Card commit failed"); },
    ),
  };
}

async function startTestBox(
  homeDir: string,
  pwaDir: string,
  spawnAcp = standardAcp,
): Promise<RunningBox> {
  return startBox({
    password: "correct-horse",
    pwaDir,
    host: "127.0.0.1",
    port: 0,
    homeDir,
    listHarnesses: () => [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
    spawnAcp,
  });
}

async function createCodexBot(box: RunningBox, cookie: string, name: string): Promise<string> {
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

async function getBot(box: RunningBox, cookie: string, botId: string): Promise<NeedsYouBot> {
  const response = await fetch(`${box.url}/api/bots/${botId}`, { headers: { cookie } });
  assert.equal(response.status, 200);
  return response.json() as Promise<NeedsYouBot>;
}

async function waitForBot(
  box: RunningBox,
  cookie: string,
  botId: string,
  predicate: (bot: NeedsYouBot) => boolean,
  message: string,
): Promise<NeedsYouBot> {
  const deadline = Date.now() + 2_000;
  let bot = await getBot(box, cookie, botId);
  while (!predicate(bot) && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
    bot = await getBot(box, cookie, botId);
  }
  assert.equal(predicate(bot), true, message);
  return bot;
}

async function sendMessage(box: RunningBox, cookie: string, botId: string, text: string): Promise<Response> {
  return fetch(`${box.url}/api/bots/${botId}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

function pendingComputer(bot: NeedsYouBot) {
  assert.equal(bot.needsYou?.reason, "computer-help");
  if (bot.needsYou?.reason !== "computer-help") throw new Error("Computer help is not pending");
  const needsYou = bot.needsYou;
  const card = bot.messages.find((message) => message.id === needsYou.cardId);
  assert.ok(card?.card);
  return { card: card!, cardId: card!.id, eventId: needsYou.eventId };
}

async function resolveComputer(
  box: RunningBox,
  cookie: string,
  botId: string,
  cardId: string,
  eventId: string,
  resolution: "done" | "skip",
): Promise<Response> {
  return fetch(`${box.url}/api/bots/${botId}/cards/${cardId}/needs-you`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ eventId, resolution }),
  });
}

async function fixture(spawnAcp = standardAcp) {
  const homeDir = await mkdtemp(join(tmpdir(), "openbot-needs-you-home-"));
  const pwaDir = await mkdtemp(join(tmpdir(), "openbot-needs-you-pwa-"));
  await writeFile(join(pwaDir, "index.html"), "<!doctype html><title>OpenBot</title>");
  const box = await startTestBox(homeDir, pwaDir, spawnAcp);
  const cookie = await login(box);
  return { homeDir, pwaDir, box, cookie };
}

describe("needs-you Computer Card", () => {
  test("rejects non-object resolution bodies without touching the pending event", async () => {
    const { box, cookie } = await fixture();
    try {
      const botId = await createCodexBot(box, cookie, "Ada");
      assert.equal((await sendMessage(box, cookie, botId, "FLOW_PENDING")).status, 200);
      const pending = await waitForBot(
        box,
        cookie,
        botId,
        (bot) => bot.needsYou?.reason === "computer-help",
        "help did not appear",
      );
      const active = pendingComputer(pending);
      const before = await getBot(box, cookie, botId);

      const invalidBodies: unknown[] = [null, [], 42, true, "text"];
      for (const body of invalidBodies) {
        const response = await fetch(
          `${box.url}/api/bots/${botId}/cards/${active.cardId}/needs-you`,
          {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        assert.equal(response.status, 400, `accepted ${JSON.stringify(body)}`);
        assert.deepEqual(await response.json(), {
          error: "request body must be a JSON object",
        });
      }

      assert.deepEqual(await getBot(box, cookie, botId), before);
      const valid = await resolveComputer(
        box,
        cookie,
        botId,
        active.cardId,
        active.eventId,
        "skip",
      );
      assert.equal(valid.status, 200);
    } finally {
      await box.close();
    }
  });

  test("one first-party ACP elicitation creates one sanitized durable Card and blocks duplicate work", async () => {
    const { box, cookie } = await fixture();
    try {
      const botId = await createCodexBot(box, cookie, "Ada");
      const sent = await sendMessage(box, cookie, botId, "FLOW_DUPLICATE");
      assert.equal(sent.status, 200);
      const pending = await waitForBot(
        box,
        cookie,
        botId,
        (bot) => bot.needsYou?.reason === "computer-help",
        "Computer-help Card did not appear",
      );
      const { card, cardId, eventId } = pendingComputer(pending);
      assert.deepEqual(card.card, {
        kind: "computer",
        title: "Computer",
        body: "Complete the visual step on this Computer, then choose I'm done.",
        status: { tone: "waiting", label: "Action needed" },
        needsYou: { id: eventId, reason: "computer-help" },
        actions: [
          {
            id: "open-computer",
            label: "Open computer",
            intent: "primary",
            command: { kind: "open-computer", eventId },
          },
          {
            id: "done",
            label: "I'm done",
            intent: "secondary",
            command: { kind: "resolve-needs-you", eventId, resolution: "done" },
          },
          {
            id: "skip",
            label: "Skip",
            intent: "secondary",
            command: { kind: "resolve-needs-you", eventId, resolution: "skip" },
          },
        ],
      });
      assert.deepEqual(pending.needsYou, {
        reason: "computer-help",
        hint: "Complete the visual step on this Computer, then choose I'm done.",
        eventId,
        cardId,
      });
      assert.equal(pending.messages.filter((message) => message.card?.kind === "computer").length, 1);
      assert.doesNotMatch(JSON.stringify(pending), /identity|PRIVATE|rawInput|requestedSchema/i);

      const inbox = await fetch(`${box.url}/api/inbox`, { headers: { cookie } });
      const inboxText = await inbox.text();
      assert.equal(inbox.status, 200, inboxText);
      assert.equal(JSON.parse(inboxText).bots.find((bot: { id: string }) => bot.id === botId).needsYou.eventId, eventId);

      const refreshed = await getBot(box, cookie, botId);
      assert.equal(refreshed.needsYou?.reason, "computer-help");
      assert.equal(refreshed.messages.filter((message) => message.card?.kind === "computer").length, 1);

      const configChange = await fetch(`${box.url}/api/bots/${botId}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ configMode: "host" }),
      });
      assert.equal(configChange.status, 409);
      const concurrentSend = await sendMessage(box, cookie, botId, "new work must not replace the event");
      assert.equal(concurrentSend.status, 409);
      const unchanged = await getBot(box, cookie, botId);
      assert.equal(unchanged.messages.filter((message) => message.card?.kind === "computer").length, 1);
      assert.equal(unchanged.messages.filter((message) => message.role === "user").length, 1);
    } finally {
      await box.close();
    }
  });

  test("Skip is one terminal response, rejects duplicate and cross-Bot actions, and persists as history", async () => {
    const { homeDir, pwaDir, box, cookie } = await fixture();
    let closed = false;
    try {
      const adaId = await createCodexBot(box, cookie, "Ada");
      const benId = await createCodexBot(box, cookie, "Ben");
      assert.equal((await sendMessage(box, cookie, adaId, "FLOW_SKIP")).status, 200);
      assert.equal((await sendMessage(box, cookie, benId, "FLOW_PENDING")).status, 200);
      const adaPending = await waitForBot(box, cookie, adaId, (bot) => bot.needsYou?.reason === "computer-help", "Ada did not wait");
      const benPending = await waitForBot(box, cookie, benId, (bot) => bot.needsYou?.reason === "computer-help", "Ben did not wait");
      const ada = pendingComputer(adaPending);
      const ben = pendingComputer(benPending);

      const crossBot = await resolveComputer(box, cookie, benId, ada.cardId, ada.eventId, "skip");
      assert.equal(crossBot.status, 404);
      const concurrent = await Promise.all([
        resolveComputer(box, cookie, adaId, ada.cardId, ada.eventId, "skip"),
        resolveComputer(box, cookie, adaId, ada.cardId, ada.eventId, "skip"),
      ]);
      assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 409]);
      const skipped = await waitForBot(box, cookie, adaId, (bot) => !bot.write, "Skip did not resume the Turn");
      assert.equal(skipped.needsYou, null);
      assert.deepEqual(skipped.messages.find((message) => message.id === ada.cardId)?.card?.status, {
        tone: "neutral",
        label: "Skipped",
      });
      assert.deepEqual(
        skipped.messages.find((message) => message.id === ada.cardId)?.card?.actions.map((action) => action.label),
        ["Open computer"],
      );
      const delayed = await resolveComputer(box, cookie, adaId, ada.cardId, ada.eventId, "done");
      assert.equal(delayed.status, 409);
      assert.equal((await getBot(box, cookie, benId)).needsYou?.reason, "computer-help");

      await box.close();
      closed = true;
      const restarted = await startTestBox(homeDir, pwaDir);
      try {
        const restartedCookie = await login(restarted);
        const adaHistory = await getBot(restarted, restartedCookie, adaId);
        assert.equal(adaHistory.needsYou, null);
        assert.equal(adaHistory.messages.find((message) => message.id === ada.cardId)?.card?.status.label, "Skipped");

        const benHistory = await getBot(restarted, restartedCookie, benId);
        assert.equal(benHistory.needsYou, null);
        const interrupted = benHistory.messages.find((message) => message.id === ben.cardId)?.card;
        assert.deepEqual(interrupted?.status, { tone: "neutral", label: "No longer available" });
        assert.equal(interrupted?.body, "This request ended before the Bot received your response.");
        assert.deepEqual(interrupted?.actions.map((action) => action.label), ["Open computer"]);
        const restartedInbox = await fetch(`${restarted.url}/api/inbox`, {
          headers: { cookie: restartedCookie },
        });
        assert.equal(restartedInbox.status, 200);
        const restartedInboxBody = await restartedInbox.json() as {
          bots: Array<{ id: string; needsYou: NeedsYouBot["needsYou"] }>;
        };
        assert.equal(restartedInboxBody.bots.find((bot) => bot.id === benId)?.needsYou, null);

        const stale = await resolveComputer(restarted, restartedCookie, benId, ben.cardId, ben.eventId, "done");
        assert.equal(stale.status, 409);
        assert.equal((await sendMessage(restarted, restartedCookie, benId, "FLOW_DONE")).status, 200);
        const fresh = await waitForBot(
          restarted,
          restartedCookie,
          benId,
          (bot) => bot.needsYou?.reason === "computer-help",
          "a fresh event did not appear after restart cleanup",
        );
        const next = pendingComputer(fresh);
        assert.notEqual(next.eventId, ben.eventId);
        assert.equal(fresh.messages.filter((message) => message.card?.kind === "computer").length, 2);
      } finally {
        await restarted.close();
      }
    } finally {
      if (!closed) await box.close();
    }
  });

  test("Done commits at response flush, leaves the Turn running, and preserves permission-first resume", async () => {
    const { homeDir, pwaDir, box, cookie } = await fixture();
    let closed = false;
    try {
      const botId = await createCodexBot(box, cookie, "Ada");
      assert.equal((await sendMessage(box, cookie, botId, "FLOW_PERMISSION")).status, 200);
      const pending = await waitForBot(box, cookie, botId, (bot) => bot.needsYou?.reason === "computer-help", "help did not appear");
      const { cardId, eventId } = pendingComputer(pending);
      const response = await resolveComputer(box, cookie, botId, cardId, eventId, "done");
      const responseText = await response.text();
      assert.equal(response.status, 200, responseText);
      const resumed = JSON.parse(responseText) as NeedsYouBot;
      assert.equal(resumed.needsYou, null);
      assert.equal(resumed.write, true);
      assert.deepEqual(resumed.messages.find((message) => message.id === cardId)?.card?.status, {
        tone: "success",
        label: "Done",
      });
      assert.deepEqual(
        resumed.messages.find((message) => message.id === cardId)?.card?.actions.map((action) => action.label),
        ["Open computer"],
      );

      const permission = await waitForBot(box, cookie, botId, (bot) => Boolean(bot.permission?.cardId), "permission-first resume was lost");
      assert.equal(permission.needsYou, null);
      assert.equal(permission.write, true);
      const permissionCardId = permission.permission?.cardId ?? "";
      const optionId = permission.permission?.options.find((option) => option.optionId === "allow-once")?.optionId ?? "";
      const answered = await fetch(`${box.url}/api/bots/${botId}/permissions`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cardId: permissionCardId, optionId }),
      });
      assert.equal(answered.status, 200);
      const finished = await waitForBot(box, cookie, botId, (bot) => !bot.write, "resumed Turn did not finish");
      assert.equal(finished.needsYou, null);
      assert.equal(finished.messages.find((message) => message.id === cardId)?.card?.status.label, "Done");
      assert.equal(finished.messages.some((message) => message.text === "Permission answered after resume."), true);

      await box.close();
      closed = true;
      const restarted = await startTestBox(homeDir, pwaDir);
      try {
        const restartedCookie = await login(restarted);
        const history = await getBot(restarted, restartedCookie, botId);
        assert.equal(history.needsYou, null);
        const doneCard = history.messages.find((message) => message.id === cardId)?.card;
        assert.deepEqual(doneCard?.status, { tone: "success", label: "Done" });
        assert.deepEqual(doneCard?.actions.map((action) => action.label), ["Open computer"]);
      } finally {
        await restarted.close();
      }
    } finally {
      if (!closed) await box.close();
    }
  });

  test("same-tick auth rejection cannot revive the old Card or become a second Computer event", async () => {
    const { box, cookie } = await fixture();
    try {
      const botId = await createCodexBot(box, cookie, "Ada");
      assert.equal((await sendMessage(box, cookie, botId, "FLOW_RACE")).status, 200);
      const pending = await waitForBot(box, cookie, botId, (bot) => bot.needsYou?.reason === "computer-help", "help did not appear");
      const { cardId, eventId } = pendingComputer(pending);
      const response = await resolveComputer(box, cookie, botId, cardId, eventId, "done");
      assert.equal(response.status, 200);
      const failed = await waitForBot(
        box,
        cookie,
        botId,
        (bot) => !bot.write && bot.messages.some((message) => message.card?.kind === "bot-failure"),
        "same-tick auth failure was not recorded",
      );
      assert.equal(failed.needsYou?.reason, "login");
      assert.equal(failed.messages.filter((message) => message.card?.kind === "computer").length, 1);
      assert.equal(failed.messages.find((message) => message.id === cardId)?.card?.status.label, "Done");
      const authCard = failed.messages.find((message) => message.card?.kind === "bot-failure")?.card;
      assert.equal(authCard?.title, "Codex needs sign-in");
      assert.match(authCard?.body ?? "", /host.*codex login.*device code/i);
      assert.doesNotMatch(JSON.stringify(failed), /PRIVATE-SAME-TICK/);
      const stale = await resolveComputer(box, cookie, botId, cardId, eventId, "skip");
      assert.equal(stale.status, 409);
    } finally {
      await box.close();
    }
  });

  test("a response flushed before durable mutation becomes non-actionable unconfirmed history", async () => {
    const { box, cookie } = await fixture(failAfterFlushAcp);
    try {
      const botId = await createCodexBot(box, cookie, "Ada");
      assert.equal((await sendMessage(box, cookie, botId, "FLOW_PENDING")).status, 200);
      const pending = await waitForBot(
        box,
        cookie,
        botId,
        (bot) => bot.needsYou?.reason === "computer-help",
        "help did not appear",
      );
      const active = pendingComputer(pending);

      const response = await resolveComputer(
        box,
        cookie,
        botId,
        active.cardId,
        active.eventId,
        "done",
      );
      assert.equal(response.status, 409);
      assert.match(await response.text(), /sent.*could not confirm/i);

      const unconfirmed = await getBot(box, cookie, botId);
      assert.equal(unconfirmed.needsYou, null);
      const card = unconfirmed.messages.find((message) => message.id === active.cardId)?.card;
      assert.deepEqual(card?.status, { tone: "neutral", label: "No longer available" });
      assert.equal(
        card?.body,
        "OpenBot sent your response but could not confirm this request's final state.",
      );
      assert.deepEqual(card?.actions.map((action) => action.label), ["Open computer"]);

      const retry = await resolveComputer(
        box,
        cookie,
        botId,
        active.cardId,
        active.eventId,
        "done",
      );
      assert.equal(retry.status, 409);
    } finally {
      await box.close();
    }
  });

  test("failed response stays actionable, while settlement, child exit, ordinary forms, and CLI auth do not create live Computer Cards", async () => {
    const failing = await fixture(failFirstDoneAcp);
    try {
      const botId = await createCodexBot(failing.box, failing.cookie, "Ada");
      assert.equal((await sendMessage(failing.box, failing.cookie, botId, "FLOW_PENDING")).status, 200);
      const pending = await waitForBot(failing.box, failing.cookie, botId, (bot) => bot.needsYou?.reason === "computer-help", "help did not appear");
      const active = pendingComputer(pending);
      const failedResponse = await resolveComputer(
        failing.box,
        failing.cookie,
        botId,
        active.cardId,
        active.eventId,
        "done",
      );
      assert.equal(failedResponse.status, 409);
      const stillPending = await getBot(failing.box, failing.cookie, botId);
      assert.equal(stillPending.needsYou?.reason, "computer-help");
      assert.deepEqual(stillPending.messages.find((message) => message.id === active.cardId)?.card?.status, {
        tone: "waiting",
        label: "Action needed",
      });
      assert.equal(
        stillPending.messages.find((message) => message.id === active.cardId)?.card?.body,
        "Complete the visual step on this Computer, then choose I'm done.",
      );
      const retried = await resolveComputer(
        failing.box,
        failing.cookie,
        botId,
        active.cardId,
        active.eventId,
        "done",
      );
      assert.equal(retried.status, 200);
      const resolved = (await retried.json()) as NeedsYouBot;
      assert.equal(
        resolved.messages.find((message) => message.id === active.cardId)?.card?.body,
        "Complete the visual step on this Computer, then choose I'm done.",
      );
    } finally {
      await failing.box.close();
    }

    const normal = await fixture();
    try {
      const settleId = await createCodexBot(normal.box, normal.cookie, "Settle");
      assert.equal((await sendMessage(normal.box, normal.cookie, settleId, "FLOW_SETTLE")).status, 200);
      const settled = await waitForBot(
        normal.box,
        normal.cookie,
        settleId,
        (bot) => !bot.write
          && bot.needsYou === null
          && bot.messages.some((message) => message.card?.kind === "computer" && message.card.status.label === "No longer available"),
        "settlement did not leave coherent non-resumable history",
      );
      assert.equal(settled.messages.filter((message) => message.card?.kind === "computer").length, 1);

      const exitId = await createCodexBot(normal.box, normal.cookie, "Exit");
      assert.equal((await sendMessage(normal.box, normal.cookie, exitId, "FLOW_EXIT")).status, 200);
      const exited = await waitForBot(
        normal.box,
        normal.cookie,
        exitId,
        (bot) => !bot.write
          && bot.needsYou === null
          && bot.messages.some((message) => message.card?.kind === "computer" && message.card.status.label === "No longer available"),
        "child exit did not leave coherent non-resumable history",
      );
      assert.equal(exited.messages.filter((message) => message.card?.kind === "computer").length, 1);

      const ordinaryId = await createCodexBot(normal.box, normal.cookie, "Ordinary");
      assert.equal((await sendMessage(normal.box, normal.cookie, ordinaryId, "FLOW_ORDINARY")).status, 200);
      const ordinary = await waitForBot(normal.box, normal.cookie, ordinaryId, (bot) => !bot.write, "ordinary form did not settle");
      assert.equal(ordinary.needsYou, null);
      assert.equal(ordinary.messages.some((message) => message.card?.kind === "computer"), false);
      assert.doesNotMatch(JSON.stringify(ordinary), /PRIVATE ordinary question/);

      const authId = await createCodexBot(normal.box, normal.cookie, "Auth");
      assert.equal((await sendMessage(normal.box, normal.cookie, authId, "FLOW_AUTH_FAIL")).status, 200);
      const auth = await waitForBot(normal.box, normal.cookie, authId, (bot) => !bot.write && bot.needsYou?.reason === "login", "auth failure missing");
      assert.equal(auth.messages.some((message) => message.card?.kind === "computer"), false);
      assert.equal(auth.messages.filter((message) => message.card?.kind === "bot-failure").length, 1);
      assert.match(auth.needsYou?.hint ?? "", /host.*codex login.*device code/i);
      assert.doesNotMatch(JSON.stringify(auth), /PRIVATE-CLI-AUTH/);
    } finally {
      await normal.box.close();
    }
  });
});
