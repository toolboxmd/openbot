import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  botSettingsHash,
  parseBotSettingsHash,
  selectableAiConnections,
} from "../src/lib/bot-settings.ts";

describe("Bot Settings capability gate", () => {
  test("offers only AI connections backed by working Talk behavior", () => {
    assert.deepEqual(
      selectableAiConnections([
        { id: "codex", name: "Codex", bin: "codex", talk: true },
        { id: "claude", name: "Claude Code", bin: "claude", talk: true },
        { id: "grok", name: "Grok Build", bin: "grok", talk: false },
      ]),
      [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
    );
  });

  test("round-trips a Bot and section through the deep-link hash", () => {
    const hash = botSettingsHash("ada/one", "computer-access");
    assert.equal(hash, "#bots/ada%2Fone/settings/computer-access");
    assert.deepEqual(parseBotSettingsHash(hash), {
      botId: "ada/one",
      section: "computer-access",
    });
    assert.equal(parseBotSettingsHash("#bots/ada/settings/billing"), null);
    assert.equal(parseBotSettingsHash("#settings/appearance"), null);
  });
});
