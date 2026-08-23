import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { BotStore } from "../src/bots.ts";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "openbot-bots-"));
}

describe("BotStore persistence", () => {
  test("create writes bots.json and a second store restores id name and face", async () => {
    const dir = await tempWorkspace();
    const store = new BotStore(dir);
    const created = store.create("keepme");
    store.close();

    const raw = JSON.parse(await readFile(join(dir, "bots.json"), "utf8")) as Array<{
      id: string;
      name: string;
      color: string;
      shape: string;
      harness: string | null;
      messages: unknown[];
    }>;
    assert.equal(raw.length, 1);
    assert.equal(raw[0].id, created.id);
    assert.equal(raw[0].name, "keepme");
    assert.equal(raw[0].color, created.eyes.color);
    assert.equal(raw[0].shape, created.eyes.shape);
    assert.equal(raw[0].harness, null);
    assert.deepEqual(raw[0].messages, []);

    const restored = new BotStore(dir);
    const bots = restored.list();
    assert.equal(bots.length, 1);
    assert.equal(bots[0].id, created.id);
    assert.equal(bots[0].name, "keepme");
    assert.equal(bots[0].harness, null);
    assert.equal(bots[0].eyes.color, created.eyes.color);
    assert.equal(bots[0].eyes.shape, created.eyes.shape);
    assert.equal(bots[0].eyes.mode, "sleep");
    const full = restored.get(created.id);
    assert.ok(full);
    assert.deepEqual(full.messages, []);
    restored.close();
  });

  test("missing or invalid bots.json is an empty list", async () => {
    const dir = await tempWorkspace();
    const empty = new BotStore(dir);
    assert.deepEqual(empty.list(), []);
    empty.close();

    await writeFile(join(dir, "bots.json"), "{not-json");
    const bad = new BotStore(dir);
    assert.deepEqual(bad.list(), []);
    bad.close();
  });

  test("restores persisted messages with the bot", async () => {
    const dir = await tempWorkspace();
    const id = "11111111-1111-1111-1111-111111111111";
    const messages = [
      { id: "m1", role: "user", text: "hello" },
      { id: "m2", role: "assistant", text: "hi there" },
    ];
    await writeFile(
      join(dir, "bots.json"),
      JSON.stringify([
        {
          id,
          name: "keepme",
          color: "#ff3b5c",
          shape: "capsule",
          harness: null,
          messages,
        },
      ]),
    );
    const store = new BotStore(dir);
    const bot = store.get(id);
    assert.equal(bot?.id, id);
    assert.equal(bot?.name, "keepme");
    assert.equal(bot?.harness, null);
    assert.deepEqual(bot?.messages, messages);
    store.close();
  });

  test("keeps a restored harness that is not on PATH", async () => {
    const dir = await tempWorkspace();
    const id = "22222222-2222-2222-2222-222222222222";
    await writeFile(
      join(dir, "bots.json"),
      JSON.stringify([
        {
          id,
          name: "kimi-bot",
          color: "#2f8cff",
          shape: "diamond",
          harness: "kimi",
          messages: [{ id: "m1", role: "user", text: "still here" }],
        },
      ]),
    );
    const store = new BotStore(dir);
    const bot = store.get(id);
    assert.equal(bot?.harness, "kimi");
    assert.equal(bot?.name, "kimi-bot");
    assert.deepEqual(bot?.messages, [{ id: "m1", role: "user", text: "still here" }]);
    store.close();
  });
});
