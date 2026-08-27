import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  EMPTY_CHAT_SUGGESTIONS,
  botListViewState,
  botNameValidation,
  canSendDirectMessage,
  chatDetailViewState,
  computerToCloseForDirectPluginsReturn,
  computerVisibleDuringPluginsReturn,
  connectedFocusTarget,
  globalRouteFromHash,
  isInternalPluginsEntry,
  pluginsDirectReturnDestination,
  pluginsHistoryState,
  resolvedPluginsReturnTarget,
} from "../src/lib/first-use.ts";

describe("first useful path", () => {
  test("requires a non-empty Bot name and returns the trimmed value", () => {
    assert.deepEqual(botNameValidation("   "), {
      valid: false,
      name: "",
      error: "Enter a name for your Bot.",
    });
    assert.deepEqual(botNameValidation("  Ada  "), {
      valid: true,
      name: "Ada",
      error: null,
    });
  });

  test("recognizes only the honest Plugins destination", () => {
    assert.equal(globalRouteFromHash("#plugins"), "plugins");
    assert.equal(globalRouteFromHash("#marketplace"), "chat");
    assert.equal(globalRouteFromHash("#bots/ada/settings/ai"), "chat");
  });

  test("offers a small stable set of suggestions without sending", () => {
    assert.deepEqual(EMPTY_CHAT_SUGGESTIONS, [
      "Help me plan my next task",
      "Turn my rough notes into a clear draft",
      "Help me think through a decision",
    ]);
  });

  test("keeps send unavailable until the selected Bot has an AI connection", () => {
    assert.equal(canSendDirectMessage({ active: true, harness: null, draft: "Hello", busy: false }), false);
    assert.equal(canSendDirectMessage({ active: true, harness: "codex", draft: "   ", busy: false }), false);
    assert.equal(canSendDirectMessage({ active: true, harness: "codex", draft: "Hello", busy: true }), false);
    assert.equal(canSendDirectMessage({ active: true, harness: "codex", draft: "Hello", busy: false }), true);
  });

  test("shows first launch only after a successful empty Bot list", () => {
    assert.equal(botListViewState({ ready: false, failed: false, count: 0 }), "loading");
    assert.equal(botListViewState({ ready: true, failed: true, count: 0 }), "error");
    assert.equal(botListViewState({ ready: true, failed: false, count: 0 }), "empty");
    assert.equal(botListViewState({ ready: true, failed: false, count: 1 }), "ready");
  });

  test("distinguishes an internally-pushed Plugins entry from a direct link", () => {
    assert.equal(isInternalPluginsEntry(null), false);
    assert.equal(isInternalPluginsEntry({ source: "direct" }), false);
    const state = pluginsHistoryState({ source: "chat" });
    assert.equal(isInternalPluginsEntry(state), true);
    assert.equal(state.source, "chat");
  });

  test("returns direct Plugins links to the Home surface that actually mounted", () => {
    assert.equal(
      pluginsDirectReturnDestination({ ready: false, failed: false, count: 0 }),
      "loading",
    );
    assert.equal(
      pluginsDirectReturnDestination({ ready: true, failed: true, count: 0 }),
      "error",
    );
    assert.equal(
      pluginsDirectReturnDestination({ ready: true, failed: false, count: 0 }),
      "welcome",
    );
    assert.equal(
      pluginsDirectReturnDestination({ ready: true, failed: false, count: 2 }),
      "chat",
    );
  });

  test("falls back when a dialog opener was removed from the Chat", () => {
    const detached = { isConnected: false, name: "setup card" };
    const identity = { isConnected: true, name: "chat identity" };
    const connected = { isConnected: true, name: "settings button" };

    assert.equal(connectedFocusTarget(connected, identity), connected);
    assert.equal(connectedFocusTarget(detached, identity), identity);
    assert.equal(connectedFocusTarget(detached, { ...identity, isConnected: false }), null);
  });

  test("uses the mounted Chat destination after Plugins history loses its origin", () => {
    assert.equal(resolvedPluginsReturnTarget("welcome"), "welcome");
    assert.equal(resolvedPluginsReturnTarget("sidebar"), "sidebar");
    assert.equal(resolvedPluginsReturnTarget("direct"), "direct");
    assert.equal(resolvedPluginsReturnTarget(null), "direct");
  });

  test("closes a remembered Computer when a delayed Bot resolves after Plugins", () => {
    assert.equal(
      computerToCloseForDirectPluginsReturn({
        activeId: null,
        computerOpen: false,
        destination: "loading",
      }),
      null,
    );
    assert.equal(
      computerToCloseForDirectPluginsReturn({
        activeId: "ada",
        computerOpen: true,
        destination: "chat",
      }),
      "ada",
    );
    assert.equal(
      computerToCloseForDirectPluginsReturn({
        activeId: "ada",
        computerOpen: true,
        destination: "error",
      }),
      null,
    );
  });

  test("suppresses a remembered Computer while Plugins is returning to Chat", () => {
    assert.equal(
      computerVisibleDuringPluginsReturn({ computerOpen: true, returnTarget: "direct" }),
      false,
    );
    assert.equal(
      computerVisibleDuringPluginsReturn({ computerOpen: true, returnTarget: "sidebar" }),
      true,
    );
    assert.equal(
      computerVisibleDuringPluginsReturn({ computerOpen: false, returnTarget: "direct" }),
      false,
    );
  });

  test("never treats a Bot summary as a verified empty Chat", () => {
    assert.equal(chatDetailViewState({ messageCount: undefined, failed: false }), "loading");
    assert.equal(chatDetailViewState({ messageCount: undefined, failed: true }), "error");
    assert.equal(chatDetailViewState({ messageCount: 0, failed: false }), "empty");
    assert.equal(chatDetailViewState({ messageCount: 0, failed: true }), "empty");
    assert.equal(chatDetailViewState({ messageCount: 2, failed: false }), "populated");
  });
});
