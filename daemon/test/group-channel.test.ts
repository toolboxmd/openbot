import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { startBox } from "../src/box.ts";
import { HUMAN_MEMBER_ID, HomeStore } from "../src/home.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "openbot-group-home-"));
}

function iso(offsetMs = 0): string {
  return new Date(Date.parse("2026-01-01T00:00:00.000Z") + offsetMs).toISOString();
}

function addBot(home: HomeStore, name: string, offsetMs = 0) {
  const id = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  home.createBot(
    {
      id,
      name,
      color: name === "Ada" ? "#ff3b5c" : "#3b82f6",
      shape: name === "Ada" ? "capsule" : "sphere",
      harness: null,
      createdAt: iso(offsetMs),
    },
    channelId,
  );
  return { id, channelId };
}

describe("HomeStore createGroup", () => {
  test("inserts kind=group with members you + those Bots and listChannels returns it", async () => {
    const homeDir = await tempHome();
    const home = new HomeStore(homeDir);
    const ada = addBot(home, "Ada");
    const bob = addBot(home, "Bob", 1000);
    const group = home.createGroup({ title: "Ada & Bob", memberBotIds: [ada.id, bob.id] });
    assert.equal(group.kind, "group");
    assert.notEqual(group.kind, "bot-to-bot");
    assert.equal(group.title, "Ada & Bob");
    assert.deepEqual(
      group.members.map((member) => `${member.kind}:${member.id}`),
      [`user:${HUMAN_MEMBER_ID}`, `bot:${ada.id}`, `bot:${bob.id}`],
    );
    const listed = home.listChannels().filter((channel) => channel.kind === "group");
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, group.id);
    assert.equal(listed[0]?.kind, "group");
    assert.equal(home.directChannelId(ada.id), ada.channelId);
    assert.equal(home.directChannelId(bob.id), bob.channelId);
    home.close();
  });

  test("Restart HomeStore: title, member IDs, and member order survive", async () => {
    const homeDir = await tempHome();
    const home = new HomeStore(homeDir);
    const ada = addBot(home, "Ada");
    const bob = addBot(home, "Bob", 1000);
    const group = home.createGroup({ title: "  Launch crew  ", memberBotIds: [ada.id, bob.id] });
    assert.equal(group.title, "Launch crew");
    home.close();

    const again = new HomeStore(homeDir);
    const restored = again.listChannels().find((channel) => channel.id === group.id);
    assert.ok(restored);
    assert.equal(restored.kind, "group");
    assert.notEqual(restored.kind, "bot-to-bot");
    assert.equal(restored.title, "Launch crew");
    assert.deepEqual(
      restored.members.map((member) => `${member.kind}:${member.id}`),
      [`user:${HUMAN_MEMBER_ID}`, `bot:${ada.id}`, `bot:${bob.id}`],
    );
    assert.equal(again.directChannelId(ada.id), ada.channelId);
    again.close();
  });

  test("rejects blank titles and fewer than two distinct existing Bots without mutation", async () => {
    const homeDir = await tempHome();
    const home = new HomeStore(homeDir);
    const ada = addBot(home, "Ada");
    assert.throws(
      () => home.createGroup({ title: "   ", memberBotIds: [ada.id, crypto.randomUUID()] }),
      { status: 400, message: /title/ },
    );
    assert.throws(() => home.createGroup({ title: "Crew", memberBotIds: [] }), { status: 400, message: /members/ });
    assert.throws(() => home.createGroup({ title: "Crew", memberBotIds: ["   "] }), { status: 400, message: /members/ });
    assert.throws(() => home.createGroup({ title: "Crew", memberBotIds: [crypto.randomUUID()] }), {
      status: 400,
      message: /unknown Bot/,
    });
    assert.throws(() => home.createGroup({ title: "Crew", memberBotIds: [ada.id] }), {
      status: 400,
      message: /two distinct Bots/,
    });
    assert.throws(() => home.createGroup({ title: "Crew", memberBotIds: [ada.id, ada.id] }), {
      status: 400,
      message: /two distinct Bots/,
    });
    assert.throws(
      () => home.createGroup({ title: "Crew", memberBotIds: [ada.id, crypto.randomUUID()] }),
      { status: 400, message: /unknown Bot/ },
    );
    assert.equal(home.listChannels().some((channel) => channel.kind === "group"), false);
    home.close();
  });
});

describe("PWA group sidebar helpers", () => {
  test("source: stacked Eyes, group row, members, no Bot-to-Bot sidebar row, send gated", () => {
    const messenger = readFileSync(join(ROOT, "pwa/src/components/Messenger.tsx"), "utf8");
    const stacked = readFileSync(join(ROOT, "pwa/src/components/StackedEyes.tsx"), "utf8");
    const channels = readFileSync(join(ROOT, "pwa/src/lib/channels.ts"), "utf8");
    assert.match(stacked, /data-testid=["']stacked-eyes["']/);
    assert.match(messenger, /group-channel-row/);
    assert.match(messenger, /data-testid=["']group-members["']/);
    assert.match(messenger, /StackedEyes/);
    assert.match(messenger, /buildChatInbox/);
    assert.match(channels, /bot-to-bot/);
    assert.match(channels, /kind === "group"/);
    assert.match(messenger, /composerSendEnabled/);
    assert.match(messenger, /data-testid=["']composer-send["']/);
  });
});

function cookieHeader(res: Response): string {
  return res.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

type PublicBot = { id: string; name: string };
type PublicMember = {
  kind: "user" | "bot";
  id: string;
  name?: string;
  eyes?: { color: string; shape: string; mode: string };
};
type PublicChannel = {
  id: string;
  kind: string;
  title: string | null;
  members: PublicMember[];
};

describe("Talk HTTP group Channel", () => {
  test("POST create group, list includes it, GET shows members, POST messages is 4xx, restart keeps it, bots API stays Bots", async () => {
    const homeDir = await tempHome();
    const pwaDir = await mkdtemp(join(tmpdir(), "openbot-group-pwa-"));
    await writeFile(join(pwaDir, "index.html"), `<!doctype html><title>OpenBot</title>`);
    const start = async () =>
      startBox({
        password: "correct-horse",
        pwaDir,
        host: "127.0.0.1",
        port: 0,
        homeDir,
      });
    let box = await start();
    try {
      const login = await fetch(`${box.url}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "correct-horse" }),
      });
      const cookie = cookieHeader(login);
      const adaRes = await fetch(`${box.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      });
      const bobRes = await fetch(`${box.url}/api/bots`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Bob" }),
      });
      assert.equal(adaRes.status, 201);
      assert.equal(bobRes.status, 201);
      const ada = (await adaRes.json()) as PublicBot;
      const bob = (await bobRes.json()) as PublicBot;

      const botsBefore = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
      const botsBeforeBody = (await botsBefore.json()) as { bots: PublicBot[]; channels?: unknown };
      assert.deepEqual(botsBeforeBody.bots.map((bot) => bot.name).sort(), ["Ada", "Bob"]);

      const invalidBodies: Array<{ label: string; body: unknown }> = [
        { label: "missing title", body: { kind: "group", botIds: [ada.id, bob.id] } },
        { label: "blank title", body: { kind: "group", title: "   ", botIds: [ada.id, bob.id] } },
        { label: "malformed title", body: { kind: "group", title: 42, botIds: [ada.id, bob.id] } },
        { label: "missing members", body: { kind: "group", title: "Crew" } },
        { label: "malformed members", body: { kind: "group", title: "Crew", botIds: ada.id } },
        { label: "malformed member", body: { kind: "group", title: "Crew", botIds: [ada.id, 42] } },
        { label: "blank member", body: { kind: "group", title: "Crew", botIds: [ada.id, bob.id, "   "] } },
        { label: "duplicate member", body: { kind: "group", title: "Crew", botIds: [ada.id, bob.id, ada.id] } },
        { label: "too few distinct members", body: { kind: "group", title: "Crew", botIds: [ada.id, ada.id] } },
        { label: "unknown Bot", body: { kind: "group", title: "Crew", botIds: [ada.id, crypto.randomUUID()] } },
        { label: "hidden kind", body: { kind: "bot-to-bot", title: "Crew", botIds: [ada.id, bob.id] } },
      ];
      for (const invalid of invalidBodies) {
        const response = await fetch(`${box.url}/api/channels`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(invalid.body),
        });
        assert.ok(
          response.status >= 400 && response.status < 500,
          `${invalid.label} expected bounded 4xx, got ${response.status}`,
        );
        const afterInvalid = await fetch(`${box.url}/api/channels`, { headers: { cookie } });
        const afterInvalidBody = (await afterInvalid.json()) as { channels: PublicChannel[] };
        assert.equal(
          afterInvalidBody.channels.some((channel) => channel.kind === "group"),
          false,
          `${invalid.label} must not mutate Home`,
        );
      }

      const malformedJson = await fetch(`${box.url}/api/channels`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{",
      });
      assert.ok(
        malformedJson.status >= 400 && malformedJson.status < 500,
        `malformed JSON expected bounded 4xx, got ${malformedJson.status}`,
      );
      const afterMalformed = await fetch(`${box.url}/api/channels`, { headers: { cookie } });
      const afterMalformedBody = (await afterMalformed.json()) as { channels: PublicChannel[] };
      assert.equal(afterMalformedBody.channels.some((channel) => channel.kind === "group"), false);

      const created = await fetch(`${box.url}/api/channels`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ kind: "group", title: "  Launch crew  ", botIds: [ada.id, bob.id] }),
      });
      assert.equal(created.status, 201, await created.clone().text());
      const group = (await created.json()) as PublicChannel;
      assert.equal(group.kind, "group");
      assert.notEqual(group.kind, "bot-to-bot");
      assert.equal(group.title, "Launch crew");
      assert.deepEqual(
        group.members.map((member) => `${member.kind}:${member.id}`),
        [`user:${HUMAN_MEMBER_ID}`, `bot:${ada.id}`, `bot:${bob.id}`],
      );
      assert.deepEqual(group.members.filter((member) => member.kind === "bot").map((member) => member.name), ["Ada", "Bob"]);
      assert.ok(group.members.filter((member) => member.kind === "bot").every((member) => member.eyes));

      const listed = await fetch(`${box.url}/api/channels`, { headers: { cookie } });
      assert.equal(listed.status, 200);
      const listBody = (await listed.json()) as { channels: PublicChannel[] };
      const groups = listBody.channels.filter((channel) => channel.kind === "group");
      assert.equal(groups.length, 1);
      assert.equal(groups[0]?.id, group.id);
      assert.equal(groups[0]?.title, "Launch crew");
      assert.deepEqual(
        groups[0]?.members.map((member) => `${member.kind}:${member.id}`),
        [`user:${HUMAN_MEMBER_ID}`, `bot:${ada.id}`, `bot:${bob.id}`],
      );
      const directBeforeRestart = listBody.channels
        .filter((channel) => channel.kind === "direct")
        .map((channel) => ({
          id: channel.id,
          title: channel.title,
          members: channel.members.map((member) => `${member.kind}:${member.id}`),
        }));
      assert.equal(directBeforeRestart.length, 2, "each Bot keeps its born direct Channel");
      assert.ok(directBeforeRestart.every((channel) => channel.title === null));
      assert.equal(
        listBody.channels.some((channel) => channel.kind === "bot-to-bot"),
        false,
      );

      const detail = await fetch(`${box.url}/api/channels/${group.id}`, { headers: { cookie } });
      assert.equal(detail.status, 200);
      const shown = (await detail.json()) as PublicChannel;
      assert.equal(shown.kind, "group");
      assert.equal(shown.title, "Launch crew");
      assert.equal(shown.members.length, 3);
      assert.ok(shown.members.some((member) => member.kind === "bot" && member.id === ada.id && member.name === "Ada"));
      assert.ok(shown.members.some((member) => member.kind === "bot" && member.id === bob.id && member.name === "Bob"));

      const send = await fetch(`${box.url}/api/channels/${group.id}/messages`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "hi group" }),
      });
      assert.ok(send.status >= 400 && send.status < 500, `group send expected 4xx, got ${send.status}`);

      const botsAfter = await fetch(`${box.url}/api/bots`, { headers: { cookie } });
      const botsAfterBody = (await botsAfter.json()) as { bots: PublicBot[] };
      assert.equal(botsAfter.status, 200);
      assert.deepEqual(botsAfterBody.bots.map((bot) => bot.name).sort(), ["Ada", "Bob"]);
      assert.equal(
        botsAfterBody.bots.some((bot) => bot.id === group.id),
        false,
        "GET /api/bots must stay a Bot list",
      );

      const thread = await fetch(`${box.url}/api/bots/${ada.id}/messages`, { headers: { cookie } });
      assert.equal(thread.status, 200);

      await box.close();
      box = await start();
      const login2 = await fetch(`${box.url}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "correct-horse" }),
      });
      const cookie2 = cookieHeader(login2);
      const restoredList = await fetch(`${box.url}/api/channels`, { headers: { cookie: cookie2 } });
      const restoredBody = (await restoredList.json()) as { channels: PublicChannel[] };
      const restored = restoredBody.channels.find((channel) => channel.id === group.id);
      assert.ok(restored, "group Channel must survive Talk restart");
      assert.equal(restored.kind, "group");
      assert.notEqual(restored.kind, "bot-to-bot");
      assert.equal(restored.id, group.id);
      assert.equal(restored.title, "Launch crew");
      assert.deepEqual(
        restored.members.map((member) => `${member.kind}:${member.id}`),
        [`user:${HUMAN_MEMBER_ID}`, `bot:${ada.id}`, `bot:${bob.id}`],
      );
      const directAfterRestart = restoredBody.channels
        .filter((channel) => channel.kind === "direct")
        .map((channel) => ({
          id: channel.id,
          title: channel.title,
          members: channel.members.map((member) => `${member.kind}:${member.id}`),
        }));
      assert.deepEqual(directAfterRestart, directBeforeRestart);

      const db = new DatabaseSync(join(homeDir, "talk.sqlite"));
      const hiddenId = crypto.randomUUID();
      db.prepare("INSERT INTO channels (id, kind, title, created_at) VALUES (?, 'bot-to-bot', NULL, ?)").run(
        hiddenId,
        iso(5000),
      );
      db.prepare(
        "INSERT INTO channel_members (channel_id, member_kind, member_id, position) VALUES (?, 'bot', ?, 0)",
      ).run(hiddenId, ada.id);
      db.prepare(
        "INSERT INTO channel_members (channel_id, member_kind, member_id, position) VALUES (?, 'bot', ?, 1)",
      ).run(hiddenId, bob.id);
      db.close();

      const afterHidden = await fetch(`${box.url}/api/channels`, { headers: { cookie: cookie2 } });
      const afterHiddenBody = (await afterHidden.json()) as { channels: PublicChannel[] };
      assert.equal(
        afterHiddenBody.channels.some((channel) => channel.kind === "bot-to-bot" || channel.id === hiddenId),
        false,
        "Bot-to-Bot must not appear on the Channel list",
      );
      assert.ok(afterHiddenBody.channels.some((channel) => channel.id === group.id));
    } finally {
      await box.close();
    }
  });
});
