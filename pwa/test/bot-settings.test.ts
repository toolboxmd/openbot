import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import {
  acceptBotInstructionSave,
  acceptBotInstructions,
  beginBotInstructions,
  botSettingsHash,
  editBotInstruction,
  failBotInstructions,
  INITIAL_SELECTED_BOT_PANEL_STATE,
  parseBotSettingsHash,
  reduceSelectedBotPanel,
  resolveSelectedBotPanelLocation,
  selectedBotPanelBlocksChat,
  selectableAiConnections,
  syncSelectedBotPanelLocationAfterBotChange,
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

  test("rejects delayed instruction loads and saves from a stale selected Bot", () => {
    const adaLoading = beginBotInstructions("ada");
    const benLoading = beginBotInstructions("ben");

    assert.equal(
      acceptBotInstructions(benLoading, "ada", { all: "old shared", bot: "old Ada" }),
      benLoading,
    );
    assert.equal(failBotInstructions(benLoading, "ada"), benLoading);

    const benReady = acceptBotInstructions(benLoading, "ben", {
      all: "shared",
      bot: "Ben instructions",
    });
    const benDraft = editBotInstruction(benReady, "ben", "bot", "Ben draft");
    assert.equal(
      acceptBotInstructionSave(benDraft, "ada", "bot", "Ada saved late"),
      benDraft,
    );
    assert.deepEqual(benDraft, {
      botId: "ben",
      status: "ready",
      drafts: { all: "shared", bot: "Ben draft" },
      saved: { all: "shared", bot: "Ben instructions" },
    });

    const benSaved = acceptBotInstructionSave(benDraft, "ben", "bot", "Ben saved");
    assert.deepEqual(benSaved.drafts, { all: "shared", bot: "Ben saved" });
    assert.deepEqual(benSaved.saved, { all: "shared", bot: "Ben saved" });
    assert.equal(adaLoading.botId, "ada");
  });

  test("moves a current instruction failure through a clean retry", () => {
    const loading = beginBotInstructions("ada");
    assert.deepEqual(failBotInstructions(loading, "ada"), {
      ...loading,
      status: "error",
    });
    assert.deepEqual(
      acceptBotInstructions(beginBotInstructions("ada"), "ada", { all: "", bot: "ready" }),
      {
        botId: "ada",
        status: "ready",
        drafts: { all: "", bot: "ready" },
        saved: { all: "", bot: "ready" },
      },
    );
  });

  test("uses one panel transition for deep links, Back, Bot changes, Computer, and plugin exit", () => {
    let state = reduceSelectedBotPanel(INITIAL_SELECTED_BOT_PANEL_STATE, {
      kind: "select-bot",
      botId: "ada",
      rememberedOpen: false,
    });
    state = reduceSelectedBotPanel(state, { kind: "open", botId: "ada", section: "instructions" });
    assert.deepEqual(state, {
      botId: "ada",
      open: true,
      section: "instructions",
      computerExpanded: false,
    });

    state = reduceSelectedBotPanel(state, {
      kind: "select-bot",
      botId: "ben",
      rememberedOpen: false,
    });
    assert.equal(state.botId, "ben");
    assert.equal(state.open, true);
    assert.equal(state.computerExpanded, false);

    state = reduceSelectedBotPanel(state, { kind: "open-computer", botId: "ben" });
    assert.equal(state.computerExpanded, true);
    state = reduceSelectedBotPanel(state, { kind: "close-computer" });
    assert.equal(state.open, true);
    assert.equal(state.computerExpanded, false);

    state = reduceSelectedBotPanel(state, { kind: "close" });
    assert.equal(state.open, false, "Browser Back and explicit close converge here");
    state = reduceSelectedBotPanel(state, { kind: "open", botId: "ben", section: "ai" });
    state = reduceSelectedBotPanel(state, { kind: "clear-selection" });
    assert.deepEqual(state, INITIAL_SELECTED_BOT_PANEL_STATE, "group/plugin exits clear the same owner");
  });

  test("blocks Chat for a phone panel but not a visible desktop sidebar", () => {
    assert.equal(selectedBotPanelBlocksChat({ desktopLayout: true, panelOpen: true }), false);
    assert.equal(selectedBotPanelBlocksChat({ desktopLayout: false, panelOpen: true }), true);
    assert.equal(selectedBotPanelBlocksChat({ desktopLayout: false, panelOpen: false }), false);
  });

  test("carries an open panel route exactly once when an existing Bot is selected", () => {
    const adaPanel = reduceSelectedBotPanel(INITIAL_SELECTED_BOT_PANEL_STATE, {
      kind: "open",
      botId: "ada",
      section: "instructions",
    });
    const benPanel = reduceSelectedBotPanel(adaPanel, {
      kind: "select-bot",
      botId: "ben",
      rememberedOpen: false,
    });
    const replacements: string[] = [];

    syncSelectedBotPanelLocationAfterBotChange({
      currentHash: botSettingsHash("ada", "instructions"),
      selectedBotId: "ben",
      panel: benPanel,
      replaceHash(hash) { replacements.push(hash); },
    });

    assert.deepEqual(replacements, [botSettingsHash("ben", "instructions")]);
  });

  test("carries an open panel route exactly once when a newly-created Bot is selected", () => {
    const adaPanel = reduceSelectedBotPanel(INITIAL_SELECTED_BOT_PANEL_STATE, {
      kind: "open",
      botId: "ada",
      section: "computer-access",
    });
    const newBotPanel = reduceSelectedBotPanel(adaPanel, {
      kind: "select-bot",
      botId: "new-bot",
      rememberedOpen: false,
    });
    const replacements: string[] = [];

    syncSelectedBotPanelLocationAfterBotChange({
      currentHash: botSettingsHash("ada", "computer-access"),
      selectedBotId: "new-bot",
      panel: newBotPanel,
      replaceHash(hash) { replacements.push(hash); },
    });
    syncSelectedBotPanelLocationAfterBotChange({
      currentHash: botSettingsHash("new-bot", "computer-access"),
      selectedBotId: "new-bot",
      panel: newBotPanel,
      replaceHash(hash) { replacements.push(hash); },
    });

    assert.deepEqual(replacements, [botSettingsHash("new-bot", "computer-access")]);
  });
});

const ADA = {
  id: "ada",
  name: "Ada",
  harness: "codex",
  configMode: "host",
  eyes: { color: "#7c3aed", shape: "round", mode: "idle" },
  write: false,
  permission: null,
  needsYou: null,
  activity: {
    latestText: null,
    lastActivityAt: "2026-08-28T00:00:00.000Z",
    unread: false,
    cursor: { sequence: 0, revision: 0 },
  },
};

function runPwaRender(script: string): string {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: resolve("pwa/tsconfig.json"),
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function renderPanel(harnesses = [{ id: "codex", name: "Codex", bin: "codex", talk: true }]) {
  return runPwaRender(`
    import React from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { BotSettings } from "./pwa/src/components/BotSettings.tsx";
    import { TooltipProvider } from "./pwa/src/components/ui/tooltip.tsx";
    const ref = { current: null };
    const panel = React.createElement(BotSettings, {
      bot: ${JSON.stringify(ADA)},
      harnesses: ${JSON.stringify(harnesses)},
      harnessesState: "ready",
      open: true,
      onOpenChange() {},
      openerRef: ref,
      fallbackFocusRef: ref,
      async onBotMutation(_botId, request) { return request(); },
      onRetryHarnesses() {},
      onOpenComputer() {},
      section: "ai",
      onSectionChange() {},
    });
    process.stdout.write(renderToStaticMarkup(React.createElement(TooltipProvider, null, panel)));
  `);
}

function probeHeaderControl() {
  return JSON.parse(runPwaRender(`
    import React from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { SelectedBotPanelControl } from "./pwa/src/components/Messenger.tsx";
    import { TooltipProvider } from "./pwa/src/components/ui/tooltip.tsx";
    function collect(node, matches = []) {
      if (!React.isValidElement(node)) return matches;
      if (node.props["aria-controls"] === "selected-bot-panel") matches.push(node);
      for (const child of React.Children.toArray(node.props.children)) collect(child, matches);
      return matches;
    }
    function hasText(node) {
      if (typeof node === "string" || typeof node === "number") return String(node).trim() !== "";
      if (!React.isValidElement(node)) return false;
      return React.Children.toArray(node.props.children).some(hasText);
    }
    function probe(open) {
      const actions = [];
      const element = SelectedBotPanelControl({
        visibleComputerOpen: open,
        controlRef: { current: null },
        onOpen() { actions.push("open"); },
        onClose() { actions.push("close"); },
      });
      const controls = collect(element);
      const control = controls[0];
      control.props.onClick();
      return {
        count: controls.length,
        label: control.props["aria-label"],
        expanded: control.props["aria-expanded"],
        textChild: hasText(control),
        actions,
        markup: renderToStaticMarkup(React.createElement(TooltipProvider, null, element)),
      };
    }
    process.stdout.write(JSON.stringify({ closed: probe(false), open: probe(true) }));
  `)) as {
    closed: { count: number; label: string; expanded: boolean; textChild: boolean; actions: string[]; markup: string };
    open: { count: number; label: string; expanded: boolean; textChild: boolean; actions: string[]; markup: string };
  };
}

function probeAppSettingsCoordination() {
  return JSON.parse(runPwaRender(`
    import { SelectedBotPanelAppSettings } from "./pwa/src/components/Messenger.tsx";
    function probe(panelOpen) {
      const actions = [];
      const element = SelectedBotPanelAppSettings({
        open: false,
        selectedBotPanelOpen: panelOpen,
        onOpenChange(next) { actions.push(["app-settings", next]); },
        onCloseSelectedBotPanel(options) {
          actions.push(["panel-close", options.restoreFocus]);
        },
      });
      element.props.onOpenChange(true);
      element.props.onOpenChange(false);
      return actions;
    }
    process.stdout.write(JSON.stringify({
      panelOpen: probe(true),
      panelClosed: probe(false),
    }));
  `)) as {
    panelOpen: Array<[string, boolean]>;
    panelClosed: Array<[string, boolean]>;
  };
}

function probeShell() {
  return JSON.parse(runPwaRender(`
    import React from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { MessengerShell } from "./pwa/src/components/MessengerShell.tsx";
    const ref = { current: null };
    function render(desktopLayout, mobileSurface, panel) {
      return renderToStaticMarkup(React.createElement(MessengerShell, {
        sidebar: React.createElement("p", null, "Chats"),
        chat: React.createElement("p", null, "Chat"),
        chatRef: ref,
        computer: panel ? React.createElement("p", null, "Ada panel") : null,
        desktopLayout,
        mobileSurface,
      }));
    }
    process.stdout.write(JSON.stringify({
      desktopOpen: render(true, "chat", true),
      phoneOpen: render(false, "chat", true),
      phoneChat: render(false, "chat", false),
      phoneSidebar: render(false, "sidebar", false),
    }));
  `)) as Record<"desktopOpen" | "phoneOpen" | "phoneChat" | "phoneSidebar", string>;
}

function probeSelectedBotSurface() {
  return JSON.parse(runPwaRender(`
    import React from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { SelectedBotSurface } from "./pwa/src/components/MessengerShell.tsx";
    const panel = React.createElement(
      "label",
      null,
      "This Bot",
      React.createElement("textarea", { value: "unsaved Ada draft", readOnly: true }),
    );
    const computer = React.createElement("p", null, "Interactive Computer");
    function render(computerExpanded) {
      return renderToStaticMarkup(React.createElement(SelectedBotSurface, {
        computerExpanded,
        panel,
        computer,
      }));
    }
    process.stdout.write(JSON.stringify({
      panel: render(false),
      computer: render(true),
      returned: render(false),
    }));
  `)) as Record<"panel" | "computer" | "returned", string>;
}

function probeMessengerPanelActivityAndComputerIdentity() {
  return JSON.parse(runPwaRender(`
    import React from "react";
    import { Messenger, SelectedBotPanelControl } from "./pwa/src/components/Messenger.tsx";
    import { BotSettings } from "./pwa/src/components/BotSettings.tsx";
    import { reduceSelectedBotPanel } from "./pwa/src/lib/bot-settings.ts";

    const ada = ${JSON.stringify({
      ...ADA,
      messages: [],
      activity: { ...ADA.activity, unread: true },
    })};
    const ben = { ...ada, id: "ben", name: "Ben" };
    let fetchCalls = 0;
    globalThis.fetch = () => {
      fetchCalls += 1;
      return new Promise(() => {});
    };

    function collectAllProps(node, predicate, matches = [], seen = new Set()) {
      if (node == null || ["string", "number", "boolean", "function"].includes(typeof node)) {
        return matches;
      }
      if (Array.isArray(node)) {
        for (const child of node) collectAllProps(child, predicate, matches, seen);
        return matches;
      }
      if (typeof node !== "object" || seen.has(node)) return matches;
      seen.add(node);
      if (React.isValidElement(node)) {
        if (predicate(node)) matches.push(node);
        for (const value of Object.values(node.props ?? {})) {
          collectAllProps(value, predicate, matches, seen);
        }
      }
      return matches;
    }

    function collectChildren(node, predicate, matches = [], seen = new Set()) {
      if (node == null || ["string", "number", "boolean"].includes(typeof node)) return matches;
      if (Array.isArray(node)) {
        for (const child of node) collectChildren(child, predicate, matches, seen);
        return matches;
      }
      if (typeof node !== "object" || seen.has(node)) return matches;
      seen.add(node);
      if (React.isValidElement(node)) {
        if (predicate(node)) matches.push(node);
        for (const child of React.Children.toArray(node.props.children)) {
          collectChildren(child, predicate, matches, seen);
        }
      }
      return matches;
    }

    function renderMessenger({
      panel,
      pendingActivity = false,
      frames,
      desktopLayout = true,
      readController = new AbortController(),
    }) {
      const overrides = new Map([
        [5, [ada, ben]],
        [6, true],
        [9, "ready"],
        [10, [{ id: "codex", name: "Codex", bin: "codex", talk: true }]],
        [11, "ready"],
        [12, "ada"],
        [13, ada],
        [16, "chat"],
        [17, "chat"],
        [20, panel],
        [21, pendingActivity],
        [22, pendingActivity ? "visible send error" : null],
        [28, desktopLayout],
      ]);
      const stateWrites = [];
      const preferenceWrites = [];
      const effects = [];
      const refs = [];
      const send = new AbortController();
      const reaction = new AbortController();
      const read = readController;
      let cardIdentity = null;
      let stateIndex = 0;
      let refIndex = 0;
      const location = { hash: "", pathname: "/", search: "" };
      globalThis.window = {
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        location,
        history: {
          state: null,
          pushState(_state, _title, url) {
            location.hash = String(url).includes("#") ? "#" + String(url).split("#")[1] : "";
          },
          replaceState() {},
        },
        matchMedia() {
          return { matches: desktopLayout, addEventListener() {}, removeEventListener() {} };
        },
        requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrame() {},
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        addEventListener() {},
        removeEventListener() {},
      };
      globalThis.document = {
        visibilityState: "visible",
        activeElement: null,
        body: {},
        getElementById() { return null; },
      };

      const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      const previous = internals.H;
      internals.H = {
        useState(initial) {
          const index = ++stateIndex;
          let value = overrides.has(index)
            ? overrides.get(index)
            : typeof initial === "function" ? initial() : initial;
          return [value, (next) => {
            value = typeof next === "function" ? next(value) : next;
            stateWrites.push({ index, value });
          }];
        },
        useRef(initial) {
          const index = ++refIndex;
          const ref = { current: initial };
          if (index === 30) ref.current = "ada";
          if (pendingActivity && index === 52) cardIdentity = initial.begin("pending-card");
          if (pendingActivity && index === 53) ref.current = new Map([["ada", read]]);
          if (pendingActivity && index === 54) ref.current = send;
          if (pendingActivity && index === 55) ref.current = reaction;
          refs[index] = ref;
          return ref;
        },
        useEffect(create, deps) { effects.push({ create, deps }); },
        useLayoutEffect() {},
        useContext() {
          return {
            preferences: { theme: "system", computerPaneByBot: { ada: panel.open } },
            effectiveTheme: "light",
            updateTheme() { return true; },
            updateComputerPane(botId, open) {
              preferenceWrites.push({ botId, open });
              return true;
            },
          };
        },
      };
      let tree;
      try {
        tree = Messenger();
      } finally {
        internals.H = previous;
      }
      return {
        tree,
        refs,
        effects,
        stateWrites,
        preferenceWrites,
        activity: {
          send,
          reaction,
          read,
          get cardIdentity() { return cardIdentity; },
        },
      };
    }

    function renderBotSettings(props) {
      const hooks = [];
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
        useEffect() { cursor++; },
      };
      try {
        return BotSettings(props);
      } finally {
        internals.H = previous;
      }
    }

    function sameDeps(left, right) {
      return left.length === right.length
        && left.every((value, index) => Object.is(value, right[index]));
    }

    function readReceiptEffect(probe) {
      const matches = probe.effects.filter(({ deps }) => Array.isArray(deps)
        && deps[0] === true
        && typeof deps[1] === "boolean"
        && deps[2] === "chat"
        && deps[3] === "chat");
      if (matches.length !== 1) throw new Error("Expected one read effect, found " + matches.length);
      return matches[0];
    }

    function pollingEffect(probe) {
      const matches = probe.effects.filter(({ deps }) => Array.isArray(deps)
        && deps[0] === "ada"
        && typeof deps[1] === "boolean"
        && deps[2] === "chat"
        && deps[3] === "chat");
      if (matches.length !== 1) throw new Error("Expected one polling effect, found " + matches.length);
      return matches[0];
    }

    function runReadLifecycle(previousProbe, nextProbe) {
      const previousRead = readReceiptEffect(previousProbe);
      const nextRead = readReceiptEffect(nextProbe);
      const readReran = !sameDeps(previousRead.deps, nextRead.deps);
      if (readReran) nextRead.create();
      return {
        readReran,
        pollingReran: !sameDeps(
          pollingEffect(previousProbe).deps,
          pollingEffect(nextProbe).deps,
        ),
      };
    }

    const activityFrames = [];
    const activityProbe = renderMessenger({
      panel: { botId: null, open: false, section: "ai", computerExpanded: false },
      pendingActivity: true,
      frames: activityFrames,
    });
    const controlElement = collectAllProps(
      activityProbe.tree,
      (node) => node.type === SelectedBotPanelControl,
    )[0];
    const control = SelectedBotPanelControl(controlElement.props);
    const controlButton = collectChildren(
      control,
      (node) => node.props?.["aria-controls"] === "selected-bot-panel",
    )[0];
    controlButton.props.onClick();

    const desktopOpenProbe = renderMessenger({
      panel: { botId: "ada", open: true, section: "ai", computerExpanded: false },
      pendingActivity: true,
      frames: [],
      desktopLayout: true,
      readController: activityProbe.activity.read,
    });
    const desktopFetchStart = fetchCalls;
    const desktopReadLifecycle = runReadLifecycle(activityProbe, desktopOpenProbe);
    const desktopFetchCalls = fetchCalls - desktopFetchStart;

    const phoneRead = new AbortController();
    const phoneClosedProbe = renderMessenger({
      panel: { botId: null, open: false, section: "ai", computerExpanded: false },
      pendingActivity: true,
      frames: [],
      desktopLayout: false,
      readController: phoneRead,
    });
    const phoneOpenProbe = renderMessenger({
      panel: { botId: "ada", open: true, section: "ai", computerExpanded: false },
      pendingActivity: true,
      frames: [],
      desktopLayout: false,
      readController: phoneRead,
    });
    const phoneFetchStart = fetchCalls;
    const phoneReadLifecycle = runReadLifecycle(phoneClosedProbe, phoneOpenProbe);
    const phoneFetchCalls = fetchCalls - phoneFetchStart;

    const computerFrames = [];
    const computerProbe = renderMessenger({
      panel: { botId: "ada", open: true, section: "instructions", computerExpanded: false },
      frames: computerFrames,
    });
    const settingsElement = collectAllProps(
      computerProbe.tree,
      (node) => node.type === BotSettings,
    )[0];
    const settingsTree = renderBotSettings(settingsElement.props);
    const previewButton = collectChildren(
      settingsTree,
      (node) => node.props?.["aria-label"] === "Open Ada's Computer",
    )[0];
    previewButton.props.onClick();
    computerProbe.refs[60].current = reduceSelectedBotPanel(
      computerProbe.refs[60].current,
      { kind: "select-bot", botId: "ben", rememberedOpen: false },
    );
    computerProbe.refs[30].current = "ben";
    while (computerFrames.length) computerFrames.shift()();

    process.stdout.write(JSON.stringify({
      activity: {
        sendAborted: activityProbe.activity.send.signal.aborted,
        reactionAborted: activityProbe.activity.reaction.signal.aborted,
        readAborted: activityProbe.activity.read.signal.aborted,
        cardAborted: activityProbe.activity.cardIdentity.signal.aborted,
        busyAndErrorWrites: activityProbe.stateWrites.filter(({ index }) => index === 21 || index === 22),
        desktopReadEffectReran: desktopReadLifecycle.readReran,
        desktopPollingEffectReran: desktopReadLifecycle.pollingReran,
        desktopFetchCalls,
        phoneReadAborted: phoneRead.signal.aborted,
        phoneReadEffectReran: phoneReadLifecycle.readReran,
        phonePollingEffectReran: phoneReadLifecycle.pollingReran,
        phoneFetchCalls,
      },
      computer: {
        activeBotId: computerProbe.refs[30].current,
        panel: computerProbe.refs[60].current,
        preferenceWrites: computerProbe.preferenceWrites,
      },
    }));
  `)) as {
    activity: {
      sendAborted: boolean;
      reactionAborted: boolean;
      readAborted: boolean;
      cardAborted: boolean;
      busyAndErrorWrites: Array<{ index: number; value: unknown }>;
      desktopReadEffectReran: boolean;
      desktopPollingEffectReran: boolean;
      desktopFetchCalls: number;
      phoneReadAborted: boolean;
      phoneReadEffectReran: boolean;
      phonePollingEffectReran: boolean;
      phoneFetchCalls: number;
    };
    computer: {
      activeBotId: string;
      panel: {
        botId: string;
        open: boolean;
        section: string;
        computerExpanded: boolean;
      };
      preferenceWrites: Array<{ botId: string; open: boolean }>;
    };
  };
}

function probeBotSettingsViewportFocusAndConnection() {
  return JSON.parse(runPwaRender(`
    import React from "react";
    import { BotSettings, SelectedBotPanelFrame } from "./pwa/src/components/BotSettings.tsx";

    const ada = ${JSON.stringify({ ...ADA, messages: [] })};
    const frames = [];
    const documentState = {
      activeElement: null,
      body: { name: "body" },
      getElementById() { return null; },
    };
    globalThis.document = documentState;
    globalThis.window = {
      requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
      cancelAnimationFrame() {},
    };

    function sameDeps(left, right) {
      return left && right && left.length === right.length
        && left.every((value, index) => Object.is(value, right[index]));
    }

    function createRunner(stateOverrides = new Map()) {
      const hooks = [];
      let cursor = 0;
      let pending = [];
      const dispatcher = {
        useState(initial) {
          const index = cursor++;
          if (!hooks[index]) {
            hooks[index] = {
              value: stateOverrides.has(index)
                ? stateOverrides.get(index)
                : typeof initial === "function" ? initial() : initial,
            };
          }
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
        useEffect(create, deps) {
          const index = cursor++;
          const previous = hooks[index];
          const changed = !previous || !sameDeps(previous.deps, deps);
          hooks[index] = { deps, create };
          if (changed) pending.push({ create });
        },
      };
      return {
        render(props) {
          cursor = 0;
          pending = [];
          const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
          const previous = internals.H;
          internals.H = dispatcher;
          try {
            return BotSettings(props);
          } finally {
            internals.H = previous;
          }
        },
        pending() { return [...pending]; },
        clear() { pending = []; },
      };
    }

    function collect(node, predicate, matches = [], seen = new Set()) {
      if (node == null || ["string", "number", "boolean"].includes(typeof node)) return matches;
      if (Array.isArray(node)) {
        for (const child of node) collect(child, predicate, matches, seen);
        return matches;
      }
      if (typeof node !== "object" || seen.has(node)) return matches;
      seen.add(node);
      if (React.isValidElement(node)) {
        if (predicate(node)) matches.push(node);
        for (const child of React.Children.toArray(node.props.children)) {
          collect(child, predicate, matches, seen);
        }
      }
      return matches;
    }

    function props(overrides = {}) {
      return {
        bot: ada,
        harnesses: [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
        harnessesState: "ready",
        open: true,
        onOpenChange() {},
        async onBotMutation(_botId, request) { return request(); },
        onRetryHarnesses() {},
        onOpenComputer() {},
        computerPreviewVisible: true,
        trapFocus: false,
        section: "instructions",
        onSectionChange() {},
        ...overrides,
      };
    }

    const scrollRunner = createRunner();
    let scrollTree = scrollRunner.render(props());
    let panelFrame = collect(scrollTree, (node) => node.type === SelectedBotPanelFrame)[0];
    const root = SelectedBotPanelFrame(panelFrame.props);
    const viewport = collect(
      panelFrame.props.children,
      (node) => node.props?.["data-testid"] === "selected-bot-panel-scroll",
    )[0];
    const rootTarget = { scrollTop: 111, scrollTo({ top }) { this.scrollTop = top; } };
    const viewportTarget = { scrollTop: 487, scrollTo({ top }) { this.scrollTop = top; } };
    root.props.ref.current = rootTarget;
    if (viewport.props.ref) viewport.props.ref.current = viewportTarget;
    scrollRunner.clear();
    scrollRunner.render(props({ section: "ai" }));
    for (const effect of scrollRunner.pending()) effect.create();
    while (frames.length) frames.shift()();

    const focusRunner = createRunner();
    frames.length = 0;
    let focusTree = focusRunner.render(props({ section: "ai", trapFocus: false }));
    const closeButton = collect(
      focusTree,
      (node) => node.props?.["aria-label"] === "Close Bot panel",
    )[0];
    const closeTarget = {
      name: "panel-close",
      focus() { documentState.activeElement = this; },
    };
    closeButton.props.ref.current = closeTarget;
    focusRunner.pending()[1].create();
    while (frames.length) frames.shift()();
    documentState.activeElement = { name: "chat" };
    frames.length = 0;
    focusTree = focusRunner.render(props({ section: "ai", trapFocus: true }));
    for (const effect of focusRunner.pending()) effect.create();
    while (frames.length) frames.shift()();
    const phoneFrame = collect(focusTree, (node) => node.type === SelectedBotPanelFrame)[0];
    const focusAfterPhoneBreakpoint = documentState.activeElement?.name;

    const preserveFocusRunner = createRunner();
    frames.length = 0;
    let preserveFocusTree = preserveFocusRunner.render(props({ section: "ai", trapFocus: false }));
    const preserveFocusFrame = collect(
      preserveFocusTree,
      (node) => node.type === SelectedBotPanelFrame,
    )[0];
    const preserveCloseButton = collect(
      preserveFocusTree,
      (node) => node.props?.["aria-label"] === "Close Bot panel",
    )[0];
    const panelEditor = { name: "panel-editor" };
    preserveFocusFrame.props.contentRef.current = {
      contains(element) { return element === panelEditor; },
    };
    preserveCloseButton.props.ref.current = closeTarget;
    documentState.activeElement = panelEditor;
    preserveFocusRunner.pending()[1].create();
    while (frames.length) frames.shift()();
    frames.length = 0;
    preserveFocusTree = preserveFocusRunner.render(props({ section: "ai", trapFocus: true }));
    for (const effect of preserveFocusRunner.pending()) effect.create();
    while (frames.length) frames.shift()();

    const connectionRunner = createRunner();
    const connectionTree = connectionRunner.render(props({
      bot: { ...ada, harness: "claude" },
      section: "ai",
      harnesses: [
        { id: "codex", name: "Codex", bin: "codex", talk: true },
        { id: "claude", name: "Claude Code", bin: "claude", talk: true },
      ],
    }));
    const select = collect(connectionTree, (node) => node.props?.id === "bot-connection")[0];
    const options = collect(select, (node) => node.type === "option").map((node) => ({
      value: node.props.value,
      disabled: Boolean(node.props.disabled),
      label: React.Children.toArray(node.props.children).join(""),
    }));

    const feedbackRunner = createRunner(new Map([[
      4,
      {
        id: 1,
        title: "Setting not saved",
        description: "Could not save the Connection.",
        error: true,
      },
    ]]));
    const hiddenFeedbackTree = feedbackRunner.render(props({ computerPreviewVisible: false }));
    const returnedFeedbackTree = feedbackRunner.render(props({ computerPreviewVisible: true }));
    const feedbackCount = (tree) => collect(
      tree,
      (node) => typeof node.type === "function" && node.type.name === "Toast",
    ).length;

    process.stdout.write(JSON.stringify({
      scroll: {
        rootScrollTop: rootTarget.scrollTop,
        viewportScrollTop: viewportTarget.scrollTop,
        viewportOwnsRef: Boolean(viewport.props.ref),
      },
      focus: {
        trapFocus: phoneFrame.props.trapFocus,
        activeElement: focusAfterPhoneBreakpoint,
        preservedActiveElement: documentState.activeElement?.name,
      },
      connection: {
        value: select.props.value,
        options,
      },
      feedback: {
        whileComputerOpen: feedbackCount(hiddenFeedbackTree),
        afterPanelReturn: feedbackCount(returnedFeedbackTree),
      },
    }));
  `)) as {
    scroll: { rootScrollTop: number; viewportScrollTop: number; viewportOwnsRef: boolean };
    focus: { trapFocus: boolean; activeElement: string; preservedActiveElement: string };
    connection: {
      value: string;
      options: Array<{ value: string; disabled: boolean; label: string }>;
    };
    feedback: { whileComputerOpen: number; afterPanelReturn: number };
  };
}

function probePhoneFocusHandling() {
  return JSON.parse(runPwaRender(`
    import React from "react";
    import { SelectedBotPanelFrame } from "./pwa/src/components/BotSettings.tsx";
    function run({ key, shiftKey = false, targetIndex = 0, trapFocus = true, interactionSuspended = false }) {
      const actions = [];
      const focusables = [0, 1, 2].map((index) => ({
        focus() { actions.push(["focus", index]); },
        closest() { return null; },
      }));
      const element = SelectedBotPanelFrame({
        contentRef: { current: null },
        trapFocus,
        interactionSuspended,
        onClose() { actions.push(["close"]); },
        children: React.createElement("p", null, "Panel"),
      });
      element.props.onKeyDown({
        key,
        shiftKey,
        target: focusables[targetIndex],
        currentTarget: {
          focus() { actions.push(["focus", "panel"]); },
          querySelectorAll() { return focusables; },
        },
        preventDefault() { actions.push(["prevent"]); },
        stopPropagation() { actions.push(["stop"]); },
      });
      return actions;
    }
    process.stdout.write(JSON.stringify({
      escape: run({ key: "Escape" }),
      forwardWrap: run({ key: "Tab", targetIndex: 2 }),
      backwardWrap: run({ key: "Tab", shiftKey: true, targetIndex: 0 }),
      middle: run({ key: "Tab", targetIndex: 1 }),
      desktop: run({ key: "Tab", targetIndex: 2, trapFocus: false }),
      expandedEscape: run({ key: "Escape", interactionSuspended: true }),
      expandedTab: run({ key: "Tab", targetIndex: 2, interactionSuspended: true }),
    }));
  `)) as Record<string, Array<[string, (number | string)?]>>;
}

function probeInstructionEditors() {
  return JSON.parse(runPwaRender(`
    import React from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { InstructionEditors } from "./pwa/src/components/BotSettings.tsx";
    import { TooltipProvider } from "./pwa/src/components/ui/tooltip.tsx";
    const ready = {
      botId: "ada",
      status: "ready",
      drafts: { all: "Shared draft", bot: "Ada draft" },
      saved: { all: "Shared saved", bot: "Ada saved" },
    };
    function collect(node, predicate, matches = []) {
      if (!React.isValidElement(node)) return matches;
      if (predicate(node)) matches.push(node);
      for (const child of React.Children.toArray(node.props.children)) collect(child, predicate, matches);
      return matches;
    }
    function text(node) {
      if (typeof node === "string" || typeof node === "number") return String(node);
      if (!React.isValidElement(node)) return "";
      return React.Children.toArray(node.props.children).map(text).join("");
    }
    function render(element) {
      return renderToStaticMarkup(React.createElement(TooltipProvider, null, element));
    }
    const actions = [];
    const expandButtonRefs = {
      all: { current: { isConnected: true, focus() { actions.push(["focus", "all"]); } } },
      bot: { current: { isConnected: true, focus() { actions.push(["focus", "bot"]); } } },
    };
    const props = {
      bot: { id: "ada", name: "Ada" },
      instructions: ready,
      savingScope: null,
      expanded: null,
      expandButtonRefs,
      onDraftChange(scope, value) { actions.push(["draft", scope, value]); },
      onSave(scope) { actions.push(["save", scope]); },
      onRetry() { actions.push(["retry"]); },
      onExpandedChange(scope) { actions.push(["expand", scope]); },
    };
    const compact = InstructionEditors(props);
    const compactTextareas = collect(compact, (node) =>
      node.props.id === "all-bots-instructions" || node.props.id === "this-bot-instructions");
    for (const textarea of compactTextareas) textarea.props.onChange({ target: { value: "edited" } });
    const expandButtons = collect(compact, (node) =>
      typeof node.props["aria-label"] === "string" && node.props["aria-label"].startsWith("Expand "));
    for (const button of expandButtons) button.props.onClick();
    const saveButtons = collect(compact, (node) =>
      text(node) === "Save All Bots" || text(node) === "Save This Bot");
    for (const button of saveButtons) button.props.onClick();

    const expandedAll = InstructionEditors({ ...props, expanded: "all" });
    const expandedAllDialog = collect(expandedAll, (node) => node.props.open === true)[0];
    const expandedAllContent = collect(expandedAll, (node) =>
      node.props["aria-describedby"] === "all-bots-instructions-expanded-description")[0];
    // An ordinary close runs the controlled close and Radix close-autofocus lifecycle.
    expandedAllDialog.props.onOpenChange(false);
    expandedAllContent.props.onCloseAutoFocus({
      preventDefault() { actions.push(["prevent-focus", "all"]); },
    });

    const expanded = InstructionEditors({ ...props, expanded: "bot" });
    const expandedEditor = collect(expanded, (node) => node.props.id === "this-bot-instructions-expanded")[0];
    const expandedDialog = collect(expanded, (node) => node.props.open === true)[0];
    const expandedContent = collect(expanded, (node) =>
      node.props["aria-describedby"] === "this-bot-instructions-expanded-description")[0];
    // Escape reaches the same controlled close and close-autofocus lifecycle.
    expandedDialog.props.onOpenChange(false);
    expandedContent.props.onCloseAutoFocus({
      preventDefault() { actions.push(["prevent-focus", "bot"]); },
    });
    const failed = InstructionEditors({
      ...props,
      instructions: { ...ready, status: "error" },
    });
    const retry = collect(failed, (node) => text(node) === "Retry")[0];
    retry.props.onClick();
    const loading = InstructionEditors({
      ...props,
      instructions: { ...ready, status: "loading" },
    });
    process.stdout.write(JSON.stringify({
      compactMarkup: render(compact),
      expandedMarkup: render(expanded),
      expandedValue: expandedEditor.props.value,
      failedMarkup: render(failed),
      loadingMarkup: render(loading),
      actions,
    }));
  `)) as {
    compactMarkup: string;
    expandedMarkup: string;
    expandedValue: string;
    failedMarkup: string;
    loadingMarkup: string;
    actions: Array<[string, string? , string?]>;
  };
}

function surfaceTag(markup: string, testId: string): string | null {
  return markup.match(new RegExp(`<(?:aside|main)[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? null;
}

describe("selected Bot panel", () => {
  test("opening the selected Bot panel preserves in-flight Chat work", () => {
    const probe = probeMessengerPanelActivityAndComputerIdentity();

    assert.equal(probe.activity.sendAborted, false);
    assert.equal(probe.activity.reactionAborted, false);
    assert.equal(probe.activity.readAborted, false);
    assert.equal(probe.activity.cardAborted, false);
    assert.deepEqual(probe.activity.busyAndErrorWrites, []);
    assert.equal(probe.activity.desktopReadEffectReran, false);
    assert.equal(probe.activity.desktopPollingEffectReran, false);
    assert.equal(probe.activity.desktopFetchCalls, 0);
    assert.equal(probe.activity.phoneReadEffectReran, true);
    assert.equal(probe.activity.phonePollingEffectReran, true);
    assert.equal(probe.activity.phoneReadAborted, false);
    assert.equal(probe.activity.phoneFetchCalls, 0);
  });

  test("returns the real viewport to Connection", () => {
    const probe = probeBotSettingsViewportFocusAndConnection();

    assert.equal(probe.scroll.viewportOwnsRef, true);
    assert.equal(probe.scroll.viewportScrollTop, 0);
    assert.equal(probe.scroll.rootScrollTop, 111);
  });

  test("moves focus into a panel when a phone breakpoint activates its focus trap", () => {
    const probe = probeBotSettingsViewportFocusAndConnection();

    assert.equal(probe.focus.trapFocus, true);
    assert.equal(probe.focus.activeElement, "panel-close");
    assert.equal(probe.focus.preservedActiveElement, "panel-editor");
  });

  test("ignores a Computer preview action whose Bot stopped being current before it ran", () => {
    const probe = probeMessengerPanelActivityAndComputerIdentity();

    assert.equal(probe.computer.activeBotId, "ben");
    assert.deepEqual(probe.computer.panel, {
      botId: "ben",
      open: true,
      section: "instructions",
      computerExpanded: false,
    });
    assert.deepEqual(probe.computer.preferenceWrites, []);
  });

  test("shows a persisted unavailable Connection truthfully without making it selectable", () => {
    const probe = probeBotSettingsViewportFocusAndConnection();

    assert.equal(probe.connection.value, "claude");
    assert.deepEqual(probe.connection.options, [
      { value: "", disabled: false, label: "Choose a Connection" },
      { value: "claude", disabled: true, label: "Claude Code (unavailable)" },
      { value: "codex", disabled: false, label: "Codex" },
    ]);
  });

  test("retains save failure feedback until the panel returns from full Computer", () => {
    const probe = probeBotSettingsViewportFocusAndConnection();

    assert.equal(probe.feedback.whileComputerOpen, 0);
    assert.equal(probe.feedback.afterPanelReturn, 1);
  });

  test("uses one icon-only Chat-header control with working open and close actions", () => {
    const probe = probeHeaderControl();

    assert.deepEqual(probe.closed.actions, ["open"]);
    assert.deepEqual(probe.open.actions, ["close"]);
    assert.equal(probe.closed.count, 1);
    assert.equal(probe.open.count, 1);
    assert.equal(probe.closed.label, "Open Bot panel");
    assert.equal(probe.open.label, "Close Bot panel");
    assert.equal(probe.closed.expanded, false);
    assert.equal(probe.open.expanded, true);
    assert.equal(probe.closed.textChild, false);
    assert.equal(probe.open.textChild, false);
    assert.match(probe.closed.markup, /<button/);
    assert.match(probe.closed.markup, /lucide-monitor-cog/);
    assert.doesNotMatch(probe.closed.markup, /lucide-settings/);
    assert.match(probe.open.markup, /<button/);
  });

  test("yields panel and focus ownership when App Settings opens", () => {
    const interaction = probeAppSettingsCoordination();

    assert.deepEqual(interaction.panelOpen, [
      ["panel-close", false],
      ["app-settings", true],
      ["app-settings", false],
    ]);
    assert.deepEqual(interaction.panelClosed, [
      ["app-settings", true],
      ["app-settings", false],
    ]);
  });

  test("closes without focus restoration on direct App Settings navigation", () => {
    let panel = reduceSelectedBotPanel(INITIAL_SELECTED_BOT_PANEL_STATE, {
      kind: "open",
      botId: "ada",
      section: "instructions",
    });
    const appearance = resolveSelectedBotPanelLocation("#settings/appearance");
    assert.deepEqual(appearance, {
      kind: "close",
      restoreFocus: false,
      clearInvalidHash: false,
    });
    panel = reduceSelectedBotPanel(panel, { kind: appearance.kind });
    assert.equal(panel.open, false);

    assert.deepEqual(resolveSelectedBotPanelLocation("#settings/security"), appearance);
    assert.deepEqual(resolveSelectedBotPanelLocation(""), {
      kind: "close",
      restoreFocus: true,
      clearInvalidHash: false,
    });
    assert.deepEqual(resolveSelectedBotPanelLocation("#bots/ada/settings/unknown"), {
      kind: "close",
      restoreFocus: true,
      clearInvalidHash: true,
    });
  });

  test("keeps Chat beside the desktop panel and makes the panel the only phone surface", () => {
    const probe = probeShell();

    assert.doesNotMatch(surfaceTag(probe.desktopOpen, "sidebar-region") ?? "", / hidden/);
    assert.doesNotMatch(surfaceTag(probe.desktopOpen, "chat-region") ?? "", / hidden/);
    assert.doesNotMatch(surfaceTag(probe.desktopOpen, "selected-bot-region") ?? "", / hidden/);

    assert.match(surfaceTag(probe.phoneOpen, "sidebar-region") ?? "", / hidden/);
    assert.match(surfaceTag(probe.phoneOpen, "chat-region") ?? "", / hidden/);
    assert.doesNotMatch(surfaceTag(probe.phoneOpen, "selected-bot-region") ?? "", / hidden/);

    assert.match(surfaceTag(probe.phoneChat, "sidebar-region") ?? "", / hidden/);
    assert.doesNotMatch(surfaceTag(probe.phoneChat, "chat-region") ?? "", / hidden/);
    assert.equal(surfaceTag(probe.phoneChat, "selected-bot-region"), null);

    assert.doesNotMatch(surfaceTag(probe.phoneSidebar, "sidebar-region") ?? "", / hidden/);
    assert.match(surfaceTag(probe.phoneSidebar, "chat-region") ?? "", / hidden/);
  });

  test("keeps unsaved instruction drafts mounted while Computer opens and when the panel returns", () => {
    const probe = probeSelectedBotSurface();

    assert.match(probe.panel, /unsaved Ada draft/);
    assert.doesNotMatch(probe.panel, /Interactive Computer/);
    assert.match(probe.computer, /unsaved Ada draft/);
    assert.match(probe.computer, /data-testid="selected-bot-panel-owner" hidden=""/);
    assert.match(probe.computer, /Interactive Computer/);
    assert.match(probe.returned, /unsaved Ada draft/);
    assert.doesNotMatch(probe.returned, /Interactive Computer/);
  });

  test("traps phone focus, lets desktop Tab flow, and closes safely on Escape", () => {
    const probe = probePhoneFocusHandling();

    assert.deepEqual(probe.escape, [["prevent"], ["stop"], ["close"]]);
    assert.deepEqual(probe.forwardWrap, [["prevent"], ["focus", 0]]);
    assert.deepEqual(probe.backwardWrap, [["prevent"], ["focus", 2]]);
    assert.deepEqual(probe.middle, []);
    assert.deepEqual(probe.desktop, []);
    assert.deepEqual(probe.expandedEscape, []);
    assert.deepEqual(probe.expandedTab, []);
  });

  test("labels the real Harness capability as Connection and exposes no Model fallback", () => {
    const markup = renderPanel();

    assert.match(markup, />Connection</);
    assert.match(markup, />Codex</);
    assert.match(markup, />Host</);
    assert.doesNotMatch(markup, /Model/i);
    assert.doesNotMatch(markup, /fallback/i);
  });

  test("renders an honest capability-absence state without a dead Connection selector", () => {
    const markup = renderPanel([]);

    assert.match(markup, /codex.*\(unavailable\)/);
    assert.match(markup, /No supported Connection is available/);
    assert.doesNotMatch(markup, /<select[^>]+id="bot-connection"/);
    assert.doesNotMatch(markup, /Model/i);
  });

  test("shares canonical drafts and returns expanded-editor focus after close or Escape", () => {
    const probe = probeInstructionEditors();

    assert.match(probe.compactMarkup, /Workspace\/AGENTS\.md/);
    assert.match(probe.compactMarkup, /Workspace\/bots\/ada\/AGENTS\.md/);
    assert.match(probe.compactMarkup, /id="all-bots-instructions"/);
    assert.match(probe.compactMarkup, /id="this-bot-instructions"/);
    assert.match(probe.compactMarkup, /aria-label="Expand All Bots instructions"/);
    assert.match(probe.compactMarkup, /aria-label="Expand This Bot instructions"/);
    assert.equal(probe.expandedValue, "Ada draft");
    assert.match(probe.expandedMarkup, /This Bot instructions/);
    assert.deepEqual(probe.actions, [
      ["draft", "all", "edited"],
      ["draft", "bot", "edited"],
      ["expand", "all"],
      ["expand", "bot"],
      ["save", "all"],
      ["save", "bot"],
      ["expand", null],
      ["prevent-focus", "all"],
      ["focus", "all"],
      ["expand", null],
      ["prevent-focus", "bot"],
      ["focus", "bot"],
      ["retry"],
    ]);
    assert.match(probe.failedMarkup, /Instructions are unavailable/);
    assert.match(probe.failedMarkup, /role="alert"/);
    assert.match(probe.loadingMarkup, /Loading instructions/);
    assert.match(probe.loadingMarkup, /role="status"/);
  });
});
