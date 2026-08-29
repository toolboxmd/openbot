import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { describe, test } from "node:test";
import {
  computerCanWrite,
  retryComputer,
  screenCanRetry,
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
    screenState: "ready",
    screenAttempt: `${botId}-attempt`,
    screenError: null,
    screenCleanupError: null,
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
  onClose: () => void = () => undefined,
): Promise<{
  effects: ComponentEffect[];
  intervals: Map<number, () => void>;
  stateValues: unknown[];
  stateUpdates: Array<{ index: number; value: unknown }>;
  dispatchWindowEvent: (type: string, event?: unknown) => void;
  render: (botId?: string | null, nextExpanded?: boolean) => unknown;
  restore: () => void;
}> {
  const effects: ComponentEffect[] = [];
  const intervals = new Map<number, () => void>();
  const stateValues: unknown[] = [];
  const stateUpdates: Array<{ index: number; value: unknown }> = [];
  const hookState = globalThis as typeof globalThis & {
    __openbotComputerRenderHooks?: {
      effects: ComponentEffect[];
      refIndex: number;
      refValues: Array<{ current: unknown }>;
      stateIndex: number;
      stateUpdates: Array<{ index: number; value: unknown }>;
      stateValues: unknown[];
    };
  };
  hookState.__openbotComputerRenderHooks = {
    effects,
    refIndex: 0,
    refValues: [],
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
    export const useRef = (value) => {
      const index = state.refIndex++;
      if (!(index in state.refValues)) state.refValues[index] = { current: value };
      return state.refValues[index];
    };
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
  const iconsUrl = moduleUrl("export const Maximize2 = () => null; export const MessageSquare = () => null;");
  const sessionUrl = new URL("../src/lib/session.ts", import.meta.url).href;
  const asyncStateUrl = new URL("../src/lib/async-state.ts", import.meta.url).href;
  const computerZoomUrl = new URL("../src/lib/computer-zoom.ts", import.meta.url).href;
  const moduleHooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "react") return { url: reactUrl, shortCircuit: true };
      if (specifier === "react/jsx-runtime" || specifier === "react/jsx-dev-runtime") {
        return { url: jsxUrl, shortCircuit: true };
      }
      if (specifier === "@/lib/session") return { url: sessionUrl, shortCircuit: true };
      if (specifier === "@/lib/async-state") return { url: asyncStateUrl, shortCircuit: true };
      if (specifier === "@/lib/computer-zoom") return { url: computerZoomUrl, shortCircuit: true };
      if (specifier === "@/components/ui/button") return { url: buttonUrl, shortCircuit: true };
      if (specifier === "@/lib/utils") return { url: utilsUrl, shortCircuit: true };
      if (specifier === "lucide-react") return { url: iconsUrl, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });

  let intervalId = 0;
  const listeners = new Map<string, Set<(event?: unknown) => void>>();
  const testWindow = {
    setInterval(callback: () => void) {
      intervalId += 1;
      intervals.set(intervalId, callback);
      return intervalId;
    },
    clearInterval(id: number) {
      intervals.delete(id);
    },
    addEventListener(type: string, listener: (event?: unknown) => void) {
      const registered = listeners.get(type) ?? new Set<(event?: unknown) => void>();
      registered.add(listener);
      listeners.set(type, registered);
    },
    removeEventListener(type: string, listener: (event?: unknown) => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  const dispatchWindowEvent = (type: string, event?: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
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
    const render = (botId: string | null = "Ada", nextExpanded = expanded) => {
      hookState.__openbotComputerRenderHooks!.stateIndex = 0;
      hookState.__openbotComputerRenderHooks!.refIndex = 0;
      return ComputerScreen({ botId, expanded: nextExpanded, onClose });
    };
    render();
    return { effects, intervals, stateValues, stateUpdates, dispatchWindowEvent, render, restore };
  } catch (error) {
    restore();
    throw error;
  }
}

function countJsxElements(node: unknown, type: string): number {
  if (Array.isArray(node)) return node.reduce((count, child) => count + countJsxElements(child, type), 0);
  if (typeof node !== "object" || node === null) return 0;
  const element = node as { type?: unknown; props?: { children?: unknown } };
  return (element.type === type ? 1 : 0) + countJsxElements(element.props?.children, type);
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

  test("selected Bot pagehide issues no ownership request before its Screen state loads", async () => {
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
    const iconsUrl = moduleUrl("export const Maximize2 = () => null; export const MessageSquare = () => null;");
    const sessionUrl = new URL("../src/lib/session.ts", import.meta.url).href;
    const asyncStateUrl = new URL("../src/lib/async-state.ts", import.meta.url).href;
    const computerZoomUrl = new URL("../src/lib/computer-zoom.ts", import.meta.url).href;
    const moduleHooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "react") return { url: reactUrl, shortCircuit: true };
        if (specifier === "react/jsx-runtime" || specifier === "react/jsx-dev-runtime") {
          return { url: jsxUrl, shortCircuit: true };
        }
        if (specifier === "@/lib/session") return { url: sessionUrl, shortCircuit: true };
        if (specifier === "@/lib/async-state") return { url: asyncStateUrl, shortCircuit: true };
        if (specifier === "@/lib/computer-zoom") return { url: computerZoomUrl, shortCircuit: true };
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
      assert.deepEqual(requests, []);

      testWindow.dispatch("pagehide");
      assert.deepEqual(requests, []);
      epochPreflight.resolve(new Response(JSON.stringify({
        ...computer("Ada", "view-only"),
        ownershipEpoch: "preflight-response-token",
      }), { status: 200, headers: { "content-type": "application/json" } }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(requests.some((request) => request.zoom === true), false);

      if (typeof transitionCleanup === "function") transitionCleanup();
      assert.deepEqual(requests, []);
      if (typeof navigationCleanup === "function") navigationCleanup();
      testWindow.dispatch("pagehide");
      assert.equal(requests.length, 0);
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
    const staleLoad = deferred<Response>();
    const requests: string[] = [];
    const response = (data: Computer, token: string) => new Response(JSON.stringify({
      ...data,
      ownershipEpoch: token,
    }), { status: 200, headers: { "content-type": "application/json" } });
    let getCount = 0;
    const harness = await renderComputerScreenHarness(((input, init) => {
      const method = init?.method ?? "GET";
      requests.push(method);
      if (method === "GET") {
        getCount += 1;
        if (getCount === 1) return staleLoad.promise;
      }
      return Promise.resolve(response(computer("Ada", "view-only"), "confirmed-transition-token"));
    }) as typeof fetch);
    let loadCleanup: void | (() => void);
    let transitionCleanup: void | (() => void);
    let confirmedCleanup: void | (() => void);
    try {
      loadCleanup = harness.effects[0]?.();
      transitionCleanup = harness.effects[1]?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(requests, ["GET"]);

      harness.stateValues[0] = computer("Ada", "view-only");
      const nextEffects = harness.effects.length;
      harness.render();
      confirmedCleanup = harness.effects[nextEffects + 1]?.();
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
      if (typeof confirmedCleanup === "function") confirmedCleanup();
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
      initialLoad.resolve(response({
        ...computer("Ada", "view-only"),
        screenAttempt: "initial-stale-attempt",
      }, "initial-stale-token"));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const poll = [...harness.intervals.values()][0];
      assert.ok(poll, "Computer poll interval was not registered");
      poll();
      poll();
      newerPoll.resolve(response({
        ...computer("Ada", "view-only"),
        screenAttempt: "newer-poll-attempt",
      }, "newer-poll-token"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal((harness.stateValues[0] as Computer | null)?.screenAttempt, "newer-poll-attempt");
      const updatesAfterNewerPoll = harness.stateUpdates.length;

      olderPoll.resolve(response({
        ...computer("Ada", "write"),
        screenAttempt: "older-poll-attempt",
      }, "older-poll-token"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal((harness.stateValues[0] as Computer | null)?.screenAttempt, "newer-poll-attempt");
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

  test("rejects a mismatched Bot ownership preflight before dispatching a grant", async () => {
    const requests: Array<{ pathname: string; method: string }> = [];
    let rejectRelease = true;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://openbot.local");
      const method = init?.method ?? "GET";
      requests.push({ pathname: url.pathname, method });
      if (method === "POST" && rejectRelease) {
        rejectRelease = false;
        throw new TypeError("release transport reset");
      }
      if (method === "GET") {
        return new Response(JSON.stringify({
          ...computer("Ben", "view-only"),
          ownershipEpoch: "wrong-bot-token",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(computer("Ada", "write")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await assert.rejects(releaseComputerForNavigation("Ada"));
      requests.length = 0;
      await assert.rejects(
        setComputerZoom("Ada", true),
        /selected Bot/u,
      );
      assert.deepEqual(requests, [{ pathname: "/api/computer", method: "GET" }]);
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

  test("every explicit non-ready Computer state renders no iframe, makes no ownership request, and closes directly", async (t) => {
    const baseUnavailable: Computer = {
      ...computer("Ada", "unknown"),
      path: null,
      ready: false,
      screenState: "unavailable",
      screenAttempt: "unavailable-attempt",
      screenError: {
        stage: "prepare",
        code: "SCREEN_ATTACHMENT_FAILED",
        message: "Screen attachment failed during prepare.",
      },
      screenCleanupError: null,
      display: 1,
    };
    const cases: Array<{ state: Computer["screenState"]; value: Computer; retry: boolean }> = [
      {
        state: "attaching",
        value: { ...baseUnavailable, screenState: "attaching", screenAttempt: "attaching-attempt", screenError: null },
        retry: false,
      },
      { state: "unavailable", value: baseUnavailable, retry: true },
      {
        state: "unassigned",
        value: {
          ...baseUnavailable,
          screenState: "unassigned",
          screenAttempt: "unassigned-attempt",
          screenError: null,
          display: null,
        },
        retry: true,
      },
      {
        state: "cleanup-required",
        value: {
          ...baseUnavailable,
          screenState: "cleanup-required",
          screenAttempt: "cleanup-attempt",
          screenCleanupError: {
            code: "SCREEN_CLEANUP_FAILED",
            message: "Screen cleanup did not complete.",
          },
        },
        retry: false,
      },
    ];

    for (const current of cases) {
      await t.test(current.state, async () => {
        const requests: Array<{ pathname: string; method: string }> = [];
        let closeCalls = 0;
        let escapePrevented = false;
        const harness = await renderComputerScreenHarness(((input, init) => {
          const url = new URL(String(input), "http://openbot.local");
          const method = init?.method ?? "GET";
          requests.push({ pathname: url.pathname, method });
          if (method !== "GET") throw new Error(`${current.state} Computer attempted an ownership transition`);
          return Promise.resolve(new Response(JSON.stringify(current.value), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        }) as typeof fetch, true, () => {
          closeCalls += 1;
        });
        const cleanups: Array<void | (() => void)> = [];
        try {
          cleanups.push(...harness.effects.map((effect) => effect()));
          await new Promise<void>((resolve) => setImmediate(resolve));
          await new Promise<void>((resolve) => setImmediate(resolve));
          const nextEffect = harness.effects.length;
          const rendered = harness.render() as {
            props?: { onClose?: () => void; onRetry?: () => void };
          };
          cleanups.push(harness.effects[nextEffect + 1]?.());

          assert.equal(countJsxElements(rendered, "iframe"), 0);
          assert.equal(typeof rendered.props?.onRetry === "function", current.retry);
          assert.equal(screenCanRetry(current.value), current.retry);
          rendered.props?.onClose?.();
          harness.dispatchWindowEvent("keydown", {
            key: "Escape",
            preventDefault() {
              escapePrevented = true;
            },
          });
          harness.dispatchWindowEvent("pagehide");
          await new Promise<void>((resolve) => setImmediate(resolve));

          assert.equal(closeCalls, 2);
          assert.equal(escapePrevented, true);
          assert.ok(requests.length >= 1);
          assert.equal(requests.every((request) => request.method === "GET"), true);
        } finally {
          for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
          harness.restore();
        }
      });
    }

    const source = await readFile(new URL("../src/components/Computer.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(source, /const path = computer\?\.path \?\?/u);
  });

  test("retry invalidates an older poll and later polling can publish the recovered Screen", async () => {
    const unavailable: Computer = {
      ...computer("Ada", "unknown"),
      path: null,
      ready: false,
      screenState: "unavailable",
      screenAttempt: "failed-attempt",
      screenError: {
        stage: "commit",
        code: "SCREEN_ATTACHMENT_FAILED",
        message: "Screen attachment failed during commit.",
      },
      screenCleanupError: null,
      display: 1,
    };
    const attaching: Computer = {
      ...unavailable,
      screenState: "attaching",
      screenAttempt: "accepted-attempt",
      screenError: null,
    };
    const recovered = computer("Ada", "view-only");
    const stalePoll = deferred<Response>();
    const requests: Array<{ pathname: string; method: string; body?: Record<string, unknown> }> = [];
    let getCount = 0;
    const response = (value: Computer, status = 200) => new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
    const harness = await renderComputerScreenHarness(((input, init) => {
      const url = new URL(String(input), "http://openbot.local");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({ pathname: url.pathname, method, body });
      if (url.pathname === "/api/computer/retry") return Promise.resolve(response(attaching, 202));
      getCount += 1;
      if (getCount === 1) return Promise.resolve(response(unavailable));
      if (getCount === 2) return stalePoll.promise;
      return Promise.resolve(response(recovered));
    }) as typeof fetch, true);
    const cleanups: Array<void | (() => void)> = [];
    try {
      cleanups.push(harness.effects[0]?.(), harness.effects[1]?.());
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      const poll = [...harness.intervals.values()][0];
      assert.ok(poll);
      poll();

      const rendered = harness.render() as { props?: { onRetry?: () => void } };
      rendered.props?.onRetry?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(
        {
          state: (harness.stateValues[0] as Computer | null)?.screenState,
          attempt: (harness.stateValues[0] as Computer | null)?.screenAttempt,
        },
        { state: "attaching", attempt: "accepted-attempt" },
      );
      assert.deepEqual(requests.find((request) => request.pathname === "/api/computer/retry"), {
        pathname: "/api/computer/retry",
        method: "POST",
        body: { botId: "Ada", screenAttempt: "failed-attempt" },
      });

      stalePoll.resolve(response(unavailable));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(
        {
          state: (harness.stateValues[0] as Computer | null)?.screenState,
          attempt: (harness.stateValues[0] as Computer | null)?.screenAttempt,
        },
        { state: "attaching", attempt: "accepted-attempt" },
      );

      poll();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal((harness.stateValues[0] as Computer | null)?.screenState, "ready");
      assert.equal((harness.stateValues[0] as Computer | null)?.screenAttempt, "Ada-attempt");
    } finally {
      for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
      harness.restore();
    }
  });

  test("same rendered retry handler accepts only one in-flight Screen request", async () => {
    const unavailable: Computer = {
      ...computer("Ada", "unknown"),
      path: null,
      ready: false,
      screenState: "unavailable",
      screenAttempt: "failed-attempt",
      screenError: {
        stage: "prepare",
        code: "SCREEN_ATTACHMENT_FAILED",
        message: "Screen attachment failed during prepare.",
      },
      screenCleanupError: null,
      display: 1,
    };
    const retryReply = deferred<Response>();
    const requests: Array<{ pathname: string; method: string }> = [];
    const harness = await renderComputerScreenHarness(((input, init) => {
      const url = new URL(String(input), "http://openbot.local");
      const method = init?.method ?? "GET";
      requests.push({ pathname: url.pathname, method });
      if (url.pathname === "/api/computer/retry") return retryReply.promise;
      return Promise.resolve(new Response(JSON.stringify(unavailable), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }) as typeof fetch, true);
    const cleanups: Array<void | (() => void)> = [];
    try {
      cleanups.push(harness.effects[0]?.(), harness.effects[1]?.());
      await new Promise<void>((resolve) => setImmediate(resolve));
      const rendered = harness.render() as { props?: { onRetry?: () => void } };
      rendered.props?.onRetry?.();
      rendered.props?.onRetry?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        requests.filter((request) => request.pathname === "/api/computer/retry").length,
        1,
      );

      retryReply.resolve(new Response(JSON.stringify({
        ...unavailable,
        screenState: "attaching",
        screenAttempt: "accepted-attempt",
        screenError: null,
      }), { status: 202, headers: { "content-type": "application/json" } }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(
        {
          state: (harness.stateValues[0] as Computer | null)?.screenState,
          attempt: (harness.stateValues[0] as Computer | null)?.screenAttempt,
          error: harness.stateValues[1],
        },
        { state: "attaching", attempt: "accepted-attempt", error: null },
      );
    } finally {
      for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
      harness.restore();
    }
  });

  test("old ready Bot never renders or transitions as the newly selected Bot before its load settles", async () => {
    const benLoad = deferred<Response>();
    const requests: Array<{ pathname: string; method: string; body?: Record<string, unknown> }> = [];
    let getCount = 0;
    let closeCalls = 0;
    const harness = await renderComputerScreenHarness(((input, init) => {
      const url = new URL(String(input), "http://openbot.local");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({ pathname: url.pathname, method, body });
      if (method !== "GET") {
        return Promise.resolve(new Response(JSON.stringify(computer("Ben", "write")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }
      getCount += 1;
      if (getCount === 1) {
        return Promise.resolve(new Response(JSON.stringify(computer("Ada", "view-only")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }
      return benLoad.promise;
    }) as typeof fetch, true, () => {
      closeCalls += 1;
    });
    const cleanups: Array<void | (() => void)> = [];
    try {
      cleanups.push(harness.effects[0]?.(), harness.effects[1]?.());
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(countJsxElements(harness.render("Ada"), "iframe"), 1);

      const nextEffect = harness.effects.length;
      const mismatched = harness.render("Ben") as { props?: { onClose?: () => void } };
      assert.equal(countJsxElements(mismatched, "iframe"), 0);
      cleanups.push(harness.effects[nextEffect + 1]?.());
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(requests.some((request) => request.method === "POST"), false);
      mismatched.props?.onClose?.();
      assert.equal(closeCalls, 1);
      assert.equal(computerCanWrite(computer("Ada", "write"), true, "Ben"), false);

      cleanups.push(harness.effects[nextEffect]?.());
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal((harness.stateValues[0] as Computer | null), null);
    } finally {
      benLoad.resolve(new Response(JSON.stringify({
        ...computer("Ben", "unknown"),
        path: null,
        ready: false,
        screenState: "unavailable",
      }), { status: 200, headers: { "content-type": "application/json" } }));
      for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
      harness.restore();
    }
  });

  test("Bot switch invalidates an old delayed retry response or rejection", async (t) => {
    for (const outcome of ["resolve", "reject"] as const) {
      await t.test(outcome, async () => {
        const ada: Computer = {
          ...computer("Ada", "unknown"),
          path: null,
          ready: false,
          screenState: "unavailable",
          screenAttempt: "ada-failed-attempt",
          screenError: {
            stage: "reserve",
            code: "SCREEN_ATTACHMENT_FAILED",
            message: "Screen attachment failed during reserve.",
          },
          screenCleanupError: null,
          display: 1,
        };
        const ben: Computer = {
          ...ada,
          botId: "Ben",
          screenAttempt: "ben-failed-attempt",
          display: 2,
        };
        const oldRetry = deferred<Response>();
        let getCount = 0;
        const harness = await renderComputerScreenHarness(((input, init) => {
          const url = new URL(String(input), "http://openbot.local");
          if (url.pathname === "/api/computer/retry") return oldRetry.promise;
          getCount += 1;
          return Promise.resolve(new Response(JSON.stringify(getCount === 1 ? ada : ben), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        }) as typeof fetch, true);
        const cleanups: Array<void | (() => void)> = [];
        try {
          cleanups.push(harness.effects[0]?.(), harness.effects[1]?.());
          await new Promise<void>((resolve) => setImmediate(resolve));
          const adaRendered = harness.render("Ada") as { props?: { onRetry?: () => void } };
          adaRendered.props?.onRetry?.();
          await new Promise<void>((resolve) => setImmediate(resolve));

          const nextEffect = harness.effects.length;
          harness.render("Ben");
          cleanups.push(harness.effects[nextEffect]?.(), harness.effects[nextEffect + 1]?.());
          await new Promise<void>((resolve) => setImmediate(resolve));
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal((harness.stateValues[0] as Computer | null)?.botId, "Ben");
          assert.equal(harness.stateValues[1], null);

          if (outcome === "resolve") {
            oldRetry.resolve(new Response(JSON.stringify({
              ...ada,
              screenState: "attaching",
              screenAttempt: "ada-accepted-attempt",
              screenError: null,
            }), { status: 202, headers: { "content-type": "application/json" } }));
          } else {
            oldRetry.resolve(new Response(JSON.stringify({ error: "old Ada stale attempt" }), {
              status: 409,
              headers: { "content-type": "application/json" },
            }));
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal((harness.stateValues[0] as Computer | null)?.botId, "Ben");
          assert.equal((harness.stateValues[0] as Computer | null)?.screenAttempt, "ben-failed-attempt");
          assert.equal(harness.stateValues[1], null);
        } finally {
          for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
          harness.restore();
        }
      });
    }
  });

  test("rendered retry failure stays visible and never unlocks attaching or cleanup-required retry", async () => {
    const unavailable: Computer = {
      ...computer("Ada", "unknown"),
      path: null,
      ready: false,
      screenState: "unavailable",
      screenAttempt: "failed-attempt",
      screenError: {
        stage: "reserve",
        code: "SCREEN_ATTACHMENT_FAILED",
        message: "Screen attachment failed during reserve.",
      },
      screenCleanupError: null,
      display: 1,
    };
    const harness = await renderComputerScreenHarness(((input, init) => {
      const url = new URL(String(input), "http://openbot.local");
      if (url.pathname === "/api/computer/retry") {
        return Promise.resolve(new Response(JSON.stringify({ error: "opaque stale attempt detail" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify(unavailable), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }) as typeof fetch, true);
    const cleanups: Array<void | (() => void)> = [];
    try {
      cleanups.push(harness.effects[0]?.(), harness.effects[1]?.());
      await new Promise<void>((resolve) => setImmediate(resolve));
      const beforeRetry = harness.render() as { props?: { onRetry?: () => void } };
      beforeRetry.props?.onRetry?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const failed = harness.render() as {
        props?: { error?: string | null; onRetry?: () => void };
      };
      assert.equal(failed.props?.error, "Could not retry Screen. Refresh and try again.");
      assert.equal(typeof failed.props?.onRetry, "function");
      harness.stateValues[0] = { ...unavailable, screenState: "attaching", screenError: null };
      const attaching = harness.render() as { props?: { error?: string | null; onRetry?: () => void } };
      assert.equal(attaching.props?.error, "Could not retry Screen. Refresh and try again.");
      assert.equal(attaching.props?.onRetry, undefined);
      harness.stateValues[0] = {
        ...unavailable,
        screenState: "cleanup-required",
        screenCleanupError: {
          code: "SCREEN_CLEANUP_FAILED",
          message: "Screen cleanup did not complete.",
        },
      };
      const cleanup = harness.render() as { props?: { error?: string | null; onRetry?: () => void } };
      assert.equal(cleanup.props?.error, "Could not retry Screen. Refresh and try again.");
      assert.equal(cleanup.props?.onRetry, undefined);
    } finally {
      for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
      harness.restore();
    }
  });

  test("live readiness false mounts no iframe or write grant and polling can recover", async () => {
    const reconnecting: Computer = {
      ...computer("Ada", "view-only"),
      ready: false,
    };
    const recovered = { ...reconnecting, ready: true };
    let getCount = 0;
    const requests: Array<{ pathname: string; method: string }> = [];
    const harness = await renderComputerScreenHarness(((input, init) => {
      const url = new URL(String(input), "http://openbot.local");
      const method = init?.method ?? "GET";
      requests.push({ pathname: url.pathname, method });
      if (method !== "GET") {
        return Promise.resolve(new Response(JSON.stringify(computer("Ada", "write")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }
      getCount += 1;
      return Promise.resolve(new Response(JSON.stringify(getCount === 1 ? reconnecting : recovered), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }) as typeof fetch, true);
    const cleanups: Array<void | (() => void)> = [];
    try {
      cleanups.push(harness.effects[0]?.(), harness.effects[1]?.());
      await new Promise<void>((resolve) => setImmediate(resolve));
      const nextEffect = harness.effects.length;
      const pending = harness.render() as { props?: { computer?: Computer; onRetry?: () => void } };
      cleanups.push(harness.effects[nextEffect + 1]?.());
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(countJsxElements(pending, "iframe"), 0);
      assert.equal(pending.props?.onRetry, undefined);
      assert.equal(pending.props?.computer?.ready, false);
      assert.equal(computerCanWrite(reconnecting, true, "Ada"), false);
      assert.equal(requests.every((request) => request.method === "GET"), true);

      const poll = [...harness.intervals.values()][0];
      assert.ok(poll);
      poll();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const readyEffect = harness.effects.length;
      const ready = harness.render();
      assert.equal((harness.stateValues[0] as Computer | null)?.ready, true);
      assert.equal(countJsxElements(ready, "iframe"), 1);
      cleanups.push(harness.effects[readyEffect + 1]?.());
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(requests.filter((request) => request.method === "POST").length, 1);
      const source = await readFile(new URL("../src/components/Computer.tsx", import.meta.url), "utf8");
      assert.match(source, /computer\?\.ready/u);
      assert.match(source, /computer\?\.botId/u);
    } finally {
      for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
      harness.restore();
    }
  });

  test("ready Screen with unknown ownership offers canonical Computer repair before reacquiring write", async () => {
    const unknown: Computer = {
      ...computer("Ada", "unknown"),
      path: null,
      ready: false,
      screenState: "ready",
      ownershipEpoch: "unknown-epoch",
    };
    const repaired = {
      ...computer("Ada", "view-only"),
      ownershipEpoch: "repaired-epoch",
    };
    const requests: Array<{ pathname: string; method: string; body?: Record<string, unknown> }> = [];
    const harness = await renderComputerScreenHarness(((input, init) => {
      const url = new URL(String(input), "http://openbot.local");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({ pathname: url.pathname, method, body });
      const response = method === "GET"
        ? unknown
        : body?.zoom === false
        ? repaired
        : { ...computer("Ada", "write"), ownershipEpoch: "write-epoch" };
      return Promise.resolve(new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }) as typeof fetch, true);
    const cleanups: Array<void | (() => void)> = [];
    try {
      cleanups.push(harness.effects[0]?.(), harness.effects[1]?.());
      await new Promise<void>((resolve) => setImmediate(resolve));
      const unknownRendered = harness.render() as {
        type?: (props: Record<string, unknown>) => unknown;
        props?: { onRepair?: () => void; onRetry?: () => void };
      };
      assert.equal(countJsxElements(unknownRendered, "iframe"), 0);
      assert.equal(unknownRendered.props?.onRetry, undefined);
      assert.equal(typeof unknownRendered.props?.onRepair, "function");
      const unknownNotice = JSON.stringify(
        unknownRendered.type?.(unknownRendered.props as Record<string, unknown>),
      );
      assert.match(unknownNotice, /Computer access needs repair/u);
      assert.match(unknownNotice, /Retry Computer/u);

      unknownRendered.props?.onRepair?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(
        requests.filter((request) => request.method === "POST").map((request) => request.body?.zoom),
        [false],
      );
      assert.equal((harness.stateValues[0] as Computer | null)?.ownership, "view-only");
      assert.equal((harness.stateValues[0] as Computer | null)?.path, "/screen/Ada/");

      const readyEffect = harness.effects.length;
      const repairedRendered = harness.render();
      assert.equal(countJsxElements(repairedRendered, "iframe"), 1);
      cleanups.push(harness.effects[readyEffect + 1]?.());
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(
        requests.filter((request) => request.method === "POST").map((request) => request.body?.zoom),
        [false, true],
      );
      assert.equal((harness.stateValues[0] as Computer | null)?.ownership, "write");
    } finally {
      for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
      harness.restore();
    }
  });

  test("ownership failures for another Bot never replace the selected Bot state", async (t) => {
    const safeFailure = "Computer ownership could not be confirmed.";
    const mismatchedFailure = {
      ...computer("Ben", "write"),
      ownershipError: safeFailure,
      error: "Could not change Computer ownership.",
    };

    await t.test("automatic ownership effect", async () => {
      const selected = computer("Ada", "view-only");
      const harness = await renderComputerScreenHarness(((input, init) => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
        if (method === "GET") {
          return Promise.resolve(new Response(JSON.stringify(selected), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        }
        const response = body?.zoom === false
          ? computer("Ada", "view-only")
          : mismatchedFailure;
        return Promise.resolve(new Response(JSON.stringify(response), {
          status: body?.zoom === false ? 200 : 503,
          headers: { "content-type": "application/json" },
        }));
      }) as typeof fetch, true);
      let ownershipCleanup: void | (() => void) = undefined;
      try {
        harness.effects[0]?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
        const nextEffect = harness.effects.length;
        harness.render();
        ownershipCleanup = harness.effects[nextEffect + 1]?.();
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.equal((harness.stateValues[0] as Computer | null)?.botId, "Ada");
        assert.equal((harness.stateValues[0] as Computer | null)?.ownership, "view-only");
        assert.equal(harness.stateValues[1], safeFailure);
      } finally {
        if (typeof ownershipCleanup === "function") ownershipCleanup();
        harness.restore();
      }
    });

    await t.test("manual ownership repair", async () => {
      const selected: Computer = {
        ...computer("Ada", "unknown"),
        path: null,
        ready: false,
      };
      const harness = await renderComputerScreenHarness(((input, init) => {
        const method = init?.method ?? "GET";
        const response = method === "GET" ? selected : mismatchedFailure;
        return Promise.resolve(new Response(JSON.stringify(response), {
          status: method === "GET" ? 200 : 503,
          headers: { "content-type": "application/json" },
        }));
      }) as typeof fetch, false);
      try {
        harness.effects[0]?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
        const rendered = harness.render() as { props?: { onRepair?: () => void } };
        assert.equal(typeof rendered.props?.onRepair, "function");
        rendered.props?.onRepair?.();
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.equal((harness.stateValues[0] as Computer | null)?.botId, "Ada");
        assert.equal((harness.stateValues[0] as Computer | null)?.ownership, "unknown");
        assert.equal(harness.stateValues[1], safeFailure);
      } finally {
        harness.restore();
      }
    });
  });

  test("hiding a previously usable expanded Screen releases its captured write authority exactly once", async () => {
    const usable = computer("Ada", "write");
    const hidden: Computer = {
      ...computer("Ada", "unknown"),
      path: null,
      ready: false,
      screenState: "ready",
    };
    let getCount = 0;
    const requests: Array<{ method: string; body?: Record<string, unknown> }> = [];
    const harness = await renderComputerScreenHarness(((input, init) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({ method, body });
      if (method === "GET") {
        getCount += 1;
        return Promise.resolve(new Response(JSON.stringify(getCount === 1 ? usable : hidden), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }
      const response = body?.zoom === false
        ? computer("Ada", "view-only")
        : computer("Ada", "write");
      return Promise.resolve(new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }) as typeof fetch, true);
    const cleanups: Array<void | (() => void)> = [];
    let capturedOwnershipCleanup: void | (() => void) = undefined;
    let capturedCleanupRan = false;
    try {
      cleanups.push(harness.effects[0]?.(), harness.effects[1]?.());
      await new Promise<void>((resolve) => setImmediate(resolve));
      const usableEffect = harness.effects.length;
      assert.equal(countJsxElements(harness.render(), "iframe"), 1);
      capturedOwnershipCleanup = harness.effects[usableEffect + 1]?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      requests.length = 0;

      const poll = [...harness.intervals.values()][0];
      assert.ok(poll);
      poll();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const hiddenEffect = harness.effects.length;
      assert.equal(countJsxElements(harness.render(), "iframe"), 0);
      if (typeof capturedOwnershipCleanup === "function") {
        capturedCleanupRan = true;
        capturedOwnershipCleanup();
      }
      cleanups.push(harness.effects[hiddenEffect + 1]?.());
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.deepEqual(
        requests.filter((request) => request.method === "POST").map((request) => request.body?.zoom),
        [false],
      );
    } finally {
      if (!capturedCleanupRan && typeof capturedOwnershipCleanup === "function") {
        capturedOwnershipCleanup();
      }
      for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
      harness.restore();
    }
  });

  test("renders ownership failures as an accessible retryable alert", async () => {
    const source = await readFile(
      new URL("../src/components/Computer.tsx", import.meta.url),
      "utf8",
    );
    assert.match(source, /role="alert"/);
    assert.match(source, /Retry Computer/);
    assert.match(source, /releaseComputerForNavigation\(botId\)/);
    assert.doesNotMatch(source, /setComputerZoom\(botId, false, \{ keepalive: true \}\)/);
  });
});
