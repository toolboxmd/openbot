import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_SCREEN_UPSTREAM,
  SCREEN_SERVICE,
  superviseTalk,
  type SupervisedChild,
  type SuperviseDeps,
} from "../src/supervise.ts";

class FakeChild implements SupervisedChild {
  pid = 1;
  killed: NodeJS.Signals[] = [];
  #settled = false;
  #exit!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  readonly exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      this.#exit = resolve;
    },
  );

  crash(code = 1): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#exit({ code, signal: null });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    if (!this.#settled) {
      this.#settled = true;
      this.#exit({ code: null, signal });
    }
    return true;
  }

  wait(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.exited;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitUntil(check: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 1000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("start supervisor", () => {
  test("brings Screen up then runs Talk with default SCREEN_UPSTREAM", async () => {
    const order: string[] = [];
    const spawned = deferred<NodeJS.ProcessEnv>();
    const children: FakeChild[] = [];
    let fire: ((signal: NodeJS.Signals) => void) | undefined;

    const run = superviseTalk(
      {
        composeUp: async (service) => {
          order.push(`compose:${service}`);
        },
        spawnDaemon: (env) => {
          order.push("spawn");
          const child = new FakeChild();
          children.push(child);
          spawned.resolve(env);
          return child;
        },
        sleep: async () => {},
        now: () => 0,
        onSignal: (handler) => {
          fire = handler;
          return () => {
            fire = undefined;
          };
        },
      },
      {},
    );

    const env = await spawned.promise;
    assert.deepEqual(order, [`compose:${SCREEN_SERVICE}`, "spawn"]);
    assert.equal(env.SCREEN_UPSTREAM, DEFAULT_SCREEN_UPSTREAM);
    assert.equal(DEFAULT_SCREEN_UPSTREAM, "http://127.0.0.1:6901");
    assert.ok(fire, "supervisor should listen for signals");
    fire!("SIGINT");
    await run;
    assert.deepEqual(children[0]?.killed, ["SIGTERM"]);
    assert.equal(children.length, 1);
  });

  test("keeps an explicit SCREEN_UPSTREAM", async () => {
    const spawned = deferred<NodeJS.ProcessEnv>();
    let fire: ((signal: NodeJS.Signals) => void) | undefined;
    const run = superviseTalk(
      {
        composeUp: async () => {},
        spawnDaemon: (env) => {
          spawned.resolve(env);
          return new FakeChild();
        },
        sleep: async () => {},
        now: () => 0,
        onSignal: (handler) => {
          fire = handler;
          return () => {};
        },
      },
      { SCREEN_UPSTREAM: "http://127.0.0.1:16901" },
    );
    const env = await spawned.promise;
    assert.equal(env.SCREEN_UPSTREAM, "http://127.0.0.1:16901");
    fire!("SIGTERM");
    await run;
  });

  test("does not spawn Talk when Screen compose fails", async () => {
    let spawns = 0;
    await assert.rejects(
      () =>
        superviseTalk(
          {
            composeUp: async () => {
              throw new Error("docker missing");
            },
            spawnDaemon: () => {
              spawns += 1;
              return new FakeChild();
            },
            sleep: async () => {},
            now: () => 0,
            onSignal: () => () => {},
          },
          {},
        ),
      /docker missing/,
    );
    assert.equal(spawns, 0);
  });

  test("respawns Talk after a crash and does not restart Screen", async () => {
    const composeCalls: string[] = [];
    const children: FakeChild[] = [];
    let fire: ((signal: NodeJS.Signals) => void) | undefined;

    const run = superviseTalk(
      {
        composeUp: async (service) => {
          composeCalls.push(service);
        },
        spawnDaemon: () => {
          const child = new FakeChild();
          children.push(child);
          return child;
        },
        sleep: async () => {},
        now: () => 0,
        onSignal: (handler) => {
          fire = handler;
          return () => {};
        },
      },
      {},
    );

    await waitUntil(() => children.length === 1, "first Talk spawn");
    children[0]!.crash(1);
    await waitUntil(() => children.length === 2, "respawn Talk");
    fire!("SIGINT");
    await run;
    assert.deepEqual(composeCalls, [SCREEN_SERVICE]);
    assert.equal(children.length, 2);
  });

  test("throttles a Talk crash loop instead of tight-looping", async () => {
    const sleeps: number[] = [];
    const children: FakeChild[] = [];
    let fire: ((signal: NodeJS.Signals) => void) | undefined;
    const minRestartDelayMs = 1000;
    const maxRestartDelayMs = 8000;

    const run = superviseTalk(
      {
        composeUp: async () => {},
        spawnDaemon: () => {
          const child = new FakeChild();
          children.push(child);
          return child;
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        now: () => 0,
        onSignal: (handler) => {
          fire = handler;
          return () => {};
        },
        minRestartDelayMs,
        maxRestartDelayMs,
        stableAfterMs: 10_000,
      },
      {},
    );

    await waitUntil(() => children.length === 1, "first spawn");
    children[0]!.crash(1);
    await waitUntil(() => sleeps.length >= 1 && children.length === 2, "first backoff");
    children[1]!.crash(1);
    await waitUntil(() => sleeps.length >= 2 && children.length === 3, "second backoff");
    fire!("SIGINT");
    await run;
    assert.equal(sleeps[0], minRestartDelayMs);
    assert.equal(sleeps[1], minRestartDelayMs * 2);
    assert.ok(sleeps[1]! > sleeps[0]!);
    assert.ok((sleeps[1] ?? 0) <= maxRestartDelayMs);
  });

  test("SIGINT during backoff stops Talk and does not spawn again", async () => {
    const children: FakeChild[] = [];
    const sleepGate = deferred<void>();
    let fire: ((signal: NodeJS.Signals) => void) | undefined;
    let sleeping = false;

    const run = superviseTalk(
      {
        composeUp: async () => {},
        spawnDaemon: () => {
          const child = new FakeChild();
          children.push(child);
          return child;
        },
        sleep: async () => {
          sleeping = true;
          await sleepGate.promise;
        },
        now: () => 0,
        onSignal: (handler) => {
          fire = handler;
          return () => {};
        },
        minRestartDelayMs: 1000,
      },
      {},
    );

    await waitUntil(() => children.length === 1, "first spawn");
    children[0]!.crash(1);
    await waitUntil(() => sleeping, "backoff sleep");
    fire!("SIGINT");
    sleepGate.resolve();
    await run;
    assert.equal(children.length, 1);
  });

  test("SIGINT stops Talk and does not take Screen down", async () => {
    const composeDown: string[] = [];
    const spawned = deferred<FakeChild>();
    let fire: ((signal: NodeJS.Signals) => void) | undefined;
    const deps: SuperviseDeps = {
      composeUp: async () => {},
      spawnDaemon: () => {
        const child = new FakeChild();
        spawned.resolve(child);
        return child;
      },
      sleep: async () => {},
      now: () => 0,
      onSignal: (handler) => {
        fire = handler;
        return () => {};
      },
    };
    const run = superviseTalk(deps, {});
    const child = await spawned.promise;
    fire!("SIGINT");
    await run;
    assert.deepEqual(child.killed, ["SIGTERM"]);
    assert.deepEqual(composeDown, []);
    assert.equal("composeDown" in deps, false);
  });
});
