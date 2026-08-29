import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildFlatTranscriptRows,
  isNearTranscriptBottom,
  isPrimaryLongPressPointer,
  LONG_PRESS_DELAY_MS,
  observeTranscriptViewport,
  PHONE_ACTION_TARGET_CLASS,
  remountedTranscriptScrollTop,
  subscribeTranscriptBreakpoint,
  transcriptHasLayout,
  transcriptContentRevision,
  transcriptViewportDecision,
} from "../src/lib/chat-interactions.ts";

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  replyTo?: string;
  receipt?: "sent" | "delivered" | "read";
  reactions?: Array<{ emoji: string; by: "user" }>;
};

describe("flat Chat interactions", () => {
  test("keeps replies in protocol order and resolves a compact target without nesting", () => {
    const parent: Message = { id: "parent", role: "assistant", text: "Original answer" };
    const laterRoot: Message = { id: "later-root", role: "assistant", text: "Later root" };
    const reply: Message = {
      id: "reply",
      role: "user",
      text: "About that",
      replyTo: parent.id,
      receipt: "read",
    };

    const rows = buildFlatTranscriptRows([parent, laterRoot, reply]);

    assert.deepEqual(rows.map((row) => row.message.id), ["parent", "later-root", "reply"]);
    assert.equal(rows[0]?.replyTarget, null);
    assert.equal(rows[2]?.replyTarget?.id, "parent");
    assert.equal(rows[2]?.replyTarget?.text, "Original answer");
  });

  test("leaves an unavailable reply target unresolved without hiding the message", () => {
    const reply: Message = {
      id: "orphan",
      role: "user",
      text: "Still visible",
      replyTo: "missing",
    };

    const rows = buildFlatTranscriptRows([reply]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.message.id, "orphan");
    assert.equal(rows[0]?.replyTarget, null);
  });

  test("revises for new or streaming content but not receipt or reaction metadata", () => {
    const original: Message = {
      id: "one",
      role: "user",
      text: "Hello",
      receipt: "sent",
    };
    const metadataOnly: Message = {
      ...original,
      receipt: "read",
      reactions: [{ emoji: "❤️", by: "user" }],
    };

    assert.equal(transcriptContentRevision([original]), transcriptContentRevision([metadataOnly]));
    assert.notEqual(
      transcriptContentRevision([original]),
      transcriptContentRevision([{ ...original, text: "Hello there" }]),
    );
    assert.notEqual(
      transcriptContentRevision([original]),
      transcriptContentRevision([original, { id: "two", role: "assistant", text: "Hi" }]),
    );
  });

  test("uses a small bottom tolerance for natural scrolling", () => {
    assert.equal(
      isNearTranscriptBottom({ scrollTop: 700, clientHeight: 300, scrollHeight: 1_000 }),
      true,
    );
    assert.equal(
      isNearTranscriptBottom({ scrollTop: 620, clientHeight: 300, scrollHeight: 1_000 }),
      true,
    );
    assert.equal(
      isNearTranscriptBottom({ scrollTop: 619, clientHeight: 300, scrollHeight: 1_000 }),
      false,
    );
  });

  test("reserves long press for a primary touch or pen pointer", () => {
    assert.equal(LONG_PRESS_DELAY_MS, 500);
    assert.equal(isPrimaryLongPressPointer({ pointerType: "touch", button: 0, isPrimary: true }), true);
    assert.equal(isPrimaryLongPressPointer({ pointerType: "pen", button: 0, isPrimary: true }), true);
    assert.equal(isPrimaryLongPressPointer({ pointerType: "mouse", button: 0, isPrimary: true }), false);
    assert.equal(isPrimaryLongPressPointer({ pointerType: "touch", button: 1, isPrimary: true }), false);
    assert.equal(isPrimaryLongPressPointer({ pointerType: "touch", button: 0, isPrimary: false }), false);
  });

  test("does not consume a Chat change before its Transcript mounts", () => {
    const chatA = { botId: "a", revision: "a:1", writing: false, mounted: true };
    const chatB = { botId: "b", revision: "b:1", writing: false };

    const loading = observeTranscriptViewport(chatA, chatB, false);
    assert.deepEqual(loading.snapshot, { ...chatA, mounted: false });

    const mounted = observeTranscriptViewport(loading.snapshot, chatB, true);
    assert.equal(mounted.chatChanged, true);
    assert.equal((mounted as { remounted?: boolean }).remounted, true);
    assert.deepEqual(mounted.snapshot, { ...chatB, mounted: true });
  });

  test("detects a remounted Transcript even when the same Chat revision returns", () => {
    const chatA = { botId: "a", revision: "a:1", writing: false, mounted: true };

    const unmounted = observeTranscriptViewport(chatA, chatA, false);
    const reopened = observeTranscriptViewport(unmounted.snapshot, chatA, true);

    assert.equal((unmounted.snapshot as { mounted?: boolean }).mounted, false);
    assert.equal((reopened as { remounted?: boolean }).remounted, true);
    assert.equal(reopened.chatChanged, false);
  });

  test("does not consume a revision while the phone Chat is CSS-hidden", () => {
    const visible = { botId: "a", revision: "a:1", writing: false, mounted: true };
    const next = { botId: "a", revision: "a:2", writing: false };

    assert.equal(transcriptHasLayout({ getClientRects: () => ({ length: 0 }) }), false);
    const hidden = observeTranscriptViewport(visible, next, false);
    assert.deepEqual(hidden.snapshot, { ...visible, mounted: false });

    assert.equal(transcriptHasLayout({ getClientRects: () => ({ length: 1 }) }), true);
    const returned = observeTranscriptViewport(hidden.snapshot, next, true);
    assert.equal(returned.remounted, true);
    assert.equal(returned.revisionChanged, true);
    assert.deepEqual(returned.snapshot, { ...next, mounted: true });
  });

  test("preserves an away-from-bottom position when the same Chat remounts", () => {
    assert.equal(remountedTranscriptScrollTop({
      chatChanged: false,
      remounted: true,
      nearBottom: false,
      savedScrollTop: 417,
    }), 417);
    assert.equal(remountedTranscriptScrollTop({
      chatChanged: true,
      remounted: true,
      nearBottom: false,
      savedScrollTop: 417,
    }), null);
    assert.equal(remountedTranscriptScrollTop({
      chatChanged: false,
      remounted: true,
      nearBottom: true,
      savedScrollTop: 417,
    }), null);

    assert.deepEqual(transcriptViewportDecision({
      chatChanged: false,
      remounted: true,
      revisionChanged: false,
      writingChanged: false,
      nearBottom: false,
    }), {
      nearBottom: false,
      scrollToBottom: false,
      newMessages: null,
    });

    assert.deepEqual(transcriptViewportDecision({
      chatChanged: false,
      remounted: true,
      revisionChanged: true,
      writingChanged: false,
      nearBottom: false,
    }), {
      nearBottom: false,
      scrollToBottom: false,
      newMessages: true,
    });

    assert.deepEqual(transcriptViewportDecision({
      chatChanged: false,
      remounted: true,
      revisionChanged: true,
      writingChanged: false,
      nearBottom: true,
    }), {
      nearBottom: true,
      scrollToBottom: true,
      newMessages: false,
    });
  });

  test("reconciles breakpoint reflow only when the reader was near the bottom", () => {
    assert.deepEqual(transcriptViewportDecision({
      chatChanged: false,
      remounted: false,
      revisionChanged: false,
      writingChanged: false,
      layoutChanged: true,
      nearBottom: true,
    }), {
      nearBottom: true,
      scrollToBottom: true,
      newMessages: false,
    });
    assert.deepEqual(transcriptViewportDecision({
      chatChanged: false,
      remounted: false,
      revisionChanged: false,
      writingChanged: false,
      layoutChanged: true,
      nearBottom: false,
    }), {
      nearBottom: false,
      scrollToBottom: false,
      newMessages: null,
    });
  });

  test("subscribes the Transcript reconciliation to breakpoint changes", () => {
    let listener: (() => void) | null = null;
    let changes = 0;
    const media = {
      addEventListener(type: string, next: () => void) {
        assert.equal(type, "change");
        listener = next;
      },
      removeEventListener(type: string, next: () => void) {
        assert.equal(type, "change");
        assert.equal(next, listener);
        listener = null;
      },
    };

    const unsubscribe = subscribeTranscriptBreakpoint(media, () => {
      changes += 1;
    });
    assert.ok(listener);
    listener();
    assert.equal(changes, 1);
    unsubscribe();
    assert.equal(listener, null);
  });

  test("phone action controls use the shared minimum touch target", () => {
    assert.match(PHONE_ACTION_TARGET_CLASS, /min-h-\[var\(--touch-min\)\]/);
    assert.match(PHONE_ACTION_TARGET_CLASS, /min-w-\[var\(--touch-min\)\]/);
  });
});
