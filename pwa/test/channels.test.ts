import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  composerSendEnabled,
  groupDisplayTitle,
  isSidebarChannel,
  sidebarGroups,
  type Channel,
} from "../src/lib/channels.ts";

function iso(offsetMs = 0): string {
  return new Date(Date.parse("2026-01-01T00:00:00.000Z") + offsetMs).toISOString();
}

describe("PWA group sidebar helpers", () => {
  test("sidebar lists groups and never bot-to-bot; send is off in a group", () => {
    const channels: Channel[] = [
      {
        id: "g1",
        kind: "group",
        title: "Ada & Bob",
        createdAt: iso(),
        members: [
          { kind: "user", id: "you", name: "You" },
          { kind: "bot", id: "ada", name: "Ada" },
          { kind: "bot", id: "bob", name: "Bob" },
        ],
      },
      {
        id: "hidden",
        kind: "bot-to-bot",
        title: null,
        createdAt: iso(1),
        members: [
          { kind: "bot", id: "ada", name: "Ada" },
          { kind: "bot", id: "bob", name: "Bob" },
        ],
      },
      {
        id: "d1",
        kind: "direct",
        title: null,
        createdAt: iso(2),
        members: [
          { kind: "user", id: "you", name: "You" },
          { kind: "bot", id: "ada", name: "Ada" },
        ],
      },
    ];
    assert.equal(isSidebarChannel("direct"), true);
    assert.equal(isSidebarChannel("group"), true);
    assert.equal(isSidebarChannel("bot-to-bot"), false);
    const groups = sidebarGroups(channels);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.id, "g1");
    assert.equal(
      groups.some((channel) => channel.kind === "bot-to-bot"),
      false,
    );
    assert.equal(groupDisplayTitle(channels[0]!), "Ada & Bob");
    assert.equal(groupDisplayTitle(channels[1]!), "Ada, Bob");
    assert.equal(composerSendEnabled("direct"), true);
    assert.equal(composerSendEnabled("group"), false);
    assert.equal(composerSendEnabled("bot-to-bot"), false);
    assert.equal(composerSendEnabled(null), false);
  });
});
