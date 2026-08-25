import assert from "node:assert/strict";
import { test } from "node:test";
import { isCancelled, shouldStartBubble } from "../src/acp.ts";
import { capTalkBubble, talkPrompt } from "../src/bots.ts";

test("talkPrompt prefixes Talk voice and keeps the user line", () => {
  const prompt = talkPrompt("hey");
  assert.match(prompt, /You are chatting in OpenBot/);
  assert.match(prompt, /several short ACP agent messages/);
  assert.match(prompt, /New message from You:\nhey$/);
  assert.equal(prompt.includes("hey") && !prompt.startsWith("hey"), true);
});

test("capTalkBubble leaves a two-sentence reply alone", () => {
  const text = "Sure — karpathy-wiki is Andrej's notes. Want the short version?";
  assert.equal(capTalkBubble(text), text);
});

test("capTalkBubble truncates an essay and allows a longer fenced code bubble", () => {
  const essay = `${"Heading\n\n".repeat(40)}${"word ".repeat(200)}`;
  const capped = capTalkBubble(essay);
  assert.ok(capped.endsWith("…"));
  assert.ok(capped.length <= 701);
  const code = `\`\`\`ts\n${"const x = 1;\n".repeat(200)}\`\`\``;
  const cappedCode = capTalkBubble(code);
  assert.ok(cappedCode.length <= 2001);
  assert.ok(code.length > 2000 ? cappedCode.endsWith("…") : cappedCode === code);
});

test("isCancelled matches cancel message or code", () => {
  assert.equal(isCancelled(new Error("cancelled")), true);
  assert.equal(isCancelled(Object.assign(new Error("turn cancelled"), { code: -32800 })), true);
  assert.equal(isCancelled(Object.assign(new Error("nope"), { code: "cancelled" })), true);
  assert.equal(isCancelled(new Error("Harness error")), false);
  assert.equal(isCancelled(new Error("ACP child exited")), false);
});

test("shouldStartBubble: missing id never forces a new bubble", () => {
  assert.equal(shouldStartBubble(null, undefined), false);
  assert.equal(shouldStartBubble("item-1", undefined), false);
  assert.equal(shouldStartBubble("item-1", ""), false);
});

test("shouldStartBubble: a present id starts when it differs from the open one", () => {
  assert.equal(shouldStartBubble(null, "item-1"), true);
  assert.equal(shouldStartBubble("item-1", "item-1"), false);
  assert.equal(shouldStartBubble("item-1", "item-2"), true);
});
