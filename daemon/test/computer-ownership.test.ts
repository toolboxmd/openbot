import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  KasmWriteOwnership,
  type KasmWriteAuthority,
} from "../src/kasm.ts";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function eventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("Computer write ownership", () => {
  test("serializes a Bot switch and publishes each owner only after Kasm confirms it", async () => {
    const calls: Array<{ target: string; write: boolean }> = [];
    const authorities = new Map<string, KasmWriteAuthority>();
    let pending: ReturnType<typeof deferred<void>> | null = null;
    const ownership = new KasmWriteOwnership({
      update: async (target, write) => {
        calls.push({ target, write });
        if (pending) {
          const gate = pending;
          pending = null;
          await gate.promise;
        }
      },
      publish: (target, state) => authorities.set(target, state.authority),
    });

    await ownership.reconcile(["Ada", "Ben"]);
    calls.length = 0;
    const epoch = ownership.epoch();

    const adaGate = deferred<void>();
    pending = adaGate;
    const zoomAda = ownership.transition("Ada", true, epoch);
    await eventLoopTurn();
    assert.deepEqual(calls, [{ target: "Ada", write: true }]);
    assert.equal(authorities.get("Ada"), "view-only");

    const zoomBen = ownership.transition("Ben", true, epoch);
    const disableAdaGate = deferred<void>();
    pending = disableAdaGate;
    await eventLoopTurn();
    assert.deepEqual(calls, [{ target: "Ada", write: true }]);

    adaGate.resolve();
    await zoomAda;
    assert.equal(authorities.get("Ada"), "write");
    await eventLoopTurn();
    assert.deepEqual(calls, [
      { target: "Ada", write: true },
      { target: "Ada", write: false },
    ]);
    assert.equal(authorities.get("Ada"), "write");
    assert.equal(authorities.get("Ben"), "view-only");
    disableAdaGate.resolve();
    await zoomBen;

    assert.deepEqual(calls, [
      { target: "Ada", write: true },
      { target: "Ada", write: false },
      { target: "Ben", write: true },
    ]);
    assert.equal(authorities.get("Ada"), "view-only");
    assert.equal(authorities.get("Ben"), "write");
  });

  test("deduplicates concurrent grants and lets a stale release fail closed after a switch", async () => {
    const calls: Array<{ target: string; write: boolean }> = [];
    const authorities = new Map<string, KasmWriteAuthority>();
    const ownership = new KasmWriteOwnership({
      update: async (target, write) => {
        calls.push({ target, write });
      },
      publish: (target, state) => authorities.set(target, state.authority),
    });
    await ownership.reconcile(["Ada", "Ben"]);
    calls.length = 0;
    const epoch = ownership.epoch();

    await Promise.all([
      ownership.transition("Ada", true, epoch),
      ownership.transition("Ada", true, epoch),
    ]);
    await ownership.transition("Ben", true, epoch);
    await ownership.transition("Ada", false);

    assert.deepEqual(calls, [
      { target: "Ada", write: true },
      { target: "Ada", write: false },
      { target: "Ben", write: true },
      { target: "Ben", write: false },
      { target: "Ada", write: false },
    ]);
    assert.equal(authorities.get("Ada"), "view-only");
    assert.equal(authorities.get("Ben"), "view-only");
  });

  test("rejects pre-barrier grants before and after a delayed enable settles", async () => {
    const calls: Array<{ target: string; write: boolean }> = [];
    const remote = new Map<string, boolean>();
    const enableStarted = deferred<void>();
    const allowEnable = deferred<void>();
    const ownership = new KasmWriteOwnership({
      update: async (target, write) => {
        calls.push({ target, write });
        remote.set(target, write);
        if (write) {
          enableStarted.resolve();
          await allowEnable.promise;
        }
      },
    });
    await ownership.reconcile(["Ada"]);
    calls.length = 0;
    const oldEpoch = ownership.epoch();

    const activeGrant = ownership.transition("Ada", true, oldEpoch);
    const activeRejected = assert.rejects(
      activeGrant,
      /Computer changed\. Refresh and retry Computer\./,
    );
    await enableStarted.promise;
    const release = ownership.transition("Ada", false);
    await assert.rejects(
      ownership.transition("Ada", true, oldEpoch),
      /Computer changed\. Refresh and retry Computer\./,
    );
    allowEnable.resolve();
    await activeRejected;
    await release;

    assert.deepEqual(calls, [
      { target: "Ada", write: true },
      { target: "Ada", write: false },
      { target: "Ada", write: false },
    ]);
    assert.equal(remote.get("Ada"), false);
    assert.equal(ownership.state("Ada").authority, "view-only");
  });

  test("does not issue a stale enable after a release interrupts the prior-owner disable", async () => {
    const calls: Array<{ target: string; write: boolean }> = [];
    const disableStarted = deferred<void>();
    const allowDisable = deferred<void>();
    let holdAdaDisable = false;
    const ownership = new KasmWriteOwnership({
      update: async (target, write) => {
        calls.push({ target, write });
        if (target === "Ada" && !write && holdAdaDisable) {
          holdAdaDisable = false;
          disableStarted.resolve();
          await allowDisable.promise;
        }
      },
    });
    await ownership.reconcile(["Ada", "Ben"]);
    const epoch = ownership.epoch();
    await ownership.transition("Ada", true, epoch);
    calls.length = 0;

    holdAdaDisable = true;
    const staleSwitch = ownership.transition("Ben", true, epoch);
    const staleRejected = assert.rejects(
      staleSwitch,
      /Computer changed\. Refresh and retry Computer\./,
    );
    await disableStarted.promise;
    const release = ownership.transition("Ada", false);
    allowDisable.resolve();
    await staleRejected;
    await release;

    assert.equal(
      calls.some((call) => call.target === "Ben" && call.write),
      false,
      "stale switch issued a post-barrier write grant",
    );
    assert.equal(ownership.state("Ada").authority, "view-only");
    assert.equal(ownership.state("Ben").authority, "view-only");
  });

  test("keeps reconstructed clients usable with one constant-size epoch barrier", async () => {
    const calls: Array<{ target: string; write: boolean }> = [];
    const remote = new Map<string, boolean>();
    const ownership = new KasmWriteOwnership({
      update: async (target, write) => {
        calls.push({ target, write });
        remote.set(target, write);
      },
    });
    await ownership.reconcile(["Ada"]);
    calls.length = 0;

    for (let client = 0; client < 512; client += 1) {
      const epoch = ownership.epoch();
      await ownership.transition("Ada", true, epoch);
      await ownership.transition("Ada", false);
    }

    assert.equal(calls.length, 1024);
    assert.equal(remote.get("Ada"), false);
    assert.equal(ownership.state("Ada").authority, "view-only");
  });

  test("rejects an intent-less grant but accepts an intent-less release", async () => {
    const calls: Array<{ target: string; write: boolean }> = [];
    const ownership = new KasmWriteOwnership({
      update: async (target, write) => {
        calls.push({ target, write });
      },
    });
    await ownership.reconcile(["Ada"]);
    calls.length = 0;

    await assert.rejects(
      ownership.transition("Ada", true),
      /Computer changed\. Refresh and retry Computer\./,
    );
    await ownership.transition("Ada", false);

    assert.deepEqual(calls, [{ target: "Ada", write: false }]);
  });

  test("compensates an ambiguous enable and permits an explicit retry", async () => {
    const calls: Array<{ target: string; write: boolean }> = [];
    const remote = new Map<string, boolean>();
    const authorities = new Map<string, KasmWriteAuthority>();
    let loseEnableReply = false;
    const ownership = new KasmWriteOwnership({
      update: async (target, write) => {
        calls.push({ target, write });
        remote.set(target, write);
        if (write && loseEnableReply) {
          loseEnableReply = false;
          throw new Error("enable reply lost");
        }
      },
      publish: (target, state) => authorities.set(target, state.authority),
    });
    await ownership.reconcile(["Ada"]);
    calls.length = 0;
    loseEnableReply = true;

    await assert.rejects(
      ownership.transition("Ada", true, ownership.epoch()),
      /enable reply lost/,
    );
    assert.deepEqual(calls, [
      { target: "Ada", write: true },
      { target: "Ada", write: false },
    ]);
    assert.equal(remote.get("Ada"), false);
    assert.equal(authorities.get("Ada"), "view-only");

    await ownership.transition("Ada", true, ownership.epoch());
    assert.equal(remote.get("Ada"), true);
    assert.equal(authorities.get("Ada"), "write");
  });

  test("blocks a new grant after disable failure until retry reconciles the old owner", async () => {
    const calls: Array<{ target: string; write: boolean }> = [];
    const remote = new Map<string, boolean>();
    const authorities = new Map<string, KasmWriteAuthority>();
    let failAdaDisable = false;
    const ownership = new KasmWriteOwnership({
      update: async (target, write) => {
        calls.push({ target, write });
        if (target === "Ada" && !write && failAdaDisable) {
          failAdaDisable = false;
          throw new Error("disable reply lost");
        }
        remote.set(target, write);
      },
      publish: (target, state) => authorities.set(target, state.authority),
    });
    await ownership.reconcile(["Ada", "Ben"]);
    await ownership.transition("Ada", true, ownership.epoch());
    calls.length = 0;
    failAdaDisable = true;

    await assert.rejects(
      ownership.transition("Ben", true, ownership.epoch()),
      /disable reply lost/,
    );
    assert.deepEqual(calls, [{ target: "Ada", write: false }]);
    assert.equal(remote.get("Ada"), true);
    assert.equal(remote.get("Ben"), false);
    assert.equal(authorities.get("Ada"), "unknown");
    assert.equal(authorities.get("Ben"), "view-only");

    await ownership.transition("Ben", true, ownership.epoch());
    assert.deepEqual(calls, [
      { target: "Ada", write: false },
      { target: "Ada", write: false },
      { target: "Ben", write: true },
    ]);
    assert.equal(remote.get("Ada"), false);
    assert.equal(remote.get("Ben"), true);
    assert.equal(authorities.get("Ada"), "view-only");
    assert.equal(authorities.get("Ben"), "write");
  });

  test("restart reconciliation revokes every remote writer before publishing view-only", async () => {
    const calls: Array<{ target: string; write: boolean }> = [];
    const remote = new Map<string, boolean>([
      ["Ada", true],
      ["Ben", true],
    ]);
    const authorities = new Map<string, KasmWriteAuthority>();
    const ownership = new KasmWriteOwnership({
      update: async (target, write) => {
        calls.push({ target, write });
        remote.set(target, write);
      },
      publish: (target, state) => authorities.set(target, state.authority),
    });

    await ownership.reconcile(["Ada", "Ben"]);

    assert.deepEqual(calls, [
      { target: "Ada", write: false },
      { target: "Ben", write: false },
    ]);
    assert.equal(remote.get("Ada"), false);
    assert.equal(remote.get("Ben"), false);
    assert.equal(authorities.get("Ada"), "view-only");
    assert.equal(authorities.get("Ben"), "view-only");
  });
});
