import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createComputerZoomSynchronizer } from "../src/lib/computer-zoom.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("Computer zoom lifecycle", () => {
  test("revokes the previous Bot's write access when its expanded pane unmounts", async () => {
    const startComputerZoomSync = createComputerZoomSynchronizer();
    const calls: Array<{ botId: string | null; zoom: boolean }> = [];
    const setZoom = async (botId: string | null, zoom: boolean) => {
      calls.push({ botId, zoom });
    };

    const stopAda = startComputerZoomSync("ada", true, setZoom);
    await flush();
    stopAda();
    const stopBen = startComputerZoomSync("ben", false, setZoom);
    await flush();
    stopBen();

    assert.deepEqual(calls.filter(({ botId }) => botId === "ada"), [
      { botId: "ada", zoom: true },
      { botId: "ada", zoom: false },
    ]);
    assert.deepEqual(calls.filter(({ botId }) => botId === "ben"), [
      { botId: "ben", zoom: false },
    ]);
  });

  test("serializes a delayed close before reopening the same Bot", async () => {
    const startComputerZoomSync = createComputerZoomSynchronizer();
    const calls: boolean[] = [];
    const pending: Array<() => void> = [];
    const setZoom = async (_botId: string | null, zoom: boolean) => {
      calls.push(zoom);
      await new Promise<void>((resolve) => pending.push(resolve));
    };

    const stopFirstOpen = startComputerZoomSync("ada", true, setZoom);
    await flush();
    stopFirstOpen();
    const stopReopened = startComputerZoomSync("ada", true, setZoom);
    await flush();
    assert.deepEqual(calls, [true]);

    pending.shift()?.();
    await flush();
    assert.deepEqual(calls, [true, false]);

    pending.shift()?.();
    await flush();
    assert.deepEqual(calls, [true, false, true]);

    pending.shift()?.();
    await flush();
    stopReopened();
    await flush();
    assert.deepEqual(calls, [true, false, true, false]);
    pending.shift()?.();
  });
});
