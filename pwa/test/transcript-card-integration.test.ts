import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { retryMessageInput } from "../src/lib/session";

const source = readFileSync(new URL("../src/components/Messenger.tsx", import.meta.url), "utf8");

describe("Transcript Card integration", () => {
  test("renders typed Cards inside chronology instead of permission panels", () => {
    assert.match(source, /message\.kind === "card" && message\.card/);
    assert.match(source, /<TranscriptCard/);
    assert.doesNotMatch(source, /<HostGrantCard/);
    assert.doesNotMatch(source, /active\.permission\.options\.map/);
  });

  test("routes only stored Card actions through their working Talk or retry seam", () => {
    assert.match(source, /action\.command\.kind === "permission"/);
    assert.match(source, /answerPermission\(botId, messageId, optionId\)/);
    assert.match(source, /action\.command\.kind === "host-grant"/);
    assert.match(source, /answerHostGrant\(botId, messageId, access, duration/);
    assert.match(source, /action\.command\.kind === "retry-message"/);
    assert.match(source, /retryTranscriptCard\(botId, messageId\)/);
  });

  test("retries the original reply relationship instead of creating a root message", () => {
    assert.deepEqual(
      retryMessageInput({ text: "Try again", replyTo: "message-parent" }),
      { text: "Try again", replyTo: "message-parent" },
    );
    assert.deepEqual(retryMessageInput({ text: "Try again" }), { text: "Try again" });
  });

  test("keeps progress local and restores focus from authoritative Card state", () => {
    const start = source.indexOf("async function onCardAction");
    const end = source.indexOf("async function onReact", start);
    const handler = source.slice(start, end);
    assert.match(handler, /setCardPending\(messageId, true\)/);
    assert.match(handler, /setCardPending\(messageId, false\)/);
    assert.doesNotMatch(handler, /setBusy\(/);
    assert.match(source, /busy=\{pendingCardIds\.has\(message\.id\)\}/);
    assert.match(handler, /requestAnimationFrame/);
    assert.match(handler, /messageBubbleRefs\.current\.get\(messageId\)\?\.focus\(\)/);
    assert.match(handler, /getBot\(botId\)/);
    assert.match(source, /<ToastProvider/);
    assert.match(source, /<ToastTitle>Action not completed<\/ToastTitle>/);
    assert.match(source, /<ToastViewport/);
    assert.doesNotMatch(source, /<p className="px-6 pb-2 text-center text-sm text-destructive" role="alert">/);
  });
});
