import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { describe, test } from "node:test";
import {
  computerCanWrite,
  createComputerOwnershipTransitions,
  getComputer,
  releaseComputerForNavigation,
  setComputerZoom,
  type Computer,
} from "../src/lib/session.ts";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function computer(botId: string, ownership: Computer["ownership"]): Computer {
  const write = ownership === "write";
  return {
    path: `/screen/${botId}/`,
    ready: true,
    botId,
    ownership,
    ownershipEpoch: "test-epoch",
    write: ownership === "unknown" ? null : write,
    viewOnly: ownership === "unknown" ? null : !write,
    zoom: write,
  };
}

type ComponentEffect = () => void | (() => void);

let computerScreenHarnessId = 0;

async function renderComputerScreenHarness(
  fetchImpl: typeof fetch,
  expanded = false,
): Promise<{
  effects: ComponentEffect[];
  intervals: Map<number, () => void>;
  stateValues: unknown[];
  stateUpdates: Array<{ index: number; value: unknown }>;
  restore: () => void;
}> {
  const effects: ComponentEffect[] = [];
  const intervals = new Map<number, () => void>();
  const stateValues: unknown[] = [];
  const stateUpdates: Array<{ index: number; value: unknown }> = [];
  const hookState = globalThis as typeof globalThis & {
    __openbotComputerRenderHooks?: {
      effects: ComponentEffect[];
      stateIndex: number;
      stateUpdates: Array<{ index: number; value: unknown }>;
      stateValues: unknown[];
    };
  };
  hookState.__openbotComputerRenderHooks = {
    effects,
    stateIndex: 0,
    stateUpdates,
    stateValues,
  };
  const harnessId = ++computerScreenHarnessId;
  const moduleUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
  const reactUrl = moduleUrl(`
    // ComputerScreen harness ${harnessId}
    const state = globalThis.__openbotComputerRenderHooks;
    export const useCallback = (callback) => callback;
    export const useEffect = (effect) => { state.effects.push(effect); };
    export const useRef = (value) => ({ current: value });
    export const useState = (initial) => {
      const index = state.stateIndex++;
      if (!(index in state.stateValues)) state.stateValues[index] = initial;
      return [state.stateValues[index], (next) => {
        state.stateValues[index] = typeof next === "function"
          ? next(state.stateValues[index])
          : next;
        state.stateUpdates.push({ index, value: state.stateValues[index] });
      }];
    };
  `);
  const jsxUrl = moduleUrl(`
    export const Fragment = Symbol.for("openbot.test.fragment");
    export const jsx = (type, props) => ({ type, props });
    export const jsxs = jsx;
    export const jsxDEV = jsx;
  `);
  const buttonUrl = moduleUrl("export const Button = () => null;");
  const utilsUrl = moduleUrl("export const cn = (...values) => values.filter(Boolean).join(' ');");
  const iconsUrl = moduleUrl("export const MessageSquare = () => null;");
  const sessionUrl = new URL("../src/lib/session.ts", import.meta.url).href;
  const moduleHooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "react") return { url: reactUrl, shortCircuit: true };
      if (specifier === "react/jsx-runtime" || specifier === "react/jsx-dev-runtime") {
        return { url: jsxUrl, shortCircuit: true };
      }
      if (specifier === "@/lib/session") return { url: sessionUrl, shortCircuit: true };
      if (specifier === "@/components/ui/button") return { url: buttonUrl, shortCircuit: true };
      if (specifier === "@/lib/utils") return { url: utilsUrl, shortCircuit: true };
      if (specifier === "lucide-react") return { url: iconsUrl, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });

  let intervalId = 0;
  const listeners = new Map<string, Set<() => void>>();
  const testWindow = {
    setInterval(callback: () => void) {
      intervalId += 1;
      intervals.set(intervalId, callback);
      return intervalId;
    },
    clearInterval(id: number) {
      intervals.delete(id);
    },
    addEventListener(type: string, listener: () => void) {
      const registered = listeners.get(type) ?? new Set<() => void>();
      registered.add(listener);
      listeners.set(type, registered);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalReact = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", {
    configurable: true,
    value: {
      Fragment: Symbol.for("openbot.test.fragment"),
      createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
        return { type, props: { ...(props ?? {}), children } };
      },
    },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: testWindow });
  globalThis.fetch = fetchImpl;

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    moduleHooks.deregister();
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalReact) Object.defineProperty(globalThis, "React", originalReact);
    else Reflect.deleteProperty(globalThis, "React");
    delete hookState.__openbotComputerRenderHooks;
  };

  try {
    const componentUrl = new URL("../src/components/Computer.tsx", import.meta.url);
    componentUrl.searchParams.set("ownership-harness", String(harnessId));
    const { ComputerScreen } = await import(componentUrl.href) as typeof import(
      "../src/components/Computer.tsx"
    );
    ComputerScreen({ botId: "Ada", expanded, onClose: () => undefined });
    return { effects, intervals, stateValues, stateUpdates, restore };
  } catch (error) {
    restore();
    throw error;
  }
}

describe("Computer ownership PWA client", () => {
  test("serializes Bot switches and keeps the queue usable after a failed transition", async () => {
    const calls: Array<{ botId: string | null; zoom: boolean }> = [];
    const pending: Array<ReturnType<typeof deferred<Computer>>> = [];
    const transition = createComputerOwnershipTransitions((botId, zoom) => {
      calls.push({ botId, zoom });
      const gate = deferred<Computer>();
      pending.push(gate);
      return gate.promise;
    });

    const zoomAda = transition.transition("Ada", true);
    const releaseAda = transition.transition("Ada", false);
    const zoomBen = transition.transition("Ben", true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [{ botId: "Ada", zoom: true }]);

    pending[0].resolve(computer("Ada", "write"));
    await zoomAda;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [
      { botId: "Ada", zoom: true },
      { botId: "Ada", zoom: false },
    ]);

    pending[1].reject(new Error("Kasm disable failed"));
    await assert.rejects(releaseAda, /Kasm disable failed/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [
      { botId: "Ada", zoom: true },
      { botId: "Ada", zoom: false },
      { botId: "Ben", zoom: true },
    ]);

    pending[2].resolve(computer("Ben", "write"));
    assert.equal((await zoomBen).ownership, "write");
  });

  test("dispatches navigation release immediately and cancels an older queued grant", async () => {
    const calls: Array<{
      botId: string | null;
      zoom: boolean;
      options?: {
        keepalive?: boolean;
      };
    }> = [];
    const pending: Array<ReturnType<typeof deferred<Computer>>> = [];
    const transitions = createComputerOwnershipTransitions((botId, zoom, options) => {
      calls.push({ botId, zoom, options });
      const gate = deferred<Computer>();
      pending.push(gate);
      return gate.promise;
    });

    const activeGrant = transitions.transition("Ada", true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);

    const staleQueuedGrant = transitions.transition("Ben", true);
    const staleRejected = assert.rejects(staleQueuedGrant, /superseded by navigation/i);
    const navigationRelease = transitions.releaseForNavigation("Ada");

    assert.equal(calls.length, 2, "navigation release must start before the active request settles");
    assert.equal(calls[1].botId, "Ada");
    assert.equal(calls[1].zoom, false);
    assert.equal(calls[1].options?.keepalive, true);

    pending[0].resolve(computer("Ada", "write"));
    await activeGrant;
    await staleRejected;
    assert.equal(calls.some((call) => call.botId === "Ben" && call.zoom), false);

    pending[1].resolve(computer("Ada", "view-only"));
    assert.equal((await navigationRelease).ownership, "view-only");
  });

  test("cancels a grant when navigation releases during its token preflight", async () => {
    const preflight = deferred<string>();
    const calls: Array<{ botId: string | null; zoom: boolean }> = [];
    const transitions = createComputerOwnershipTransitions(
      async (botId, zoom) => {
        calls.push({ botId, zoom });
        return computer(botId ?? "Ada", zoom ? "write" : "view-only");
      },
      () => preflight.promise,
    );

    const staleGrant = transitions.transition("Ada", true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, []);
    await transitions.releaseForNavigation("Ada");
    assert.deepEqual(calls, [{ botId: "Ada", zoom: false }]);

    preflight.resolve("opaque-preflight-token");
    await assert.rejects(staleGrant, /superseded by navigation/i);
    assert.deepEqual(calls, [{ botId: "Ada", zoom: false }]);
  });

  test("real ComputerScreen dispatches immediate pagehide and cleanup release during preflight", async () => {
    type Effect = () => void | (() => void);
    type Listener = () => void;
    const effects: Effect[] = [];
    const hookState = globalThis as typeof globalThis & {
      __openbotComputerHooks?: { effects: Effect[] };
    };
    hookState.__openbotComputerHooks = { effects };
    const moduleUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
    const reactUrl = moduleUrl(`
      const state = globalThis.__openbotComputerHooks;
      export const useCallback = (callback) => callback;
      export const useEffect = (effect) => { state.effects.push(effect); };
      export const useRef = (value) => ({ current: value });
      export const useState = (value) => [value, () => undefined];
    `);
    const jsxUrl = moduleUrl(`
      export const Fragment = Symbol.for("openbot.test.fragment");
      export const jsx = (type, props) => ({ type, props });
      export const jsxs = jsx;
      export const jsxDEV = jsx;
    `);
    const buttonUrl = moduleUrl("export const Button = () => null;");
    const utilsUrl = moduleUrl("export const cn = (...values) => values.filter(Boolean).join(' ');");
    const iconsUrl = moduleUrl("export const MessageSquare = () => null;");
    const sessionUrl = new URL("../src/lib/session.ts", import.meta.url).href;
    const moduleHooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "react") return { url: reactUrl, shortCircuit: true };
        if (specifier === "react/jsx-runtime" || specifier === "react/jsx-dev-runtime") {
          return { url: jsxUrl, shortCircuit: true };
        }
        if (specifier === "@/lib/session") return { url: sessionUrl, shortCircuit: true };
        if (specifier === "@/components/ui/button") {
          return { url: buttonUrl, shortCircuit: true };
        }
        if (specifier === "@/lib/utils") return { url: utilsUrl, shortCircuit: true };
        if (specifier === "lucide-react") return { url: iconsUrl, shortCircuit: true };
        return nextResolve(specifier, context);
      },
    });

    const listeners = new Map<string, Set<Listener>>();
    const testWindow = {
      addEventListener(type: string, listener: Listener) {
        const registered = listeners.get(type) ?? new Set<Listener>();
        registered.add(listener);
        listeners.set(type, registered);
      },
      removeEventListener(type: string, listener: Listener) {
        listeners.get(type)?.delete(listener);
      },
      dispatch(type: string) {
        for (const listener of listeners.get(type) ?? []) listener();
      },
    };
    const epochPreflight = deferred<Response>();
    const requests: Array<{ method: string; zoom?: boolean; keepalive?: boolean }> = [];
    const originalFetch = globalThis.fetch;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalReact = Object.getOwnPropertyDescriptor(globalThis, "React");
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: {
        Fragment: Symbol.for("openbot.test.fragment"),
        createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
          return { type, props: { ...(props ?? {}), children } };
        },
      },
    });
    Object.defineProperty(globalThis, "window", { configurable: true, value: testWindow });
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        requests.push({ method });
        return epochPreflight.promise;
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { zoom?: boolean };
      requests.push({ method, zoom: body.zoom, keepalive: init?.keepalive });
      return Promise.resolve(new Response(JSON.stringify({
        ...computer("Ada", "view-only"),
        ownershipEpoch: `navigation-release-token-${requests.length}`,
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }) as typeof fetch;

    try {
      const { ComputerScreen } = await import("../src/components/Computer.tsx");
      ComputerScreen({ botId: "Ada", expanded: true, onClose: () => undefined });
      assert.ok(effects.length >= 3);
      const transitionCleanup = effects[1]();
      const navigationCleanup = effects[2]();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(requests, [{ method: "GET" }]);

      testWindow.dispatch("pagehide");
      assert.deepEqual(requests, [
        { method: "GET" },
        { method: "POST", zoom: false, keepalive: true },
      ]);
      epochPreflight.resolve(new Response(JSON.stringify({
        ...computer("Ada", "view-only"),
        ownershipEpoch: "preflight-response-token",
      }), { status: 200, headers: { "content-type": "application/json" } }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(requests.some((request) => request.zoom === true), false);

      if (typeof transitionCleanup === "function") transitionCleanup();
      assert.deepEqual(requests, [
        { method: "GET" },
        { method: "POST", zoom: false, keepalive: true },
        { method: "POST", zoom: false, keepalive: true },
      ]);
      if (typeof navigationCleanup === "function") navigationCleanup();
      testWindow.dispatch("pagehide");
      assert.equal(requests.length, 3);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      moduleHooks.deregister();
      globalThis.fetch = originalFetch;
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
      if (originalReact) Object.defineProperty(globalThis, "React", originalReact);
      else Reflect.deleteProperty(globalThis, "React");
      delete hookState.__openbotComputerHooks;
    }
  });

  test("real ComputerScreen ignores an old load failure after a confirmed transition", async () => {
    type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    const staleLoad = deferred<Response>();
    const requests: string[] = [];
    const response = (data: Computer, token: string) => new Response(JSON.stringify({
      ...data,
      ownershipEpoch: token,
    }), { status: 200, headers: { "content-type": "application/json" } });
    const handlers: FetchHandler[] = [
      () => staleLoad.promise,
      async () => response(computer("Ada", "view-only"), "confirmed-transition-token"),
    ];
    const harness = await renderComputerScreenHarness(((input, init) => {
      const method = init?.method ?? "GET";
      requests.push(method);
      const handler = handlers.shift();
      if (!handler) throw new Error(`Unexpected ${method} request`);
      return handler(input, init);
    }) as typeof fetch);
    let loadCleanup: void | (() => void);
    let transitionCleanup: void | (() => void);
    try {
      loadCleanup = harness.effects[0]?.();
      transitionCleanup = harness.effects[1]?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(requests, ["GET", "POST"]);
      assert.equal((harness.stateValues[0] as Computer | null)?.ownership, "view-only");

      staleLoad.reject(new Error("old Computer load failed"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(harness.stateValues[1], null);
      assert.equal((harness.stateValues[0] as Computer | null)?.ownership, "view-only");
    } finally {
      if (typeof loadCleanup === "function") loadCleanup();
      if (typeof transitionCleanup === "function") transitionCleanup();
      harness.restore();
    }
  });

  test("real ComputerScreen publishes only the latest overlapping poll", async () => {
    type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    const initialLoad = deferred<Response>();
    const olderPoll = deferred<Response>();
    const newerPoll = deferred<Response>();
    const response = (data: Computer, token: string) => new Response(JSON.stringify({
      ...data,
      ownershipEpoch: token,
    }), { status: 200, headers: { "content-type": "application/json" } });
    const handlers: FetchHandler[] = [
      () => initialLoad.promise,
      async () => response(computer("Ada", "view-only"), "confirmed-transition-token"),
      () => olderPoll.promise,
      () => newerPoll.promise,
    ];
    const harness = await renderComputerScreenHarness(((input, init) => {
      const method = init?.method ?? "GET";
      const handler = handlers.shift();
      if (!handler) throw new Error(`Unexpected ${method} request`);
      return handler(input, init);
    }) as typeof fetch);
    let loadCleanup: void | (() => void);
    let transitionCleanup: void | (() => void);
    try {
      loadCleanup = harness.effects[0]?.();
      transitionCleanup = harness.effects[1]?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      initialLoad.resolve(response(computer("initial-stale", "view-only"), "initial-stale-token"));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const poll = [...harness.intervals.values()][0];
      assert.ok(poll, "Computer poll interval was not registered");
      poll();
      poll();
      newerPoll.resolve(response(computer("newer", "view-only"), "newer-poll-token"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal((harness.stateValues[0] as Computer | null)?.botId, "newer");
      const updatesAfterNewerPoll = harness.stateUpdates.length;

      olderPoll.resolve(response(computer("older", "write"), "older-poll-token"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal((harness.stateValues[0] as Computer | null)?.botId, "newer");
      assert.equal(harness.stateUpdates.length, updatesAfterNewerPoll);
    } finally {
      if (typeof loadCleanup === "function") loadCleanup();
      if (typeof transitionCleanup === "function") transitionCleanup();
      harness.restore();
    }
  });

  test("carries a bounded opaque Computer token unchanged into the grant POST", async () => {
    type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    const handlers: FetchHandler[] = [];
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = method === "GET"
        ? {}
        : (JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      requests.push({ method, body });
      const handler = handlers.shift();
      if (!handler) throw new Error(`Unexpected ${method} request`);
      return handler(input, init);
    }) as typeof fetch;

    const response = (ownershipEpoch: string, ownership: Computer["ownership"] = "view-only") =>
      new Response(JSON.stringify({ ...computer("Ada", ownership), ownershipEpoch }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    try {
      const opaqueToken = "x".repeat(128);
      handlers.push(async () => { throw new TypeError("release transport failed"); });
      await assert.rejects(releaseComputerForNavigation("Ada"), /release transport failed/);
      handlers.push(async () => response(opaqueToken));
      handlers.push(async () => response(opaqueToken, "write"));

      await setComputerZoom("Ada", true);

      assert.deepEqual(requests.slice(-2).map((request) => request.method), ["GET", "POST"]);
      assert.equal(
        requests.at(-1)?.body.ownershipEpoch,
        opaqueToken,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("release authority outranks polling and transport failure forces a fresh preflight", async () => {
    type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    const handlers: FetchHandler[] = [];
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = method === "GET"
        ? {}
        : (JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      requests.push({ method, body });
      const handler = handlers.shift();
      if (!handler) throw new Error(`Unexpected ${method} request`);
      return handler(input, init);
    }) as typeof fetch;

    const response = (token: string, ownership: Computer["ownership"] = "view-only", status = 200) =>
      new Response(JSON.stringify({
        ...computer("Ada", ownership),
        ownershipEpoch: token,
        ...(status >= 400 ? { error: `opaque server detail for ${token}` } : {}),
      }), {
        status,
        headers: { "content-type": "application/json" },
      });
    try {
      handlers.push(async () => response("seed-token"));
      await getComputer("Ada");

      const releaseReply = deferred<Response>();
      handlers.push(() => releaseReply.promise);
      const release = releaseComputerForNavigation("Ada");
      handlers.push(async () => response("poll-token-from-during-release"));
      await getComputer("Ada");
      releaseReply.resolve(response("single-release-token"));
      await release;

      handlers.push(async () => response("server-current-token", "view-only", 409));
      await assert.rejects(
        setComputerZoom("Ada", true),
        { message: "Computer changed. Refresh and retry Computer." },
      );
      assert.equal(requests.at(-1)?.body.ownershipEpoch, "single-release-token");

      const firstOverlapReply = deferred<Response>();
      const latestOverlapReply = deferred<Response>();
      handlers.push(() => firstOverlapReply.promise);
      const firstOverlap = releaseComputerForNavigation("Ada");
      handlers.push(() => latestOverlapReply.promise);
      const latestOverlap = releaseComputerForNavigation("Ada");
      latestOverlapReply.resolve(response("latest-overlap-token"));
      await latestOverlap;

      const requestsBeforePendingGrant = requests.length;
      const grantAfterOverlappingRelease = setComputerZoom("Ada", true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        requests.length,
        requestsBeforePendingGrant,
        "grant dispatched while an earlier overlapping release was unresolved",
      );

      handlers.push(async () => response("fresh-after-overlap-token"));
      handlers.push(async () => response("fresh-after-overlap-token", "write"));
      firstOverlapReply.resolve(response("first-overlap-token"));
      await firstOverlap;
      await grantAfterOverlappingRelease;
      assert.deepEqual(requests.slice(-2).map((request) => request.method), ["GET", "POST"]);
      assert.equal(requests.at(-1)?.body.ownershipEpoch, "fresh-after-overlap-token");

      handlers.push(async () => response("failed-release-token", "unknown", 503));
      await assert.rejects(setComputerZoom("Ada", false), /opaque server detail/);
      const afterFailedRelease = requests.length;
      handlers.push(async () => response("failed-release-token", "write"));
      await setComputerZoom("Ada", true);
      assert.equal(requests.length, afterFailedRelease + 1);
      assert.equal(requests.at(-1)?.body.ownershipEpoch, "failed-release-token");

      handlers.push(async () => { throw new TypeError("release transport failed"); });
      await assert.rejects(releaseComputerForNavigation("Ada"), /release transport failed/);
      handlers.push(async () => response("post-failure-refresh-token"));
      handlers.push(async () => response("post-failure-refresh-token", "write"));
      await setComputerZoom("Ada", true);
      assert.deepEqual(requests.slice(-2).map((request) => request.method), ["GET", "POST"]);
      assert.equal(requests.at(-1)?.body.ownershipEpoch, "post-failure-refresh-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("carries its exact opaque preflight token through a later poll to the grant POST", async () => {
    type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    const handlers: FetchHandler[] = [];
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = method === "GET"
        ? {}
        : (JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      requests.push({ method, body });
      const handler = handlers.shift();
      if (!handler) throw new Error(`Unexpected ${method} request`);
      return handler(input, init);
    }) as typeof fetch;

    const response = (token: string, status = 200) => new Response(JSON.stringify({
      ...computer("Ada", "view-only"),
      ownershipEpoch: token,
      ...(status === 409 ? { error: `stale ${token}` } : {}),
    }), { status, headers: { "content-type": "application/json" } });
    try {
      handlers.push(async () => { throw new TypeError("release transport failed"); });
      await assert.rejects(releaseComputerForNavigation("Ada"), /release transport failed/);

      const preflightReply = deferred<Response>();
      handlers.push(() => preflightReply.promise);
      const grant = setComputerZoom("Ada", true);
      await new Promise<void>((resolve) => setImmediate(resolve));

      handlers.push(async () => response("intervening-poll-token"));
      await getComputer("Ada");

      handlers.push(async () => response("current-server-token", 409));
      preflightReply.resolve(response("exact-preflight-token"));
      await assert.rejects(
        grant,
        { message: "Computer changed. Refresh and retry Computer." },
      );
      assert.equal(requests.at(-1)?.method, "POST");
      assert.equal(
        requests.at(-1)?.body.ownershipEpoch,
        "exact-preflight-token",
        "grant rebound to the ambient epoch instead of its own preflight",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects empty and oversized response tokens before dispatching a grant", async () => {
    type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    const handlers: FetchHandler[] = [];
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = method === "GET"
        ? {}
        : (JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      requests.push({ method, body });
      const handler = handlers.shift();
      if (!handler) throw new Error(`Unexpected ${method} request`);
      return handler(input, init);
    }) as typeof fetch;

    try {
      for (const ownershipEpoch of [
        "",
        null,
        "9".repeat(1024),
      ]) {
        handlers.push(async () => { throw new TypeError("release transport failed"); });
        await assert.rejects(releaseComputerForNavigation("Ada"), /release transport failed/);
        handlers.push(async () => new Response(JSON.stringify({
          ...computer("Ada", "view-only"),
          ownershipEpoch,
        }), { status: 200, headers: { "content-type": "application/json" } }));
        await assert.rejects(
          setComputerZoom("Ada", true),
          { message: "Computer ownership epoch is unavailable. Refresh Computer before granting write." },
        );
      }
      assert.equal(
        requests.some((request) => request.body.zoom === true),
        false,
        "invalid response token reached the grant POST",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("grants pointer and keyboard control only for a confirmed remote write owner", () => {
    assert.equal(computerCanWrite(computer("Ada", "view-only"), true), false);
    assert.equal(computerCanWrite(computer("Ada", "unknown"), true), false);
    assert.equal(computerCanWrite(computer("Ada", "write"), false), false);
    assert.equal(computerCanWrite(computer("Ada", "write"), true), true);
    assert.equal(computerCanWrite(computer("Ada", "write"), true, "Ben"), false);
  });

  test("renders ownership failures as an accessible retryable alert", async () => {
    const source = await readFile(
      new URL("../src/components/Computer.tsx", import.meta.url),
      "utf8",
    );
    assert.match(source, /role="alert"/);
    assert.match(source, /Retry Computer/);
    assert.match(source, /computerCanWrite\(computer, expanded, botId\)/);
    assert.match(source, /releaseComputerForNavigation\(botId\)/);
    assert.doesNotMatch(source, /setComputerZoom\(botId, false, \{ keepalive: true \}\)/);
  });
});
