import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildChatInbox } from "../src/lib/chat-inbox.ts";
import { resolveNeedsYouCard } from "../src/lib/session.ts";

const activity = (unread: boolean) => ({
  latestText: "Computer: Action needed",
  lastActivityAt: "2026-08-27T18:00:00.000Z",
  unread,
  cursor: { sequence: 4, revision: 1 },
});

describe("needs-you PWA actions", () => {
  test("sends the exact Bot, Card, event, and resolution to Talk", async () => {
    const originalFetch = globalThis.fetch;
    let request: { input: string; init?: RequestInit } | null = null;
    globalThis.fetch = async (input, init) => {
      request = { input: String(input), init };
      return new Response(JSON.stringify({ id: "ada" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const bot = await resolveNeedsYouCard("ada", "card/43", "event-43", "skip");
      assert.equal(bot.id, "ada");
      assert.equal(request?.input, "/api/bots/ada/cards/card%2F43/needs-you");
      assert.equal(request?.init?.method, "POST");
      assert.equal(request?.init?.credentials, "same-origin");
      assert.equal(request?.init?.headers && (request.init.headers as Record<string, string>)["content-type"], "application/json");
      assert.deepEqual(JSON.parse(String(request?.init?.body)), {
        eventId: "event-43",
        resolution: "skip",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps Talk's truthful retry failure instead of pretending the Card resolved", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "The Bot could not receive your response" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
    try {
      await assert.rejects(
        () => resolveNeedsYouCard("ada", "card-43", "event-43", "done"),
        /The Bot could not receive your response/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Waiting for you wins immediately, then yields to unread when the event clears", () => {
    const base = {
      id: "ada",
      name: "Ada",
      eyes: { color: "#ff3b5c", shape: "capsule", mode: "write" },
      write: true,
      permission: null,
      activity: activity(true),
    };
    const waiting = buildChatInbox({
      bots: [{
        ...base,
        needsYou: {
          reason: "computer-help" as const,
          hint: "Finish the visual step on the Bot's Computer, then choose I'm done.",
          eventId: "event-43",
          cardId: "card-43",
        },
      }],
      channels: [],
      drafts: {},
    })[0];
    assert.equal(waiting?.signal, "waiting");

    const cleared = buildChatInbox({
      bots: [{ ...base, needsYou: null }],
      channels: [],
      drafts: {},
    })[0];
    assert.equal(cleared?.signal, "unread");
  });
});
