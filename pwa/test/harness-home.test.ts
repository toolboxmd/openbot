import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CONFIG_MODES,
  HOST_GRANT_ACCESS,
  HOST_GRANT_DURATIONS,
  configModeLabel,
  isHostGrantPermission,
} from "../src/lib/harness-home.ts";

describe("PWA Isolated Harness Home", () => {
  test("Isolated vs Host labels and Host grant card options", () => {
    assert.deepEqual([...CONFIG_MODES], ["isolated", "host"]);
    assert.equal(configModeLabel("isolated"), "Isolated");
    assert.equal(configModeLabel("host"), "Host");
    assert.deepEqual(
      HOST_GRANT_ACCESS.map((item) => item.label),
      ["Read", "Read and write", "Deny"],
    );
    assert.deepEqual(
      HOST_GRANT_DURATIONS.map((item) => item.label),
      ["Once", "This Session", "Until revoked"],
    );
    assert.equal(isHostGrantPermission({ hostGrant: { path: "/tmp/x" } }), true);
    assert.equal(isHostGrantPermission({ hostGrant: undefined }), false);
  });
});
