import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const source = readFileSync(new URL("../src/components/Messenger.tsx", import.meta.url), "utf8");

describe("reaction menu composition", () => {
  test("mounts the controlled picker exactly once inside its menu root", () => {
    const start = source.indexOf("function HoverActions");
    const end = source.indexOf("export function Messenger", start);
    const hoverActions = source.slice(start, end);

    assert.equal(hoverActions.match(/\{picker\}/g)?.length, 1);
    assert.match(hoverActions, /<DropdownMenu[\s\S]*\{picker\}[\s\S]*<\/DropdownMenu>/);
  });

  test("gives a checked reaction a visible non-color indicator", () => {
    assert.match(source, /<DropdownMenuItemIndicator>[\s\S]*<Check[\s\S]*<\/DropdownMenuItemIndicator>/);
  });

  test("moves focus off New messages before removing the button", () => {
    const start = source.indexOf("function scrollToLatest");
    const end = source.indexOf("function storeDraft", start);
    const scrollToLatest = source.slice(start, end);
    const focusAt = scrollToLatest.indexOf(".focus(");
    const hideAt = scrollToLatest.indexOf("setNewMessagesAvailable(false)");

    assert.ok(focusAt >= 0, "New messages activation must focus the latest bubble");
    assert.ok(hideAt > focusAt, "focus must move before the button unmounts");
  });
});
