import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  DEFAULT_UI_PREFERENCES,
  UI_PREFERENCES_KEY,
  parseUiPreferences,
  readUiPreferences,
  resolveEffectiveTheme,
  setComputerPanePreference,
  setThemePreference,
  writeUiPreferences,
} from "../src/lib/ui-preferences.ts";

describe("PWA UI preferences", () => {
  test("defaults safely when browser state is absent, malformed, or invalid", () => {
    assert.deepEqual(parseUiPreferences(null), DEFAULT_UI_PREFERENCES);
    assert.deepEqual(parseUiPreferences("not json"), DEFAULT_UI_PREFERENCES);
    assert.deepEqual(
      parseUiPreferences(JSON.stringify({ theme: "sepia", computerPaneByBot: { ada: true, ben: "yes" } })),
      { theme: "system", computerPaneByBot: { ada: true } },
    );
  });

  test("resolves explicit and system appearance choices", () => {
    assert.equal(resolveEffectiveTheme("light", true), "light");
    assert.equal(resolveEffectiveTheme("dark", false), "dark");
    assert.equal(resolveEffectiveTheme("system", false), "light");
    assert.equal(resolveEffectiveTheme("system", true), "dark");
  });

  test("updates theme without losing the compact per-Bot pane map", () => {
    const withPane = setComputerPanePreference(DEFAULT_UI_PREFERENCES, "ada", true);
    assert.deepEqual(setThemePreference(withPane, "dark"), {
      theme: "dark",
      computerPaneByBot: { ada: true },
    });
  });

  test("reads and writes one browser-local owner and fails closed when storage throws", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
    };
    const preferences = { theme: "dark" as const, computerPaneByBot: { ada: true } };
    assert.equal(writeUiPreferences(storage, preferences), true);
    assert.equal(values.has(UI_PREFERENCES_KEY), true);
    assert.deepEqual(readUiPreferences(storage), preferences);

    const throwing = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };
    assert.deepEqual(readUiPreferences(throwing), DEFAULT_UI_PREFERENCES);
    assert.equal(writeUiPreferences(throwing, preferences), false);
  });

  test("pre-paint bootstrap stays aligned with the browser-local preference contract", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    assert.match(html, new RegExp(UI_PREFERENCES_KEY.replaceAll(".", "\\.")));
    assert.match(html, /\["light", "dark", "system"\]/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, /#0F0F10/);
    assert.match(html, /#FFFFFF/);
  });
});
