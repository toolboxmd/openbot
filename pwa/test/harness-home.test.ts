import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { join } from "node:path";
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

  test("Messenger source has Isolated vs Host, All Bots / This Bot editors, Host grant card", () => {
    const root = join(import.meta.dirname, "..", "src");
    const messenger = readFileSync(join(root, "components", "Messenger.tsx"), "utf8");
    const grant = readFileSync(join(root, "components", "HostGrantCard.tsx"), "utf8");
    const editors = readFileSync(join(root, "components", "AgentsEditors.tsx"), "utf8");
    assert.match(messenger, /data-testid="config-mode"/);
    assert.match(messenger, /Isolated/);
    assert.match(messenger, /Host/);
    assert.match(messenger, /HostGrantCard/);
    assert.match(messenger, /AgentsEditors/);
    assert.match(editors, /All Bots/);
    assert.match(editors, /This Bot/);
    assert.match(editors, /data-testid="all-bots-editor-toggle"/);
    assert.match(editors, /data-testid="this-bot-editor-toggle"/);
    assert.match(grant, /data-testid="host-grant-card"/);
    const labels = readFileSync(join(root, "lib", "harness-home.ts"), "utf8");
    assert.match(labels, /Read and write/);
    assert.match(labels, /Deny/);
    assert.match(labels, /This Session/);
  });
});
