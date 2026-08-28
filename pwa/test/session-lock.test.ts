import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  ALL_BOTS_INSTRUCTIONS_SETTINGS_HASH,
  APPEARANCE_SETTINGS_HASH,
  appSettingsFocusTarget,
  appSettingsRequested,
  NEW_BOTS_SETTINGS_HASH,
  SECURITY_SETTINGS_HASH,
} from "../src/lib/app-settings.ts";
import { lockSession } from "../src/lib/session.ts";

const appSettingsSource = readFileSync(
  new URL("../src/components/AppSettings.tsx", import.meta.url),
  "utf8",
);
const messengerSource = readFileSync(
  new URL("../src/components/Messenger.tsx", import.meta.url),
  "utf8",
);

describe("PWA Password Lock", () => {
  test("calls the backend Lock contract with same-origin credentials", async () => {
    const originalFetch = globalThis.fetch;
    let request: { input: string | URL | Request; init?: RequestInit } | null = null;
    globalThis.fetch = async (input, init) => {
      request = { input, init };
      return new Response(null, { status: 204 });
    };
    try {
      assert.deepEqual(await lockSession(), { ok: true });
      assert.equal(request?.input, "/api/session");
      assert.equal(request?.init?.method, "DELETE");
      assert.equal(request?.init?.credentials, "same-origin");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reports a backend failure without claiming the browser is locked", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 503 });
    try {
      assert.deepEqual(await lockSession(), {
        ok: false,
        error: "OpenBot could not lock. Try again.",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("exposes an accessible App Settings action that reloads only after Lock succeeds", () => {
    assert.match(appSettingsSource, /\blockSession\b/);
    assert.match(appSettingsSource, /aria-labelledby="security-heading"/);
    assert.match(appSettingsSource, /id="lock-openbot-description"/);
    assert.match(appSettingsSource, /aria-describedby="lock-openbot-description"/);
    assert.match(appSettingsSource, /onClick=\{onLock\}/);
    assert.match(appSettingsSource, /onLock=\{\(\) => void lockOpenBot\(\)\}/);
    assert.match(appSettingsSource, /disabled=\{lockPending\}/);
    assert.match(appSettingsSource, />\s*Lock OpenBot\s*</);
    assert.match(
      appSettingsSource,
      /const result = await lockSession\(\);[\s\S]*if \(!result\.ok\)[\s\S]*return;[\s\S]*setAppSettingsOpen\(false\);[\s\S]*window\.location\.reload\(\)/,
    );
  });

  test("deep-links every implemented App Settings section through the shared route", () => {
    assert.equal(appSettingsRequested(APPEARANCE_SETTINGS_HASH), true);
    assert.equal(appSettingsRequested(NEW_BOTS_SETTINGS_HASH), true);
    assert.equal(appSettingsRequested(ALL_BOTS_INSTRUCTIONS_SETTINGS_HASH), true);
    assert.equal(appSettingsRequested(SECURITY_SETTINGS_HASH), true);
    assert.equal(appSettingsRequested("#settings/about"), false);
    assert.equal(appSettingsFocusTarget(APPEARANCE_SETTINGS_HASH), null);
    assert.equal(appSettingsFocusTarget(NEW_BOTS_SETTINGS_HASH), "new-bots");
    assert.equal(appSettingsFocusTarget(ALL_BOTS_INSTRUCTIONS_SETTINGS_HASH), "all-bots-instructions");
    assert.equal(appSettingsFocusTarget(SECURITY_SETTINGS_HASH), "security");
    assert.match(appSettingsSource, /appSettingsRequested\(window\.location\.hash\)/);
    assert.match(appSettingsSource, /id=\{NEW_BOTS_SETTINGS_HASH\.slice\(1\)\}/);
    assert.match(appSettingsSource, /id=\{ALL_BOTS_INSTRUCTIONS_SETTINGS_HASH\.slice\(1\)\}/);
    assert.match(appSettingsSource, /id=\{SECURITY_SETTINGS_HASH\.slice\(1\)\}/);
    assert.match(
      appSettingsSource,
      /appSettingsFocusTarget\(requestedHash\)[\s\S]*requestAnimationFrame[\s\S]*scrollIntoView[\s\S]*focus\(\{ preventScroll: true \}\)/,
    );
    assert.match(appSettingsSource, /ref=\{newBotsSectionRef\}[\s\S]*tabIndex=\{-1\}/);
    assert.match(appSettingsSource, /ref=\{allBotsInstructionsSectionRef\}[\s\S]*tabIndex=\{-1\}/);
    assert.match(appSettingsSource, /ref=\{securitySectionRef\}[\s\S]*tabIndex=\{-1\}/);
    assert.match(messengerSource, /import \{ appSettingsRequested \} from "@\/lib\/app-settings"/);
    assert.match(
      messengerSource,
      /setAppSettingsOpen\(appSettingsRequested\(window\.location\.hash\)\)/,
    );
  });
});
