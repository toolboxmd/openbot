import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  createKeyedRequestScope,
  createLatestRequestScope,
  runWithAuthoritativeRefresh,
} from "../src/lib/async-state.ts";
import {
  answerHostGrant,
  answerPermission,
  getAllBotsAgents,
  getBot,
  getChannel,
  getComputer,
  getThisBotAgents,
  listBots,
  listChannels,
  listHarnesses,
  listInbox,
  pickHarness,
  putAllBotsAgents,
  putThisBotAgents,
  readSession,
  setConfigMode,
  unlock,
} from "../src/lib/session.ts";

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const botSettingsSource = readFileSync(
  new URL("../src/components/BotSettings.tsx", import.meta.url),
  "utf8",
);
const computerSource = readFileSync(
  new URL("../src/components/Computer.tsx", import.meta.url),
  "utf8",
);
const messengerSource = readFileSync(
  new URL("../src/components/Messenger.tsx", import.meta.url),
  "utf8",
);
const passwordSource = readFileSync(
  new URL("../src/components/PasswordGate.tsx", import.meta.url),
  "utf8",
);

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("PWA session request failures", () => {
  test("turns a rejected opening request into a retryable failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError("network offline");
    };
    try {
      assert.deepEqual(await readSession(), {
        ok: false,
        error: "Could not open OpenBot. Try again.",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("distinguishes a locked session from an HTTP opening failure", async () => {
    const originalFetch = globalThis.fetch;
    let status = 401;
    globalThis.fetch = async () => new Response(null, { status });
    try {
      assert.deepEqual(await readSession(), { ok: true, unlocked: false });
      status = 503;
      assert.deepEqual(await readSession(), {
        ok: false,
        error: "Could not open OpenBot. Try again.",
      });
      status = 200;
      assert.deepEqual(await readSession(), { ok: true, unlocked: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("turns a rejected Password request into a useful failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError("network offline");
    };
    try {
      assert.deepEqual(await unlock("secret"), {
        ok: false,
        error: "Could not unlock OpenBot. Try again.",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("distinguishes a wrong Password from an HTTP unlock failure", async () => {
    const originalFetch = globalThis.fetch;
    let status = 401;
    globalThis.fetch = async () => new Response(null, { status });
    try {
      assert.deepEqual(await unlock("wrong"), {
        ok: false,
        error: "Wrong Password.",
      });
      status = 503;
      assert.deepEqual(await unlock("secret"), {
        ok: false,
        error: "Could not unlock OpenBot. Try again.",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("forwards cancellation through initial, selection, save, Card, and Computer requests", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const signals: Array<AbortSignal | null | undefined> = [];
    globalThis.fetch = async (input, init) => {
      signals.push(init?.signal);
      const payload = String(input).startsWith("/api/computer") ? { botId: "ada" } : {};
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      await listBots(controller.signal);
      await listChannels(controller.signal);
      await listInbox(controller.signal);
      await listHarnesses(controller.signal);
      await getBot("ada", controller.signal);
      await getChannel("group", controller.signal);
      await getAllBotsAgents(controller.signal);
      await getThisBotAgents("ada", controller.signal);
      await putAllBotsAgents("shared", controller.signal);
      await putThisBotAgents("ada", "private", controller.signal);
      await pickHarness("ada", "codex", controller.signal);
      await setConfigMode("ada", "isolated", controller.signal);
      await answerPermission("ada", "card", "allow", controller.signal);
      await answerHostGrant("ada", "card", "read", "session", controller.signal);
      await getComputer("ada", controller.signal);

      assert.equal(signals.length, 15);
      assert.equal(signals.every((signal) => signal === controller.signal), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("selection-scoped visible state", () => {
  test("keeps the second A selection visible after delayed A to B to A responses reorder", async () => {
    const scope = createLatestRequestScope();
    const firstA = deferred<string>();
    const b = deferred<string>();
    const secondA = deferred<string>();
    const visible = { pending: false, value: "", error: "" };
    const callbacks = {
      pending() {
        visible.pending = true;
        visible.error = "";
      },
      success(value: string) {
        visible.value = value;
      },
      failure(error: unknown) {
        visible.error = error instanceof Error ? error.message : "failed";
      },
      settled() {
        visible.pending = false;
      },
    };

    const oldARequest = scope.run(() => firstA.promise, callbacks);
    const bRequest = scope.run(() => b.promise, callbacks);
    const currentARequest = scope.run(() => secondA.promise, callbacks);

    secondA.resolve("Ada current");
    assert.equal(await currentARequest, "success");
    firstA.resolve("Ada stale");
    b.resolve("Ben stale");
    assert.equal(await oldARequest, "stale");
    assert.equal(await bRequest, "stale");
    assert.deepEqual(visible, { pending: false, value: "Ada current", error: "" });
  });

  test("settles a current rejection and allows a successful retry", async () => {
    const scope = createLatestRequestScope();
    const visible = { pending: false, value: "", error: "" };
    const callbacks = {
      pending() {
        visible.pending = true;
        visible.error = "";
      },
      success(value: string) {
        visible.value = value;
      },
      failure(error: unknown) {
        visible.error = error instanceof Error ? error.message : "failed";
      },
      settled() {
        visible.pending = false;
      },
    };

    assert.equal(
      await scope.run(async () => Promise.reject(new Error("Could not load Ada")), callbacks),
      "failure",
    );
    assert.deepEqual(visible, { pending: false, value: "", error: "Could not load Ada" });

    assert.equal(await scope.run(async () => "Ada recovered", callbacks), "success");
    assert.deepEqual(visible, { pending: false, value: "Ada recovered", error: "" });
  });

  test("aborts stale work without mutating an unmounted view or leaking a rejection", async () => {
    const scope = createLatestRequestScope();
    const callbacks: string[] = [];
    const request = scope.run(
      (signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      {
        pending: () => callbacks.push("pending"),
        success: () => callbacks.push("success"),
        failure: () => callbacks.push("failure"),
        settled: () => callbacks.push("settled"),
      },
    );

    scope.cancel();
    assert.equal(await request, "stale");
    assert.deepEqual(callbacks, ["pending"]);
  });

  test("cannot put an old Bot save result into the newly selected editor", async () => {
    const scope = createLatestRequestScope();
    const adaSave = deferred<string>();
    const benLoad = deferred<string>();
    const visible = { botId: "ada", text: "Ada draft", pending: false };
    const callbacksFor = (botId: string) => ({
      pending() {
        visible.botId = botId;
        visible.text = "";
        visible.pending = true;
      },
      success(text: string) {
        visible.text = text;
      },
      failure() {
        visible.text = "unavailable";
      },
      settled() {
        visible.pending = false;
      },
    });

    const oldSave = scope.run(() => adaSave.promise, callbacksFor("ada"));
    const currentLoad = scope.run(() => benLoad.promise, callbacksFor("ben"));
    benLoad.resolve("Ben instructions");
    assert.equal(await currentLoad, "success");
    adaSave.resolve("Ada saved instructions");
    assert.equal(await oldSave, "stale");
    assert.deepEqual(visible, { botId: "ben", text: "Ben instructions", pending: false });
  });

  test("keeps a transient request failure in UI feedback instead of the Transcript", async () => {
    const scope = createLatestRequestScope();
    const visible = {
      pending: false,
      feedback: "",
      transcript: ["Existing message"],
    };

    await scope.run(
      async () => Promise.reject(new Error("Could not save instructions.")),
      {
        pending: () => {
          visible.pending = true;
          visible.feedback = "";
        },
        success: () => undefined,
        failure: (error) => {
          visible.feedback = error instanceof Error ? error.message : "Request failed";
        },
        settled: () => {
          visible.pending = false;
        },
      },
    );

    assert.deepEqual(visible, {
      pending: false,
      feedback: "Could not save instructions.",
      transcript: ["Existing message"],
    });
  });
});

describe("authoritative action failure refresh", () => {
  test("preserves local failure feedback and returns the refreshed Bot snapshot", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const result = await runWithAuthoritativeRefresh(
      async () => {
        calls.push("action");
        throw new Error("Could not answer permission.");
      },
      async () => {
        calls.push("refresh");
        return { id: "ada", permission: { title: "Still waiting" } };
      },
      controller.signal,
    );

    assert.deepEqual(calls, ["action", "refresh"]);
    assert.equal(result.ok, false);
    if (result.ok) assert.fail("expected action failure");
    assert.match(String(result.error), /Could not answer permission/);
    assert.deepEqual(result.authoritative, {
      id: "ada",
      permission: { title: "Still waiting" },
    });
  });

  test("keeps the action failure when its authoritative refresh also rejects", async () => {
    const controller = new AbortController();
    const result = await runWithAuthoritativeRefresh(
      async () => Promise.reject(new Error("Could not answer Host grant.")),
      async () => Promise.reject(new Error("refresh offline")),
      controller.signal,
    );

    assert.equal(result.ok, false);
    if (result.ok) assert.fail("expected action failure");
    assert.match(String(result.error), /Could not answer Host grant/);
    assert.equal(result.authoritative, null);
  });

  test("does not refresh or expose an error after the action is aborted", async () => {
    const controller = new AbortController();
    let refreshed = false;
    const action = runWithAuthoritativeRefresh(
      (signal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      async () => {
        refreshed = true;
        return { id: "ada" };
      },
      controller.signal,
    );
    controller.abort();

    await assert.rejects(action, { name: "AbortError" });
    assert.equal(refreshed, false);
  });

  test("keeps a newer same-Card action pending when the superseded action settles", async () => {
    const scope = createKeyedRequestScope<string>();
    const firstWork = deferred<string>();
    const secondWork = deferred<string>();
    const visible = { pending: false, feedback: "" };

    async function run(key: string, work: Promise<string>) {
      const identity = scope.begin(key);
      visible.pending = true;
      try {
        await work;
      } catch (error) {
        if (identity.isCurrent()) {
          visible.feedback = error instanceof Error ? error.message : "failed";
        }
      } finally {
        if (identity.finish()) visible.pending = false;
      }
    }

    const first = run("ada:card", firstWork.promise);
    const second = run("ada:card", secondWork.promise);
    firstWork.resolve("stale success");
    await first;
    assert.deepEqual(visible, { pending: true, feedback: "" });

    secondWork.reject(new Error("Permission still needs an answer."));
    await second;
    assert.deepEqual(visible, {
      pending: false,
      feedback: "Permission still needs an answer.",
    });
  });
});

describe("PWA async wiring contract", () => {
  test("keeps session retry local and Password failure accessible", () => {
    const appPendingStart = appSource.indexOf("pending() {");
    const appPendingEnd = appSource.indexOf("success(result)", appPendingStart);
    const appPending = appSource.slice(appPendingStart, appPendingEnd);
    assert.match(appPending, /setOpeningPending\(true\)/);
    assert.doesNotMatch(appPending, /setGate\("loading"\)/);
    assert.match(appSource, /disabled=\{openingPending\}/);
    assert.match(appSource, /role="alert"/);

    const passwordSubmitStart = passwordSource.indexOf("async function onSubmit");
    const passwordSubmitEnd = passwordSource.indexOf("return (", passwordSubmitStart);
    const passwordSubmit = passwordSource.slice(passwordSubmitStart, passwordSubmitEnd);
    assert.match(passwordSubmit, /unlock\(password, signal\)/);
    assert.match(passwordSubmit, /settled\(\)[\s\S]*setPending\(false\)/);
    assert.match(passwordSource, /role="alert"/);
  });

  test("scopes editor loads and saves to the mounted Bot", () => {
    assert.match(messengerSource, /<BotSettings[\s\S]*key=\{active\.id\}/);
    assert.match(botSettingsSource, /instructionsRequestRef\.current\.cancel\(\)/);
    assert.match(botSettingsSource, /saveRequestRef\.current\.cancel\(\)/);
    assert.match(botSettingsSource, /getThisBotAgents\(bot\.id, signal\)/);
    assert.match(botSettingsSource, /putThisBotAgents\(bot\.id, instructions\.drafts\.bot, signal\)/);
    assert.match(botSettingsSource, /acceptBotInstructions\(state, bot\.id/);
    assert.match(botSettingsSource, /acceptBotInstructionSave\(state, bot\.id/);
  });

  test("cancels selected-Bot mutations and keeps polling on the current generation", () => {
    const submitStart = messengerSource.indexOf("async function onSubmit");
    const submitEnd = messengerSource.indexOf("async function onCardAction", submitStart);
    const submit = messengerSource.slice(submitStart, submitEnd);
    assert.match(submit, /sendMessage\(botId, text, targetId, controller\.signal\)/);
    assert.match(submit, /isAbortError\(err, controller\.signal\)/);

    const reactionStart = messengerSource.indexOf("async function onReact");
    const reactionEnd = messengerSource.indexOf("function renderDaySeparator", reactionStart);
    const reaction = messengerSource.slice(reactionStart, reactionEnd);
    assert.match(reaction, /toggleReaction\(botId, messageId, emoji, controller\.signal\)/);
    assert.match(reaction, /isAbortError\(err, controller\.signal\)/);

    const pollingStart = messengerSource.indexOf("if (!activeId) return;");
    const pollingEnd = messengerSource.indexOf("async function createOrderedBot", pollingStart);
    const polling = messengerSource.slice(pollingStart, pollingEnd);
    assert.match(polling, /const tick = \(\) => \{[\s\S]*const selectionGeneration = selectionGenerationRef\.current/);
    assert.match(messengerSource, /selectionGenerationRef\.current \+= 1/);
    assert.match(messengerSource, /sendRequestControllerRef\.current\?\.abort\(\)/);
  });

  test("keeps Computer state Bot-scoped and announces pending or failed state", () => {
    assert.match(computerSource, /getComputer\(botId, signal\)/);
    assert.match(computerSource, /loadedBotId === botId \? computer : null/);
    assert.match(computerSource, /role="status"[\s\S]*Opening Computer…/);
    assert.match(computerSource, /role="alert">\{currentError\}/);
    assert.match(computerSource, /onFailure\?\.\("Could not close Computer\. Try again\."\)/);
  });
});
