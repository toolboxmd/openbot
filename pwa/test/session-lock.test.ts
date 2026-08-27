import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  APPEARANCE_SETTINGS_HASH,
  appSettingsRequested,
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
    assert.match(appSettingsSource, /import \{ lockSession \} from "@\/lib\/session"/);
    assert.match(appSettingsSource, /aria-labelledby="security-heading"/);
    assert.match(appSettingsSource, /id="lock-openbot-description"/);
    assert.match(appSettingsSource, /aria-describedby="lock-openbot-description"/);
    assert.match(appSettingsSource, /onClick=\{lockOpenBot\}/);
    assert.match(appSettingsSource, /disabled=\{lockPending\}/);
    assert.match(appSettingsSource, />\s*Lock OpenBot\s*</);
    assert.match(
      appSettingsSource,
      /const result = await lockSession\(\);[\s\S]*if \(!result\.ok\)[\s\S]*return;[\s\S]*setAppSettingsOpen\(false\);[\s\S]*window\.location\.reload\(\)/,
    );
  });

  test("deep-links both Appearance and Security through the shared App Settings route", () => {
    assert.equal(appSettingsRequested(APPEARANCE_SETTINGS_HASH), true);
    assert.equal(appSettingsRequested(SECURITY_SETTINGS_HASH), true);
    assert.equal(appSettingsRequested("#settings/about"), false);
    assert.match(appSettingsSource, /appSettingsRequested\(window\.location\.hash\)/);
    assert.match(appSettingsSource, /id=\{SECURITY_SETTINGS_HASH\.slice\(1\)\}/);
    assert.match(appSettingsSource, /const securitySectionRef = useRef<HTMLElement \| null>\(null\)/);
    assert.match(
      appSettingsSource,
      /if \(!open \|\| requestedHash !== SECURITY_SETTINGS_HASH\) return;[\s\S]*requestAnimationFrame[\s\S]*scrollIntoView[\s\S]*focus\(\{ preventScroll: true \}\)/,
    );
    assert.match(appSettingsSource, /ref=\{securitySectionRef\}[\s\S]*tabIndex=\{-1\}/);
    assert.match(messengerSource, /import \{ appSettingsRequested \} from "@\/lib\/app-settings"/);
    assert.match(
      messengerSource,
      /setAppSettingsOpen\(appSettingsRequested\(window\.location\.hash\)\)/,
    );
  });
});
