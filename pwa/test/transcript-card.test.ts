import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const source = readFileSync(new URL("../src/components/TranscriptCard.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("../src/lib/session.ts", import.meta.url), "utf8");

describe("Transcript Card presentation", () => {
  test("uses one structured, tailless Card seam with semantic actions", () => {
    assert.match(source, /data-testid="transcript-card"/);
    assert.match(source, /data-card-kind=\{card\.kind\}/);
    assert.match(source, /aria-labelledby=\{titleId\}/);
    assert.match(source, /card\.title/);
    assert.match(source, /card\.body/);
    assert.match(source, /card\.status\.label/);
    assert.match(source, /role="status"/);
    assert.match(source, /aria-label=\{action\.label\}/);
    assert.match(source, /disabled=\{busy\}/);
    assert.match(source, /min-h-\[var\(--touch-min\)\]/);
    assert.match(source, /focus-visible:ring-2/);
    assert.doesNotMatch(source, /message-bubble|data-tail|speech-tail/);
  });

  test("shows a safe preview and duration choices only for a pending Host grant", () => {
    assert.match(source, /card\.kind === "host-grant"/);
    assert.match(source, /action\.command\.kind === "host-grant"/);
    assert.match(source, /aria-label=\{card\.kind === "host-grant" \? "Requested path"/);
    assert.match(source, /<legend[^>]*>How long<\/legend>/);
    assert.match(source, /HOST_GRANT_DURATIONS\.map/);
    assert.match(source, /<RadioGroup[\s\S]*disabled=\{busy\}/);
    assert.match(source, /card\.actions\.length > 0/);
  });

  test("keeps copy typed rather than accepting ACP payloads", () => {
    assert.match(source, /TranscriptCard as TranscriptCardModel/);
    assert.match(source, /card\.preview/);
    assert.doesNotMatch(source, /toolCall|rawInput|JSON\.stringify|stack|credential/i);
  });

  test("leaves a reusable attachment-free seam for a needs-you Computer Card", () => {
    assert.match(sessionSource, /"permission" \| "host-grant" \| "bot-failure" \| "computer"/);
    assert.doesNotMatch(source, /Attachment|<img|image\/|screenshot/i);
  });
});
