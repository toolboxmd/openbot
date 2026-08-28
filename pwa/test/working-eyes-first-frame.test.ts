import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, test } from "node:test";

type Effect = () => void | (() => void);
type Frame = (timestamp: number) => void;

type EyesHarnessState = {
  canvas: HTMLCanvasElement;
  effects: Effect[];
};

let harnessId = 0;

function moduleUrl(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

async function mountWorkingEyes(): Promise<{
  advanceFrame: (timestamp: number) => void;
  cleanup: () => void;
  paintCount: () => number;
}> {
  let paints = 0;
  const gradient = { addColorStop() {} };
  const context = {
    arc() {},
    beginPath() {},
    clearRect() {
      paints += 1;
    },
    closePath() {},
    createRadialGradient() {
      return gradient;
    },
    ellipse() {},
    fill() {},
    lineTo() {},
    moveTo() {},
    restore() {},
    rotate() {},
    save() {},
    setTransform() {},
    stroke() {},
    translate() {},
    fillStyle: "",
    globalAlpha: 1,
    lineJoin: "round",
    lineWidth: 1,
    strokeStyle: "",
  };
  const canvas = {
    width: 40,
    height: 40,
    getContext(kind: string) {
      assert.equal(kind, "2d");
      return context;
    },
    getBoundingClientRect() {
      return { bottom: 40, height: 40, left: 0, right: 40, top: 0, width: 40 };
    },
  } as unknown as HTMLCanvasElement;
  const effects: Effect[] = [];
  const state = globalThis as typeof globalThis & {
    __openbotEyesHarness?: EyesHarnessState;
  };
  state.__openbotEyesHarness = { canvas, effects };

  const id = ++harnessId;
  const reactUrl = moduleUrl(`
    // Working Eyes harness ${id}
    const state = globalThis.__openbotEyesHarness;
    export const useEffect = (effect) => { state.effects.push(effect); };
    export const useRef = () => ({ current: state.canvas });
  `);
  const jsxUrl = moduleUrl(`
    export const Fragment = Symbol.for("openbot.test.fragment");
    export const jsx = (type, props) => ({ type, props });
    export const jsxs = jsx;
    export const jsxDEV = jsx;
  `);
  const faceUrl = new URL("../src/lib/face.ts", import.meta.url).href;
  const utilsUrl = new URL("../src/lib/utils.ts", import.meta.url).href;
  const moduleHooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "react") return { url: reactUrl, shortCircuit: true };
      if (specifier === "react/jsx-runtime" || specifier === "react/jsx-dev-runtime") {
        return { url: jsxUrl, shortCircuit: true };
      }
      if (specifier === "@/lib/face") return { url: faceUrl, shortCircuit: true };
      if (specifier === "@/lib/utils") return { url: utilsUrl, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });

  const frames = new Map<number, Frame>();
  let nextFrameId = 0;
  const listeners = new Map<string, Set<EventListener>>();
  const testWindow = {
    devicePixelRatio: 1,
    matchMedia() {
      return { matches: false };
    },
    addEventListener(type: string, listener: EventListener) {
      const registered = listeners.get(type) ?? new Set<EventListener>();
      registered.add(listener);
      listeners.set(type, registered);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
  };

  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalReact = Object.getOwnPropertyDescriptor(globalThis, "React");
  const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
  const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const originalCancelAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const originalRandom = Math.random;
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
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: { now: () => 100 },
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value(callback: Frame) {
      const frameId = ++nextFrameId;
      frames.set(frameId, callback);
      return frameId;
    },
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value(frameId: number) {
      frames.delete(frameId);
    },
  });
  Math.random = () => 0.5;

  let effectCleanup: void | (() => void);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    effectCleanup?.();
    moduleHooks.deregister();
    Math.random = originalRandom;
    if (originalReact) Object.defineProperty(globalThis, "React", originalReact);
    else Reflect.deleteProperty(globalThis, "React");
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalPerformance) Object.defineProperty(globalThis, "performance", originalPerformance);
    else Reflect.deleteProperty(globalThis, "performance");
    if (originalRequestAnimationFrame) {
      Object.defineProperty(globalThis, "requestAnimationFrame", originalRequestAnimationFrame);
    } else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    if (originalCancelAnimationFrame) {
      Object.defineProperty(globalThis, "cancelAnimationFrame", originalCancelAnimationFrame);
    } else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    delete state.__openbotEyesHarness;
  };

  try {
    const componentUrl = new URL("../src/components/Eyes.tsx", import.meta.url);
    componentUrl.searchParams.set("working-first-frame-harness", String(id));
    const { Eyes } = await import(componentUrl.href) as typeof import("../src/components/Eyes.tsx");
    const rendered = Eyes({ name: "Ada", mode: "work", size: 40 });
    assert.equal(rendered.type, "canvas");
    assert.equal(rendered.props["data-face-mode"], "work");
    assert.equal(effects.length, 1);
    effectCleanup = effects[0]!();
    assert.equal(paints, 1, "mount paints the initial Working face");
    assert.equal(frames.size, 1, "mount schedules the first animation frame");
  } catch (error) {
    restore();
    throw error;
  }

  return {
    advanceFrame(timestamp: number) {
      assert.equal(frames.size, 1, "exactly one animation frame is pending");
      const next = frames.entries().next().value as [number, Frame] | undefined;
      assert.ok(next);
      frames.delete(next[0]);
      const before = paints;
      next[1](timestamp);
      assert.equal(paints, before + 1, `frame at ${timestamp} ms paints`);
      assert.equal(frames.size, 1, `frame at ${timestamp} ms schedules its successor`);
    },
    cleanup: restore,
    paintCount: () => paints,
  };
}

describe("Working Eyes first animation frame", () => {
  test("paints an early first timestamp, a later frame, and all three look-cycle poses", async () => {
    const harness = await mountWorkingEyes();
    try {
      harness.advanceFrame(99.75);
      harness.advanceFrame(116.42);

      let frameTimestamp = 116.42;
      const poseMidpoints = [439.75, 1119.75, 1799.75] as const;
      for (const [lookIndex, targetTimestamp] of poseMidpoints.entries()) {
        const before = harness.paintCount();
        while (frameTimestamp < targetTimestamp) {
          frameTimestamp = Math.min(targetTimestamp, frameTimestamp + 50);
          harness.advanceFrame(frameTimestamp);
        }
        assert.ok(
          harness.paintCount() > before,
          `Working look-cycle index ${lookIndex} stays inside the three-pose cycle and paints`,
        );
      }
    } finally {
      harness.cleanup();
    }
  });
});
