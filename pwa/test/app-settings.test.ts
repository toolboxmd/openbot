import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { APP_SETTINGS_INSTRUCTIONS_OWNER } from "../src/lib/app-settings.ts";
import { createLatestRequestScope } from "../src/lib/async-state.ts";
import {
  acceptBotInstructions,
  beginBotInstructions,
  editBotInstruction,
} from "../src/lib/bot-settings.ts";
import {
  getAllBotsAgents,
  getAppSettings,
  putAllBotsAgents,
  updateAppSettings,
} from "../src/lib/session.ts";

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function runPwaRender(script: string): string {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, TSX_TSCONFIG_PATH: resolve("pwa/tsconfig.json") },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function probeReadyContent({
  harnesses = [],
  harnessesState = "ready",
}: {
  harnesses?: Array<{ id: string; name: string; bin: string; talk: boolean }>;
  harnessesState?: "loading" | "ready" | "error";
} = {}) {
  return JSON.parse(runPwaRender(`
    import React from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { AppSettingsContent } from "./pwa/src/components/AppSettings.tsx";

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

    const actions = [];
    const content = AppSettingsContent({
      theme: "system",
      effectiveTheme: "light",
      defaults: {
        status: "ready",
        values: { defaultConnection: "codex", defaultConfigMode: "host" },
      },
      instructions: {
        botId: "app-settings",
        status: "ready",
        drafts: { all: "Shared Workspace rules", bot: "" },
        saved: { all: "Prior Workspace rules", bot: "" },
      },
      harnesses: ${JSON.stringify(harnesses)},
      harnessesState: ${JSON.stringify(harnessesState)},
      saving: null,
      lockPending: false,
      onThemeChange(value) { actions.push(["theme", value]); },
      onDefaultConnectionChange(value) { actions.push(["connection", value]); },
      onDefaultConfigModeChange(value) { actions.push(["config", value]); },
      onInstructionChange(value) { actions.push(["instructions", value]); },
      onSaveInstructions() { actions.push(["save-instructions"]); },
      onRetryDefaults() { actions.push(["retry-defaults"]); },
      onRetryInstructions() { actions.push(["retry-instructions"]); },
      onRetryHarnesses() { actions.push(["retry-harnesses"]); },
      onLock() { actions.push(["lock"]); },
    });
    const connection = collect(content, (node) => node.props.id === "default-connection")[0];
    const config = collect(content, (node) => node.props.id === "default-config-mode")[0];
    const editor = collect(content, (node) => node.props.id === "app-all-bots-instructions")[0];
    const appearance = collect(content, (node) => node.props["aria-label"] === "Appearance")[0];
    const save = collect(content, (node) =>
      text(node) === "Save All Bots" && typeof node.props.onClick === "function")[0];
    const lock = collect(content, (node) =>
      text(node) === "Lock OpenBot" && typeof node.props.onClick === "function")[0];
    connection.props.onChange({ target: { value: "" } });
    config.props.onChange({ target: { value: "isolated" } });
    editor.props.onChange({ target: { value: "Edited Workspace rules" } });
    appearance.props.onValueChange("dark");
    save.props.onClick();
    lock.props.onClick();

    process.stdout.write(JSON.stringify({
      markup: renderToStaticMarkup(content),
      connection: {
        value: connection.props.value,
        options: collect(connection, (node) => node.type === "option").map((option) => ({
          value: option.props.value,
          disabled: Boolean(option.props.disabled),
          label: text(option),
        })),
      },
      actions,
    }));
  `)) as {
    markup: string;
    connection: {
      value: string;
      options: Array<{ value: string; disabled: boolean; label: string }>;
    };
    actions: Array<[string, string?]>;
  };
}

function probeAppSettingsLifecycle() {
  return JSON.parse(runPwaRender(`
    import React from "react";
    import { AppSettings, AppSettingsContent } from "./pwa/src/components/AppSettings.tsx";

    function deferred() {
      let resolvePromise = () => undefined;
      const promise = new Promise((resolve) => { resolvePromise = resolve; });
      return { promise, resolve: resolvePromise };
    }
    function json(body, status = 200) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    function sameDeps(left, right) {
      return left && right && left.length === right.length
        && left.every((value, index) => Object.is(value, right[index]));
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
    function text(node) {
      if (typeof node === "string" || typeof node === "number") return String(node);
      if (node == null || typeof node !== "object") return "";
      if (Array.isArray(node)) return node.map(text).join("");
      if (!React.isValidElement(node)) return "";
      return React.Children.toArray(node.props.children).map(text).join("");
    }

    const defaultLoads = [deferred(), deferred(), deferred()];
    const instructionLoads = [deferred(), deferred(), deferred()];
    const instructionSaves = [deferred(), deferred()];
    const saveSignals = [];
    let defaultLoadIndex = 0;
    let instructionLoadIndex = 0;
    let instructionSaveIndex = 0;
    globalThis.fetch = (input, init = {}) => {
      const url = String(input);
      if (url === "/api/app-settings") return defaultLoads[defaultLoadIndex++].promise;
      if (url === "/api/agents" && init.method === "PUT") {
        saveSignals.push(init.signal);
        return instructionSaves[instructionSaveIndex++].promise;
      }
      if (url === "/api/agents") return instructionLoads[instructionLoadIndex++].promise;
      throw new Error("Unexpected request: " + url);
    };

    const location = { hash: "", pathname: "/", search: "", reload() {} };
    globalThis.window = {
      location,
      history: { state: null, replaceState() {} },
      addEventListener() {},
      removeEventListener() {},
      requestAnimationFrame(callback) { callback(); return 1; },
      cancelAnimationFrame() {},
    };

    const onOpenChange = () => undefined;
    function createRunner({ provideHarnesses = true } = {}) {
      const hooks = [];
      let cursor = 0;
      let pending = [];
      const dispatcher = {
        useState(initial) {
          const index = cursor++;
          if (!hooks[index]) {
            hooks[index] = { value: typeof initial === "function" ? initial() : initial };
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
          hooks[index] = { ...previous, deps, create };
          if (changed) pending.push({ index, create, cleanup: previous?.cleanup });
        },
        useContext() {
          return {
            preferences: { theme: "system", computerPaneByBot: {} },
            effectiveTheme: "light",
            updateTheme() { return true; },
            updateComputerPane() { return true; },
          };
        },
      };
      return {
        render(open) {
          cursor = 0;
          pending = [];
          const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
          const previous = internals.H;
          internals.H = dispatcher;
          try {
            const props = {
              open,
              onOpenChange,
            };
            if (provideHarnesses) {
              Object.assign(props, {
                harnesses: [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
                harnessesState: "ready",
                onRetryHarnesses() {},
              });
            }
            return AppSettings(props);
          } finally {
            internals.H = previous;
          }
        },
        flush() {
          const effects = pending;
          pending = [];
          for (const effect of effects) {
            effect.cleanup?.();
            const cleanup = effect.create();
            hooks[effect.index].cleanup = cleanup;
          }
        },
      };
    }
    function contentProps(tree) {
      const content = collect(tree, (node) => node.type === AppSettingsContent)[0];
      if (!content) throw new Error("App Settings content not found");
      return content.props;
    }
    async function settle() {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const runner = createRunner();
    runner.render(true);
    runner.flush();
    runner.render(false);
    runner.flush();
    runner.render(true);
    runner.flush();

    defaultLoads[1].resolve(json({ defaultConnection: "codex", defaultConfigMode: "host" }));
    instructionLoads[1].resolve(json({ text: "Current Workspace rules" }));
    await settle();
    let tree = runner.render(true);
    const current = contentProps(tree);

    defaultLoads[0].resolve(json({ defaultConnection: null, defaultConfigMode: "isolated" }));
    instructionLoads[0].resolve(json({ text: "Stale Workspace rules" }));
    await settle();
    tree = runner.render(true);
    const afterStale = contentProps(tree);

    afterStale.onInstructionChange("Pending save draft");
    tree = runner.render(true);
    contentProps(tree).onSaveInstructions();
    tree = runner.render(true);
    const savePending = contentProps(tree).saving;

    runner.render(false);
    runner.flush();
    tree = runner.render(false);
    const afterClose = contentProps(tree);

    runner.render(true);
    runner.flush();
    defaultLoads[2].resolve(json({ defaultConnection: "codex", defaultConfigMode: "host" }));
    instructionLoads[2].resolve(json({ text: "Reopened Workspace rules" }));
    await settle();
    tree = runner.render(true);
    const reopened = contentProps(tree);

    reopened.onInstructionChange("Unsaved Workspace draft");
    tree = runner.render(true);
    contentProps(tree).onSaveInstructions();
    instructionSaves[1].resolve(json({ error: "write failed" }, 500));
    await settle();
    tree = runner.render(true);
    const afterFailure = contentProps(tree);

    let standaloneHarnessRequests = 0;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url === "/api/app-settings") {
        return json({ defaultConnection: "codex", defaultConfigMode: "host" });
      }
      if (url === "/api/agents" && init.method !== "PUT") {
        return json({ text: "Standalone Workspace rules" });
      }
      if (url === "/api/harnesses") {
        standaloneHarnessRequests += 1;
        return json({ harnesses: [{ id: "codex", name: "Codex", bin: "codex", talk: true }] });
      }
      throw new Error("Unexpected standalone request: " + url);
    };
    const standaloneRunner = createRunner({ provideHarnesses: false });
    standaloneRunner.render(true);
    standaloneRunner.flush();
    await settle();
    const standalone = contentProps(standaloneRunner.render(true));

    globalThis.fetch = () => new Promise(() => undefined);
    function focusProbe(hash) {
      location.hash = hash;
      const focusRunner = createRunner();
      const focusTree = focusRunner.render(true);
      const props = contentProps(focusTree);
      const targets = {
        newBots: {
          scrolled: 0,
          focused: 0,
          scrollIntoView() { this.scrolled += 1; },
          focus() { this.focused += 1; },
        },
        allBotsInstructions: {
          scrolled: 0,
          focused: 0,
          scrollIntoView() { this.scrolled += 1; },
          focus() { this.focused += 1; },
        },
        security: {
          scrolled: 0,
          focused: 0,
          scrollIntoView() { this.scrolled += 1; },
          focus() { this.focused += 1; },
        },
      };
      props.newBotsSectionRef.current = targets.newBots;
      props.allBotsInstructionsSectionRef.current = targets.allBotsInstructions;
      props.securitySectionRef.current = targets.security;
      focusRunner.flush();
      return targets;
    }

    process.stdout.write(JSON.stringify({
      current: {
        defaults: current.defaults,
        instructions: current.instructions,
      },
      afterStale: {
        defaults: afterStale.defaults,
        instructions: afterStale.instructions,
      },
      savePending,
      pendingSaveAbortedOnClose: saveSignals[0]?.aborted === true,
      afterCloseSaving: afterClose.saving,
      reopened: {
        saving: reopened.saving,
        defaults: reopened.defaults,
        instructions: reopened.instructions,
      },
      afterFailure: {
        saving: afterFailure.saving,
        instructions: afterFailure.instructions,
        feedbackText: text(tree),
      },
      standaloneHarness: {
        requests: standaloneHarnessRequests,
        state: standalone.harnessesState,
        harnesses: standalone.harnesses,
      },
      focus: {
        appearance: focusProbe("#settings/appearance"),
        newBots: focusProbe("#settings/new-bots"),
        allBotsInstructions: focusProbe("#settings/all-bots-instructions"),
        security: focusProbe("#settings/security"),
      },
    }));
  `)) as {
    current: { defaults: unknown; instructions: unknown };
    afterStale: { defaults: unknown; instructions: unknown };
    savePending: string | null;
    pendingSaveAbortedOnClose: boolean;
    afterCloseSaving: string | null;
    reopened: { saving: string | null; defaults: unknown; instructions: unknown };
    afterFailure: { saving: string | null; instructions: unknown; feedbackText: string };
    standaloneHarness: { requests: number; state: string; harnesses: unknown };
    focus: Record<string, Record<string, { scrolled: number; focused: number }>>;
  };
}

describe("App Settings HTTP client", () => {
  test("loads and patches persisted new-Bot defaults with cancellation", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({
        defaultConnection: "codex",
        defaultConfigMode: "host",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      assert.deepEqual(await getAppSettings(controller.signal), {
        defaultConnection: "codex",
        defaultConfigMode: "host",
      });
      assert.deepEqual(
        await updateAppSettings({ defaultConnection: null }, controller.signal),
        { defaultConnection: "codex", defaultConfigMode: "host" },
      );
      assert.deepEqual(requests, [
        {
          input: "/api/app-settings",
          init: { credentials: "same-origin", signal: controller.signal },
        },
        {
          input: "/api/app-settings",
          init: {
            method: "PATCH",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ defaultConnection: null }),
            signal: controller.signal,
          },
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses the canonical Workspace instruction endpoint for load and save", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({ text: "Canonical Workspace rules" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      assert.equal(await getAllBotsAgents(), "Canonical Workspace rules");
      assert.equal(await putAllBotsAgents("Edited Workspace rules"), "Canonical Workspace rules");
      assert.deepEqual(requests, [
        {
          input: "/api/agents",
          init: { credentials: "same-origin", signal: undefined },
        },
        {
          input: "/api/agents",
          init: {
            method: "PUT",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "Edited Workspace rules" }),
            signal: undefined,
          },
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("App Settings content", () => {
  test("shows canonical instructions and truthful new-Bot defaults without Model promises", () => {
    const probe = probeReadyContent();

    assert.match(probe.markup, />Appearance</);
    assert.match(probe.markup, />New Bots</);
    assert.match(probe.markup, />All Bots instructions</);
    assert.match(probe.markup, /id="settings\/new-bots"/);
    assert.match(probe.markup, /id="settings\/all-bots-instructions"/);
    assert.match(probe.markup, /Shared Workspace rules/);
    assert.match(probe.markup, /created without a Connection while this default is unavailable/);
    assert.match(probe.markup, />Security</);
    assert.match(probe.markup, />Password lock</);
    assert.doesNotMatch(probe.markup, />AI</);
    assert.doesNotMatch(probe.markup, /Model|Fallback/);
    assert.doesNotMatch(probe.markup, />About</);
    assert.equal(probe.connection.value, "codex");
    assert.deepEqual(probe.connection.options, [
      { value: "", disabled: false, label: "No default Connection" },
      { value: "codex", disabled: true, label: "codex (unavailable)" },
    ]);
    assert.deepEqual(probe.actions, [
      ["connection", null],
      ["config", "isolated"],
      ["instructions", "Edited Workspace rules"],
      ["theme", "dark"],
      ["save-instructions"],
      ["lock"],
    ]);
  });

  test("does not expose stale Harness results as selectable after availability refresh fails", () => {
    const probe = probeReadyContent({
      harnesses: [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
      harnessesState: "error",
    });

    assert.match(probe.markup, /Could not check available Connections/);
    assert.equal(probe.connection.value, "codex");
    assert.deepEqual(probe.connection.options, [
      { value: "", disabled: false, label: "No default Connection" },
      { value: "codex", disabled: true, label: "Codex \(availability unknown\)" },
    ]);
  });

  test("drops a stale concurrent reload and keeps a failed-save draft", async () => {
    const loadScope = createLatestRequestScope();
    const first = deferred<string>();
    const current = deferred<string>();
    let instructions = beginBotInstructions(APP_SETTINGS_INSTRUCTIONS_OWNER);
    const callbacks = {
      success(all: string) {
        instructions = acceptBotInstructions(
          instructions,
          APP_SETTINGS_INSTRUCTIONS_OWNER,
          { all, bot: "" },
        );
      },
      failure() {
        assert.fail("reload should not fail");
      },
    };

    const staleLoad = loadScope.run(() => first.promise, callbacks);
    const currentLoad = loadScope.run(() => current.promise, callbacks);
    current.resolve("Current Workspace rules");
    assert.equal(await currentLoad, "success");
    first.resolve("Stale Workspace rules");
    assert.equal(await staleLoad, "stale");

    instructions = editBotInstruction(
      instructions,
      APP_SETTINGS_INSTRUCTIONS_OWNER,
      "all",
      "Unsaved Workspace draft",
    );
    let saveError = "";
    const saveScope = createLatestRequestScope();
    assert.equal(
      await saveScope.run(
        async () => Promise.reject(new Error("Could not save All Bots.")),
        {
          success() {
            assert.fail("save should fail");
          },
          failure(error) {
            saveError = error instanceof Error ? error.message : "failed";
          },
        },
      ),
      "failure",
    );
    assert.equal(saveError, "Could not save All Bots.");
    assert.deepEqual(instructions, {
      botId: APP_SETTINGS_INSTRUCTIONS_OWNER,
      status: "ready",
      drafts: { all: "Unsaved Workspace draft", bot: "" },
      saved: { all: "Current Workspace rules", bot: "" },
    });
  });

  test("owns stale reload, close cancellation, reopen, and save-failure state at the component seam", () => {
    const probe = probeAppSettingsLifecycle();

    assert.deepEqual(probe.current, {
      defaults: {
        status: "ready",
        values: { defaultConnection: "codex", defaultConfigMode: "host" },
      },
      instructions: {
        botId: APP_SETTINGS_INSTRUCTIONS_OWNER,
        status: "ready",
        drafts: { all: "Current Workspace rules", bot: "" },
        saved: { all: "Current Workspace rules", bot: "" },
      },
    });
    assert.deepEqual(probe.afterStale, probe.current);
    assert.equal(probe.savePending, "all-bots-instructions");
    assert.equal(probe.pendingSaveAbortedOnClose, true);
    assert.equal(probe.afterCloseSaving, null);
    assert.deepEqual(probe.reopened, {
      saving: null,
      defaults: {
        status: "ready",
        values: { defaultConnection: "codex", defaultConfigMode: "host" },
      },
      instructions: {
        botId: APP_SETTINGS_INSTRUCTIONS_OWNER,
        status: "ready",
        drafts: { all: "Reopened Workspace rules", bot: "" },
        saved: { all: "Reopened Workspace rules", bot: "" },
      },
    });
    assert.deepEqual(probe.afterFailure.instructions, {
      botId: APP_SETTINGS_INSTRUCTIONS_OWNER,
      status: "ready",
      drafts: { all: "Unsaved Workspace draft", bot: "" },
      saved: { all: "Reopened Workspace rules", bot: "" },
    });
    assert.equal(probe.afterFailure.saving, null);
    assert.match(probe.afterFailure.feedbackText, /Instructions not saved/);
    assert.match(probe.afterFailure.feedbackText, /Could not save All Bots/);
    assert.deepEqual(probe.standaloneHarness, {
      requests: 1,
      state: "ready",
      harnesses: [{ id: "codex", name: "Codex", bin: "codex", talk: true }],
    });
    assert.deepEqual(probe.focus, {
      appearance: {
        newBots: { scrolled: 0, focused: 0 },
        allBotsInstructions: { scrolled: 0, focused: 0 },
        security: { scrolled: 0, focused: 0 },
      },
      newBots: {
        newBots: { scrolled: 1, focused: 1 },
        allBotsInstructions: { scrolled: 0, focused: 0 },
        security: { scrolled: 0, focused: 0 },
      },
      allBotsInstructions: {
        newBots: { scrolled: 0, focused: 0 },
        allBotsInstructions: { scrolled: 1, focused: 1 },
        security: { scrolled: 0, focused: 0 },
      },
      security: {
        newBots: { scrolled: 0, focused: 0 },
        allBotsInstructions: { scrolled: 0, focused: 0 },
        security: { scrolled: 1, focused: 1 },
      },
    });
  });
});
