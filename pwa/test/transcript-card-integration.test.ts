import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

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
    assert.match(source, /action\.command\.kind === "resolve-needs-you"/);
    assert.match(source, /resolveNeedsYouCard\(botId, messageId, eventId, resolution\)/);
  });

  test("routes the Card and Chat header to the same selected Bot Computer", () => {
    assert.match(source, /action\.command\.kind === "open-computer"/);
    assert.match(source, /openComputerFor\(botId\)/);
    assert.match(source, /function openComputer\(\)[\s\S]*openComputerFor\(activeId\)/);
    assert.match(source, /function openComputerFor\(botId: string\)[\s\S]*activeId !== botId[\s\S]*updateComputerPane\(botId, true\)/);
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
    assert.match(handler, /initiatingCard\.contains\(activeElement\)/);
    assert.match(handler, /focusStayedWithCard \|\| focusNeedsRecovery/);
    assert.match(handler, /activeIdRef\.current !== botId/);
    assert.match(handler, /messageBubbleRefs\.current\.get\(messageId\)\?\.focus\(\)/);
    assert.match(handler, /getBot\(botId\)/);
    assert.match(source, /<ToastProvider/);
    assert.match(source, /<ToastTitle>Action not completed<\/ToastTitle>/);
    assert.match(source, /<ToastViewport/);
    assert.doesNotMatch(source, /<p className="px-6 pb-2 text-center text-sm text-destructive" role="alert">/);
  });
});
