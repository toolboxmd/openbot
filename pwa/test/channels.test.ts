import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import {
  composerSendEnabled,
  groupDisplayTitle,
  isSidebarChannel,
  newChannelValidation,
  sidebarGroups,
  type Channel,
} from "../src/lib/channels.ts";
import { createGroupChannel } from "../src/lib/session.ts";

function iso(offsetMs = 0): string {
  return new Date(Date.parse("2026-01-01T00:00:00.000Z") + offsetMs).toISOString();
}

describe("PWA group sidebar helpers", () => {
  test("New Channel requires a trimmed title and two distinct selected Bots", () => {
    assert.deepEqual(newChannelValidation("   ", ["ada", "bob"]), {
      valid: false,
      title: "",
      botIds: ["ada", "bob"],
      titleError: "Enter a title for your Channel.",
      membersError: null,
    });
    assert.deepEqual(newChannelValidation("Launch crew", ["ada", "ada"]), {
      valid: false,
      title: "Launch crew",
      botIds: ["ada"],
      titleError: null,
      membersError: "Choose at least two Bots.",
    });
    assert.deepEqual(newChannelValidation("  Launch crew  ", ["bob", "ada", "bob"]), {
      valid: true,
      title: "Launch crew",
      botIds: ["bob", "ada"],
      titleError: null,
      membersError: null,
    });
  });

  test("sidebar Create exposes exactly New Bot and New Channel through the shared dialog seam", () => {
    const messenger = readFileSync(new URL("../src/components/Messenger.tsx", import.meta.url), "utf8");
    const createMenu = messenger.match(
      /<DropdownMenuContent align="end" aria-label="Create">([\s\S]*?)<\/DropdownMenuContent>/,
    )?.[1];
    assert.ok(createMenu, "sidebar Create menu must exist");
    assert.equal((createMenu.match(/<DropdownMenuItem\b/g) ?? []).length, 2);
    assert.equal((createMenu.match(/New Bot/g) ?? []).length, 1);
    assert.equal((createMenu.match(/New Channel/g) ?? []).length, 1);
    assert.match(messenger, /<NewChannelDialog/);
    assert.match(messenger, /createGroupChannel/);
    assert.match(messenger, /openCreatedGroup/);

  });

  test("New Channel Dialog admits one in-flight submit and preserves selected Bot order", async () => {
    const script = `
      import React from "react";
      import { NewChannelDialog } from "./pwa/src/components/NewChannelDialog.tsx";
      import { StackedEyes } from "./pwa/src/components/StackedEyes.tsx";
      import { Button } from "./pwa/src/components/ui/button.tsx";
      import { Input } from "./pwa/src/components/ui/input.tsx";

      function collect(node, predicate, out = []) {
        if (Array.isArray(node)) {
          for (const child of node) collect(child, predicate, out);
          return out;
        }
        if (!React.isValidElement(node)) return out;
        if (predicate(node)) out.push(node);
        collect(node.props.children, predicate, out);
        return out;
      }

      function text(node) {
        if (typeof node === "string" || typeof node === "number") return String(node);
        if (Array.isArray(node)) return node.map(text).join("");
        if (!React.isValidElement(node)) return "";
        return text(node.props.children);
      }

      const activity = {
        latestText: null,
        lastActivityAt: "2026-01-01T00:00:00.000Z",
        unread: false,
        cursor: { sequence: 0, revision: 0 },
      };
      const bots = [
        {
          id: "ada",
          name: "Ada",
          eyes: { color: "#ff3b5c", shape: "capsule", mode: "idle" },
          write: false,
          permission: null,
          needsYou: null,
          activity,
        },
        {
          id: "bob",
          name: "Bob",
          eyes: { color: "#3b82f6", shape: "sphere", mode: "idle" },
          write: false,
          permission: null,
          needsYou: null,
          activity,
        },
      ];
      const created = {
        id: "launch",
        kind: "group",
        title: "Launch crew",
        createdAt: activity.lastActivityAt,
        members: [
          { kind: "user", id: "you", name: "You" },
          { kind: "bot", id: "bob", name: "Bob" },
          { kind: "bot", id: "ada", name: "Ada" },
        ],
        activity,
      };
      const submitted = [];
      const opened = [];
      const delivered = [];
      const focused = [];
      let closePrevented = 0;
      let settleCreate;
      const pendingCreate = new Promise((resolve) => {
        settleCreate = resolve;
      });
      const hooks = [];

      globalThis.window = {
        requestAnimationFrame(callback) {
          callback();
          return 1;
        },
      };

      function render() {
        let cursor = 0;
        const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
        const previous = internals.H;
        internals.H = {
          useState(initial) {
            const index = cursor++;
            if (!hooks[index]) hooks[index] = { value: typeof initial === "function" ? initial() : initial };
            const slot = hooks[index];
            return [slot.value, (next) => {
              slot.value = typeof next === "function" ? next(slot.value) : next;
            }];
          },
          useRef(initial) {
            const index = cursor++;
            if (!hooks[index]) hooks[index] = { value: { current: initial } };
            return hooks[index].value;
          },
          useEffect() { cursor += 1; },
        };
        try {
          return NewChannelDialog({
            open: true,
            onOpenChange(open) { opened.push(open); },
            openerRef: { current: { focus() { focused.push("opener"); } } },
            destinationRef: { current: { focus() { focused.push("destination"); } } },
            bots,
            async onCreate(input) {
              submitted.push(input);
              return pendingCreate;
            },
            onCreated(channel) { delivered.push(channel.id); },
          });
        } finally {
          internals.H = previous;
        }
      }

      const initial = render();
      const titleInput = collect(initial, (element) => (
        element.type === Input && element.props.id === "new-channel-title"
      ))[0];
      const botButtons = collect(initial, (element) => (
        element.type === Button && typeof element.props["aria-pressed"] === "boolean"
      ));
      const initialCreate = collect(initial, (element) => (
        element.type === Button && text(element).includes("Create Channel")
      ))[0];
      titleInput.props.onChange({ target: { value: "  Launch crew  " } });
      botButtons[1].props.onClick();
      botButtons[0].props.onClick();

      const ready = render();
      const readyCreate = collect(ready, (element) => (
        element.type === Button && text(element).includes("Create Channel")
      ))[0];
      const cancel = collect(ready, (element) => (
        element.type === Button && text(element) === "Cancel"
      ))[0];
      const selectedStack = collect(ready, (element) => (
        element.type === StackedEyes
        && Array.isArray(element.props.faces)
        && element.props.faces.length === 2
      ))[0];
      const form = collect(ready, (element) => element.type === "form")[0];
      const dialog = collect(ready, (element) => (
        element.props.open === true && typeof element.props.onOpenChange === "function"
      ))[0];
      const dialogContent = collect(ready, (element) => (
        element.props["aria-describedby"] === "new-channel-description"
      ))[0];
      const firstSubmit = form.props.onSubmit({ preventDefault() {} });
      const secondSubmit = form.props.onSubmit({ preventDefault() {} });
      const submittedBeforeSettle = [...submitted];
      cancel.props.onClick();
      dialog.props.onOpenChange(false);
      const openedWhilePending = [...opened];
      settleCreate(created);
      await Promise.all([firstSubmit, secondSubmit]);
      dialogContent.props.onCloseAutoFocus({ preventDefault() { closePrevented += 1; } });
      console.log(JSON.stringify({
        initialDisabled: initialCreate.props.disabled,
        botNames: botButtons.map(text),
        readyDisabled: readyCreate.props.disabled,
        selectedNames: selectedStack.props.faces.map((face) => face.name),
        submittedBeforeSettle,
        openedWhilePending,
        submitted,
        delivered,
        opened,
        focused,
        closePrevented,
      }));
    `;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: resolve("."),
        env: { ...process.env, TSX_TSCONFIG_PATH: resolve("pwa/tsconfig.json") },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      initialDisabled: true,
      botNames: ["Ada", "Bob"],
      readyDisabled: false,
      selectedNames: ["Bob", "Ada"],
      submittedBeforeSettle: [{ title: "Launch crew", botIds: ["bob", "ada"] }],
      openedWhilePending: [],
      submitted: [{ title: "Launch crew", botIds: ["bob", "ada"] }],
      delivered: ["launch"],
      opened: [false],
      focused: ["destination"],
      closePrevented: 1,
    });
  });

  test("PWA Channel client posts the required title and selected Bot order", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const channel = {
      id: "launch",
      kind: "group" as const,
      title: "Launch crew",
      createdAt: iso(),
      members: [
        { kind: "user" as const, id: "you", name: "You" },
        { kind: "bot" as const, id: "bob", name: "Bob" },
        { kind: "bot" as const, id: "ada", name: "Ada" },
      ],
      activity: {
        latestText: null,
        lastActivityAt: iso(),
        unread: false,
        cursor: { sequence: 0, revision: 0 },
      },
    };
    globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(channel), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      assert.deepEqual(
        await createGroupChannel({ title: "Launch crew", botIds: ["bob", "ada"] }),
        channel,
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.input, "/api/channels");
      assert.equal(calls[0]?.init?.method, "POST");
      assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
        kind: "group",
        title: "Launch crew",
        botIds: ["bob", "ada"],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

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
    assert.equal(
      groupDisplayTitle({ title: null, members: channels[1]!.members }),
      "Untitled Channel",
      "a corrupt or legacy row must not synthesize its identity from member names",
    );
    assert.equal(composerSendEnabled("direct"), true);
    assert.equal(composerSendEnabled("group"), false);
    assert.equal(composerSendEnabled("bot-to-bot"), false);
    assert.equal(composerSendEnabled(null), false);
  });
});
