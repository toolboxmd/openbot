import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildChatChronology,
  formatChatDayLabel,
  orderThreadedChatMessages,
  parseChatText,
  type ChronologyMessage,
} from "../src/lib/chat-chronology";

function message(overrides: Partial<ChronologyMessage> = {}): ChronologyMessage {
  const role = overrides.role ?? "assistant";
  return {
    id: "message",
    role,
    senderId: role === "user" ? "you" : "bot-ada",
    kind: "text",
    createdAt: "2026-08-27T10:00:00.000Z",
    ...overrides,
  };
}

describe("Chat chronology", () => {
  test("keeps protocol messages distinct while deriving burst gaps and final-only tails", () => {
    const messages = [
      message({ id: "a" }),
      message({ id: "b", createdAt: "2026-08-27T10:03:00.000Z" }),
      message({ id: "c", role: "user", receipt: "delivered" }),
      message({ id: "card", role: "user", kind: "host-grant" }),
      message({ id: "d", role: "user" }),
      message({ id: "e", role: "user", replyTo: "a" }),
      message({ id: "f", role: "user" }),
    ];

    const chronology = buildChatChronology(messages, new Date("2026-08-27T18:00:00.000Z"), "en-US");

    assert.deepEqual(chronology.map((item) => item.id), messages.map((item) => item.id));
    assert.deepEqual(chronology.map((item) => item.spacing), [
      "separate",
      "compact",
      "separate",
      "separate",
      "separate",
      "separate",
      "separate",
    ]);
    assert.deepEqual(chronology.map((item) => item.tail), [
      null,
      "incoming",
      "outgoing",
      null,
      "outgoing",
      "outgoing",
      "outgoing",
    ]);
    assert.deepEqual(chronology.map((item) => item.burst), [
      "start",
      "end",
      "only",
      null,
      "only",
      "only",
      "only",
    ]);
  });

  test("speaker, Card, day, and explicit boundaries close bursts", () => {
    const chronology = buildChatChronology([
      message({ id: "incoming" }),
      message({ id: "outgoing", role: "user" }),
      message({ id: "card", role: "user", kind: "host-grant" }),
      message({
        id: "before-midnight",
        role: "assistant",
        createdAt: new Date(2026, 7, 26, 23, 59, 59).toISOString(),
      }),
      message({
        id: "after-midnight",
        role: "assistant",
        createdAt: new Date(2026, 7, 27, 0, 0, 1).toISOString(),
      }),
      message({ id: "explicit", role: "assistant", replyTo: "incoming" }),
    ], new Date("2026-08-27T18:00:00.000Z"), "en-US");

    assert.ok(chronology.every((item) => item.spacing === "separate"));
    assert.deepEqual(chronology.map((item) => item.tail), [
      "incoming",
      "outgoing",
      null,
      "incoming",
      "incoming",
      "incoming",
    ]);
  });

  test("same-role messages from different Channel senders close the visual burst", () => {
    const messages = [
      {
        id: "ada",
        role: "assistant" as const,
        senderId: "bot-ada",
        kind: "text",
        createdAt: "2026-08-27T10:00:00.000Z",
      },
      {
        id: "bob",
        role: "assistant" as const,
        senderId: "bot-bob",
        kind: "text",
        createdAt: "2026-08-27T10:01:00.000Z",
      },
    ];

    const chronology = buildChatChronology(messages);

    assert.deepEqual(chronology.map((item) => item.spacing), ["separate", "separate"]);
    assert.deepEqual(chronology.map((item) => item.burst), ["only", "only"]);
    assert.deepEqual(chronology.map((item) => item.tail), ["incoming", "incoming"]);
  });

  test("labels only the first visible item of each local calendar day", () => {
    const now = new Date(2026, 7, 27, 18, 0, 0);
    const chronology = buildChatChronology([
      message({ id: "today-1", createdAt: new Date(2026, 7, 27, 9, 0, 0).toISOString() }),
      message({ id: "today-2", createdAt: new Date(2026, 7, 27, 10, 0, 0).toISOString() }),
      message({ id: "yesterday", createdAt: new Date(2026, 7, 26, 17, 0, 0).toISOString() }),
      message({ id: "older", createdAt: new Date(2026, 7, 20, 17, 0, 0).toISOString() }),
    ], now, "en-US");

    assert.equal(chronology[0]?.dayLabel, "Today");
    assert.equal(chronology[1]?.dayLabel, null);
    assert.equal(chronology[2]?.dayLabel, "Yesterday");
    assert.equal(chronology[3]?.dayLabel, "Thu, Aug 20");
    assert.equal(formatChatDayLabel("not-a-date", now, "en-US"), null);
  });

  test("shows one real receipt on the latest relevant outgoing bubble", () => {
    const chronology = buildChatChronology([
      message({ id: "old", role: "user", receipt: "read" }),
      message({ id: "answer" }),
      message({ id: "latest", role: "user", receipt: "sent" }),
      message({ id: "incoming" }),
    ]);

    assert.deepEqual(chronology.map((item) => item.receipt), [null, null, "Sent", null]);
  });

  test("derives chronology from the reply-aware visible order", () => {
    const parent = message({ id: "parent", createdAt: new Date(2026, 7, 26, 23, 58).toISOString() });
    const nextRoot = message({ id: "next-root", createdAt: new Date(2026, 7, 27, 0, 2).toISOString() });
    const reply = message({
      id: "reply",
      role: "user",
      replyTo: parent.id,
      createdAt: new Date(2026, 7, 27, 0, 1).toISOString(),
    });

    const ordered = orderThreadedChatMessages([parent, nextRoot, reply]);
    const chronology = buildChatChronology(ordered, new Date(2026, 7, 27, 18), "en-US");

    assert.deepEqual(ordered.map((item) => item.id), ["parent", "reply", "next-root"]);
    assert.deepEqual(chronology.map((item) => item.tail), ["incoming", "outgoing", "incoming"]);
    assert.deepEqual(chronology.map((item) => item.dayLabel), ["Yesterday", "Today", null]);
  });

  test("keeps receipt ownership in protocol order and emits each reordered day once", () => {
    const parent = message({
      id: "parent",
      createdAt: new Date(2026, 7, 25, 10).toISOString(),
    });
    const olderUserRoot = message({
      id: "older-user-root",
      role: "user",
      receipt: "read",
      createdAt: new Date(2026, 7, 27, 9).toISOString(),
    });
    const yesterdayRoot = message({
      id: "yesterday-root",
      createdAt: new Date(2026, 7, 26, 10).toISOString(),
    });
    const latestReply = message({
      id: "latest-reply",
      role: "user",
      receipt: "sent",
      replyTo: parent.id,
      createdAt: new Date(2026, 7, 27, 11).toISOString(),
    });
    const protocolOrder = [parent, yesterdayRoot, olderUserRoot, latestReply];
    const displayOrder = orderThreadedChatMessages(protocolOrder);

    const chronology = buildChatChronology(
      displayOrder,
      new Date(2026, 7, 27, 18),
      "en-US",
      { receiptOrder: protocolOrder },
    );

    assert.deepEqual(displayOrder.map((item) => item.id), [
      "parent",
      "latest-reply",
      "yesterday-root",
      "older-user-root",
    ]);
    assert.deepEqual(chronology.map((item) => item.receipt), [null, "Sent", null, null]);
    assert.deepEqual(chronology.map((item) => item.dayLabel), ["Tue, Aug 25", "Today", "Yesterday", null]);
  });

  test("exposes exact localized time without printing it into the day label", () => {
    const now = new Date(2026, 7, 27, 18, 0, 0);
    const createdAt = new Date(2026, 7, 27, 9, 5, 0).toISOString();
    const [item] = buildChatChronology([message({ createdAt })], now, "en-US");

    assert.equal(item?.dayLabel, "Today");
    assert.equal(item?.exactTime, "9:05 AM");
  });
});

describe("chat-safe text formatting", () => {
  test("recognizes only links, emphasis, and inline code as inline formatting", () => {
    const blocks = parseChatText("Use **bold**, *care*, `npm test`, and https://example.com/docs.");

    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0], {
      kind: "text",
      inlines: [
        { kind: "text", text: "Use " },
        { kind: "strong", text: "bold" },
        { kind: "text", text: ", " },
        { kind: "emphasis", text: "care" },
        { kind: "text", text: ", " },
        { kind: "code", text: "npm test" },
        { kind: "text", text: ", and " },
        { kind: "link", text: "https://example.com/docs", href: "https://example.com/docs" },
        { kind: "text", text: "." },
      ],
    });
  });

  test("renders a short fenced block but leaves long structured output as literal text", () => {
    const short = parseChatText("Run this:\n```sh\nnpm test\n```\nDone.");
    const longBody = Array.from({ length: 41 }, (_, index) => `line ${index}`).join("\n");
    const long = parseChatText(`\`\`\`json\n${longBody}\n\`\`\``);

    assert.deepEqual(short.map((block) => block.kind), ["text", "code-block", "text"]);
    assert.deepEqual(short[1], { kind: "code-block", text: "npm test", language: "sh" });
    assert.equal(long.length, 1);
    assert.equal(long[0]?.kind, "text");
  });

  test("keeps HTML, headings, and tables inert text", () => {
    const [block] = parseChatText("<script>alert(1)</script>\n# Heading\n| a | b |");

    assert.equal(block?.kind, "text");
    assert.equal(block?.inlines?.map((inline) => inline.text).join(""), "<script>alert(1)</script>\n# Heading\n| a | b |");
  });
});
